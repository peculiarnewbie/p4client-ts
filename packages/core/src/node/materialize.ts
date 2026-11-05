import { Data, Duration, Effect, Predicate, Schedule, Schema, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { runPlainCommand, streamCommand } from '../engine/command.js';
import { P4Config } from '../engine/config.js';
import { operation, progressCounter } from '../engine/operation.js';
import { P4MaterializationError } from '../errors.js';
import { P4LocalPathSchema } from '../schemas.js';
import { requirePositive } from '../commands/shared.js';
import { isWireString } from '../wire/value.js';
import type { FileHandle } from 'node:fs/promises';
import type { P4Operation, P4Sink, P4Context } from '../engine/operation.js';
import type { P4Error } from '../errors.js';
import type { P4KeywordMode } from '../commands/print.js';
import type { P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { P4WireFields, P4WireValue } from '../wire/value.js';

/** An exact depot revision to write to disk. */
export interface P4MaterializeSpec {
  /** Depot path, without a revision. */
  readonly depotFile: string;
  /** Exact revision number. */
  readonly revision: number;
  /**
   * Where to write it: absolute, or relative to `directory`, and inside it.
   * Defaults to `<directory>/<depot>/<path…>`.
   */
  readonly outputPath?: string | undefined;
  /**
   * The revision's file type, when known. Only binary types are batched, so a
   * known text type goes straight to a per-file print.
   */
  readonly type?: string | undefined;
}

/** How {@link materializeDepotFiles} batches binary revisions. */
export interface P4MaterializeBatchOptions {
  /** Most revisions per `p4 -G -x - print`. Defaults to 100. */
  readonly files?: number | undefined;
  /** Batched print processes at a time. Defaults to 4. */
  readonly processes?: number | undefined;
  /**
   * Below this many batchable revisions, print each on its own instead.
   * Defaults to 1. A few large files can download faster as per-file streams.
   */
  readonly minFiles?: number | undefined;
}

/** Options for {@link materializeDepotFiles}. */
export interface MaterializeDepotFilesOptions<F extends P4MaterializeSpec = P4MaterializeSpec> {
  /** Exact revisions, for example from a history or `files` listing. */
  readonly fileSpec: readonly F[];
  /** Existing directory that receives the files, relative to the client's `cwd`. */
  readonly directory: string;
  /** Refuse to write more files than this. */
  readonly maxFiles: number;
  /** Per-file `p4 print` processes run at once. Defaults to 4. */
  readonly concurrency?: number | undefined;
  /** Keyword expansion for per-file prints. Defaults to `raw`. */
  readonly keywords?: P4KeywordMode | undefined;
  /**
   * Stream binary revisions from batched `p4 -G -x - print` processes and
   * write them from this process; every other revision, and any a batch did
   * not deliver intact, is printed per file. `true` uses the defaults.
   * Defaults to `false`: one `p4 print -o` per revision.
   */
  readonly batch?: boolean | P4MaterializeBatchOptions | undefined;
  /**
   * Attempts per per-file print, for a connection that drops under load.
   * Defaults to 1. A missing revision or a permission failure is not retried.
   */
  readonly attempts?: number | undefined;
  /** Delay before the first retry, tripled for each later one. Defaults to 1,000 ms. */
  readonly retryDelayMs?: number | undefined;
  /** Make every written file writable; `p4 print` leaves most file types read-only. Defaults to `false`. */
  readonly writable?: boolean | undefined;
}

/** One revision written to disk. */
export interface P4MaterializedFile<F extends P4MaterializeSpec = P4MaterializeSpec> {
  /** The requested revision, as given. */
  readonly file: F;
  /** Where it was written, beneath the directory. */
  readonly localPath: P4LocalPath;
  /** Bytes written. */
  readonly bytes: number;
  /** `batch` when streamed from a batched print, `print` for a per-file print. */
  readonly method: 'batch' | 'print';
}

/** Counts of a materialization. */
export interface P4MaterializeStats {
  /** Files written. */
  readonly files: number;
  readonly bytes: number;
  /** Files written from batched prints. */
  readonly batched: number;
  /** Files written by per-file prints. */
  readonly printed: number;
  /** Batched print processes run. */
  readonly batches: number;
  /** Per-file print attempts that failed and were retried. */
  readonly retries: number;
}

/** Every revision written by {@link materializeDepotFiles}. */
export interface P4MaterializeResult<F extends P4MaterializeSpec = P4MaterializeSpec> {
  /** The resolved destination directory. */
  readonly directory: P4LocalPath;
  /** Written files, in the order requested. */
  readonly items: P4MaterializedFile<F>[];
  readonly messages: P4Message[];
  readonly stats: P4MaterializeStats;
}

/** Materialization operation preserving caller metadata in native programs. */
export interface P4MaterializeOperation extends Omit<P4Operation<MaterializeDepotFilesOptions, P4MaterializedFile, P4MaterializeResult>, 'name' | 'program'> {
  readonly name: 'materializeDepotFiles';
  readonly program: <F extends P4MaterializeSpec>(
    options: MaterializeDepotFilesOptions<F>, sink: P4Sink<P4MaterializedFile<F>>,
  ) => Effect.Effect<P4MaterializeResult<F>, P4Error, P4Context>;
}

/** Any problem with a revision fails a per-file print, as it did before. */
const POLICY: P4MessagePolicy = {
  no_such_file: 'fail',
  not_on_client: 'fail',
  unknown_revision: 'fail',
  not_in_view: 'fail',
  empty: 'fail',
};

/** A batch reports problems without failing; whatever it did not write is printed per file. */
const BATCH_POLICY: P4MessagePolicy = {
  no_such_file: 'item',
  not_on_client: 'item',
  unknown_revision: 'item',
  invalid_revision: 'item',
  not_in_view: 'item',
  empty: 'item',
  fault: 'item',
  client_fault: 'item',
  filesystem: 'item',
};

/** Types whose `-G` bytes are the file exactly: binary, with any modifiers. */
const BATCHABLE_TYPE = /^u?binary(?:\+[A-Za-z0-9]+)?$/;

/** Actions with no content; left to the per-file print, which reports them. */
const NO_CONTENT_ACTION = /delete|purge|archive/;

const toLocalPath = Schema.decodeUnknownSync(P4LocalPathSchema);

function inside(directory: string, outputPath: string, error: () => P4MaterializationError): string {
  const below = relative(directory, outputPath);

  if (below.length === 0 || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) throw error();

  return outputPath;
}

/**
 * Where a depot file is written beneath a directory: `<directory>/<depot>/<path…>`.
 *
 * @param directory Absolute destination directory.
 * @param depotFile Depot path without a revision.
 * @returns The absolute output path.
 * @throws {P4MaterializationError} With reason `invalid_depot_path` for a path
 * that is not depot syntax, has empty, `.` or `..` segments, or escapes the directory.
 */
export function materializedFilePath(directory: string, depotFile: string): string {
  const invalidPath = (message: string) =>
    new P4MaterializationError({ message, reason: 'invalid_depot_path', path: depotFile });

  if (!depotFile.startsWith('//') || /[#@]/.test(depotFile)) throw invalidPath(`Invalid depot path: ${depotFile}`);
  const segments = depotFile.slice(2).split('/');

  if (segments.length < 2 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw invalidPath(`Invalid depot path: ${depotFile}`);
  }

  return inside(directory, resolve(directory, ...segments), () =>
    invalidPath(`Depot path escapes the materialization directory: ${depotFile}`));
}

/** Where one requested revision goes; its depot path is validated either way, since it is printed. */
function outputPathOf(directory: string, file: P4MaterializeSpec): string {
  const depotLayout = materializedFilePath(directory, file.depotFile);

  if (file.outputPath === undefined) return depotLayout;

  return inside(directory, resolve(directory, file.outputPath), () => new P4MaterializationError({
    message: `Output path is outside the materialization directory: ${file.outputPath}`,
    reason: 'invalid_destination',
    path: file.outputPath ?? null,
  }));
}

/** One revision to print, and every requested output it is written to. */
interface Group {
  readonly key: string;
  readonly type: string | undefined;
  readonly targets: Array<{ readonly index: number; readonly file: P4MaterializeSpec; readonly outputPath: string }>;
}

function planGroups(directory: string, files: readonly P4MaterializeSpec[]): Effect.Effect<Group[], P4MaterializationError> {
  return Effect.suspend(() => {
    const seen = new Set<string>();
    const groups = new Map<string, Group>();

    for (const [index, file] of files.entries()) {
      let outputPath: string;

      try {
        outputPath = outputPathOf(directory, file);
      } catch (error) {
        if (error instanceof P4MaterializationError) return Effect.fail(error);
        throw error;
      }

      const target = process.platform === 'win32' ? outputPath.toLowerCase() : outputPath;

      if (seen.has(target)) {
        return Effect.fail(new P4MaterializationError({
          message: `Multiple revisions resolve to the same output path: ${file.depotFile}`,
          reason: 'invalid_depot_path',
          path: file.depotFile,
        }));
      }

      seen.add(target);
      const key = `${file.depotFile}#${file.revision}`;
      const group = groups.get(key) ?? { key, type: file.type, targets: [] };
      group.targets.push({ index, file, outputPath });
      groups.set(key, group);
    }

    return Effect.succeed([...groups.values()]);
  });
}

function destinationError(path: string): P4MaterializationError {
  return new P4MaterializationError({
    message: `Materialization directory is unavailable: ${path}`,
    reason: 'invalid_destination',
    path,
  });
}

function fsTry<A>(path: string, run: () => Promise<A>): Effect.Effect<A, P4MaterializationError> {
  return Effect.tryPromise({ try: run, catch: () => destinationError(path) });
}

/** `p4 print` leaves read-only files, which Windows will not replace; a missing file is fine. */
const makeWritable = (path: string) => Effect.promise(() => chmod(path, 0o666).catch(() => undefined));

/**
 * Move a verified staging file to the group's first output and copy it to the rest.
 * Untraced: it runs once per file, inside the materializeDepotFiles span.
 */
const place = Effect.fnUntraced(function* (group: Group, staged: string, writable: boolean) {
  const [first, ...copies] = group.targets;

  if (first === undefined) return;
  yield* makeWritable(first.outputPath);
  yield* fsTry(first.outputPath, () => rename(staged, first.outputPath));

  if (writable) yield* makeWritable(first.outputPath);

  for (const copy of copies) {
    yield* fsTry(dirname(copy.outputPath), () => mkdir(dirname(copy.outputPath), { recursive: true }));
    yield* makeWritable(copy.outputPath);
    yield* fsTry(copy.outputPath, () => copyFile(first.outputPath, copy.outputPath));

    if (writable) yield* makeWritable(copy.outputPath);
  }
});

/** A group written to every one of its outputs. */
interface Written {
  readonly group: Group;
  readonly bytes: number;
  readonly method: 'batch' | 'print';
}

type BatchStat = { readonly _tag: 'stat'; readonly key: string; readonly type: string; readonly action: string; readonly fileSize: number | null };

type BatchRecord = BatchStat | { readonly _tag: 'chunk'; readonly data: Uint8Array };

const BatchRecord = Data.taggedEnum<BatchRecord>();

/** A string field of a batch `stat` record, or `''`. */
const statText = (value: P4WireValue | undefined): string => (isWireString(value) ? value : '');

function toBatchRecord(row: P4WireFields): BatchRecord | null {
  if (row.code === 'stat') {
    const fileSize = statText(row.fileSize);

    return BatchRecord.stat({
      key: `${statText(row.depotFile)}#${statText(row.rev)}`,
      type: statText(row.type),
      action: statText(row.action),
      fileSize: /^\d+$/.test(fileSize) ? Number(fileSize) : null,
    });
  }

  if ((row.code === 'binary' || row.code === 'text') && row.data instanceof Uint8Array) {
    return BatchRecord.chunk({ data: row.data });
  }

  return null;
}

/** Failures after which a batch's unwritten revisions are printed per file, rather than failing the call. */
function isCommandFailure(error: P4Error): boolean {
  return Predicate.isTagged(error, 'P4CommandError') || Predicate.isTagged(error, 'P4ParseError')
    || Predicate.isTagged(error, 'P4TimeoutError') || Predicate.isTagged(error, 'P4SpawnError');
}

/**
 * One `p4 -G -x - print -k` over a batch, writing each binary revision from
 * the marshalled stream to a staging file beside its output.
 *
 * A file is accepted only when its records ended cleanly (the next file's
 * `stat`, or a successful exit) and its byte count equals the stat record's
 * `fileSize`. A message mid-file, a non-binary type, a broken stream or a
 * failed command leaves the revision unwritten, for the per-file print.
 */
function printBatch(
  groups: readonly Group[],
  writable: boolean,
  accept: (written: Written) => Effect.Effect<void>,
): Effect.Effect<void, P4Error, P4Context> {
  return Effect.suspend(() => {
    const wanted = new Map(groups.map((group) => [group.key, group]));
    const done = new Set<string>();
    const token = randomUUID().slice(0, 8);
    let sequence = 0;
    let bytes = 0;
    let current: { group: Group; handle: FileHandle; staged: string; size: number; expected: number | null } | null = null;

    const discard = Effect.suspend(() => {
      const file = current;
      current = null;

      return file === null ? Effect.void : Effect.promise(async () => {
        await file.handle.close().catch(() => undefined);
        await rm(file.staged, { force: true }).catch(() => undefined);
      });
    });

    const finish = Effect.suspend(() => {
      const file = current;
      current = null;

      if (file === null) return Effect.void;

      return Effect.gen(function* () {
        yield* Effect.promise(() => file.handle.close().catch(() => undefined));

        if (file.expected === null || file.size !== file.expected) {
          yield* Effect.promise(() => rm(file.staged, { force: true }).catch(() => undefined));

          return;
        }

        yield* place(file.group, file.staged, writable);
        done.add(file.group.key);
        bytes += file.size * file.group.targets.length;
        yield* accept({ group: file.group, bytes: file.size, method: 'batch' });
      });
    });

    // Untraced: runs once per batched file, inside the batch's span.
    const start = Effect.fnUntraced(function* (record: BatchStat) {
      const group = wanted.get(record.key);

      if (group === undefined || done.has(record.key)) return;

      if (!BATCHABLE_TYPE.test(record.type) || NO_CONTENT_ACTION.test(record.action)) return;
      const folder = dirname(group.targets[0]!.outputPath);
      yield* fsTry(folder, () => mkdir(folder, { recursive: true }));
      sequence += 1;
      const staged = join(folder, `.p4-materialize-${token}-${sequence}`);
      const handle = yield* fsTry(staged, () => open(staged, 'w'));
      current = { group, handle, staged, size: 0, expected: record.fileSize };
    });

    const write = (data: Uint8Array) => Effect.suspend(() => {
      const file = current;

      if (file === null) return Effect.void;

      return fsTry(file.staged, async () => {
        for (let offset = 0; offset < data.length;) {
          const { bytesWritten } = await file.handle.write(data, offset, data.length - offset);

          if (bytesWritten <= 0) throw new Error('No bytes written.');
          offset += bytesWritten;
        }

        file.size += data.length;
      });
    });

    return streamCommand({
      args: ['print', '-k'],
      globalArgs: ['-x', '-'],
      input: `${groups.map((group) => group.key).join('\n')}\n`,
      format: 'marshal',
      policy: BATCH_POLICY,
      decode: toBatchRecord,
    }).pipe(
      Stream.runForEach((event): Effect.Effect<void, P4MaterializationError> => {
        // A message may concern the file being written, so that file is not trusted.
        if (!Predicate.isTagged(event, 'data')) return discard;

        return Predicate.isTagged(event.value, 'stat') ? Effect.andThen(finish, start(event.value)) : write(event.value.data);
      }),
      Effect.andThen(finish),
      Effect.catchIf(isCommandFailure, () => Effect.annotateCurrentSpan('p4.failed', true)),
      Effect.ensuring(discard),
      Effect.andThen(Effect.suspend(() => Effect.annotateCurrentSpan({ 'p4.written': done.size, 'p4.bytes': bytes }))),
      Effect.withSpan('p4client-ts.materialize.batch', { attributes: { 'p4.files': groups.length } }),
    );
  });
}

/** Failures worth another attempt: the connection or the process, not the request. */
function isTransient(error: P4Error): boolean {
  if (Predicate.isTagged(error, 'P4SpawnError') || Predicate.isTagged(error, 'P4TimeoutError')) return true;

  return Predicate.isTagged(error, 'P4CommandError')
    && (error.category === 'connection' || error.category === 'fault' || error.category === 'unknown');
}

/** One `p4 print -q -o` to a staging file, verified and moved into place. */
function printOne(group: Group, keywordArgs: readonly string[], writable: boolean) {
  return Effect.scoped(Effect.gen(function* () {
    const folder = dirname(group.targets[0]!.outputPath);
    yield* fsTry(folder, () => mkdir(folder, { recursive: true }));

    const temporary = yield* Effect.acquireRelease(
      fsTry(folder, () => mkdtemp(join(folder, '.p4-materialize-'))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );

    const staged = join(temporary, 'content');

    const output = yield* runPlainCommand({
      args: ['print', '-q', ...keywordArgs, '-o', staged, group.key],
      policy: POLICY,
    });

    const missingOutput = () => new P4MaterializationError({
      message: `Print produced no file for ${group.key}.`,
      reason: 'missing_output',
      path: group.key,
    });

    const written = yield* Effect.tryPromise({ try: () => stat(staged), catch: missingOutput });

    if (!written.isFile()) return yield* missingOutput();
    yield* place(group, staged, writable);

    return { size: written.size, messages: output.messages };
  }));
}

/**
 * Write exact depot revisions beneath an existing directory, without holding
 * their content in memory. Nothing is synced and the workspace is untouched.
 *
 * Each revision lands at its `outputPath`, or `<directory>/<depot>/<path…>`.
 * By default every revision is one `p4 print -q -o` (`-k` unless keywords
 * are expanded), `concurrency` at a time. With `batch`, binary revisions are
 * streamed from batched `p4 -G -x - print` processes instead, and only what a
 * batch did not deliver intact is printed per file. A revision requested for
 * several output paths is printed once and copied.
 *
 * A revision that does not exist fails the call with `P4CommandError`; a
 * deleted revision fails with `P4MaterializationError` (`missing_output`).
 * Existing destination files are replaced only after a verified print to a
 * staging file beside them.
 *
 * Progress counts files written against the number requested. The call runs
 * in a `p4client-ts.materializeDepotFiles` span, with one
 * `p4client-ts.materialize.batch` span per batch and one
 * `p4client-ts.materialize.printEach` span for every per-file print together.
 *
 * @returns The destination directory, each file's local path and the counts.
 * @throws {P4MaterializationError} When the file count exceeds `maxFiles`, a
 * depot or output path is invalid or two resolve to one output path, the directory is unusable, or print produces no file.
 * @throws {P4InvalidArgumentError} When `maxFiles`, `concurrency`, `attempts`, a batch size or a revision is not a positive integer.
 */
export const materializeDepotFiles =
  // SAFETY: every item's `file` is one of options.fileSpec, passed through unchanged, so a caller's
  // spec type F comes back on each item and on the result.
  operation<
  MaterializeDepotFilesOptions,
  P4MaterializedFile,
  P4MaterializeResult
>('materializeDepotFiles', (options, sink) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      'p4.files': options.fileSpec.length,
      'p4.batch': options.batch !== undefined && options.batch !== false,
    });

    const maxFiles = yield* requirePositive(options.maxFiles, 'maxFiles');
    const concurrency = yield* requirePositive(options.concurrency ?? 4, 'concurrency');
    const attempts = yield* requirePositive(options.attempts ?? 1, 'attempts');
    const batch = options.batch === undefined || options.batch === false ? null : options.batch === true ? {} : options.batch;
    const batchFiles = batch === null ? 1 : yield* requirePositive(batch.files ?? 100, 'batch.files');
    const batchProcesses = batch === null ? 1 : yield* requirePositive(batch.processes ?? 4, 'batch.processes');
    const batchMinFiles = batch === null ? 1 : yield* requirePositive(batch.minFiles ?? 1, 'batch.minFiles');

    if (options.fileSpec.length > maxFiles) {
      return yield* new P4MaterializationError({
        message: `Refusing to materialize ${options.fileSpec.length} files; maxFiles is ${maxFiles}.`,
        reason: 'limit_exceeded',
        path: null,
      });
    }

    for (const file of options.fileSpec) yield* requirePositive(file.revision, 'revision');
    const config = yield* P4Config;
    const directory = resolve(config.cwd ?? process.cwd(), options.directory);
    const info = yield* Effect.tryPromise({ try: () => stat(directory), catch: () => destinationError(directory) });

    if (!info.isDirectory()) return yield* destinationError(directory);
    const groups = yield* planGroups(directory, options.fileSpec);
    const writable = options.writable ?? false;

    const counter = progressCounter(sink, 'files', options.fileSpec.length);
    const items: Array<P4MaterializedFile | undefined> = Array.from({ length: options.fileSpec.length });
    const messages: P4Message[] = [];
    const stats = { files: 0, bytes: 0, batched: 0, printed: 0, batches: 0, retries: 0 };

    // Untraced: runs once per written file, inside the materializeDepotFiles span.
    const accept = Effect.fnUntraced(function* (written: Written) {
      for (const target of written.group.targets) {
        const item: P4MaterializedFile = {
          file: target.file,
          localPath: toLocalPath(target.outputPath),
          bytes: written.bytes,
          method: written.method,
        };

        items[target.index] = item;
        stats.files += 1;
        stats.bytes += written.bytes;

        if (written.method === 'batch') stats.batched += 1;
        else stats.printed += 1;
        yield* sink.item(item);
        yield* counter.advance(1, written.bytes);
      }
    });

    let perFile = groups;
    const batchable = batch === null ? [] : groups.filter((group) => group.type === undefined || BATCHABLE_TYPE.test(group.type));

    if (batchable.length > 0 && batchable.length >= batchMinFiles) {
      // Spread a small print over every process: one batch streams its files one after another.
      const size = Math.max(1, Math.min(batchFiles, Math.ceil(batchable.length / batchProcesses)));
      const chunks: Group[][] = [];

      for (let start = 0; start < batchable.length; start += size) chunks.push(batchable.slice(start, start + size));
      stats.batches = chunks.length;
      yield* Effect.forEach(chunks, (chunk) => printBatch(chunk, writable, accept), { concurrency: batchProcesses, discard: true });
      perFile = groups.filter((group) => items[group.targets[0]!.index] === undefined);
    }

    const keywordArgs = (options.keywords ?? 'raw') === 'raw' ? ['-k'] : [];
    const retryDelay = Duration.millis(options.retryDelayMs ?? 1_000);
    yield* Effect.forEach(perFile, (group) => Effect.gen(function* () {
      let failures = 0;

      const printed = yield* printOne(group, keywordArgs, writable).pipe(
        Effect.tapError(() => Effect.sync(() => {
          failures += 1;
        })),
        Effect.retry({
          schedule: Schedule.exponential(retryDelay, 3),
          times: attempts - 1,
          while: isTransient,
        }),
      );

      stats.retries += failures;
      messages.push(...printed.messages);

      for (const message of printed.messages) yield* sink.message(message);
      yield* accept({ group, bytes: printed.size, method: 'print' });
    }), { concurrency, discard: true }).pipe(
      Effect.withSpan('p4client-ts.materialize.printEach', {
        attributes: { 'p4.files': perFile.length, 'p4.concurrency': concurrency },
      }),
    );

    yield* Effect.annotateCurrentSpan({
      'p4.written': stats.files,
      'p4.bytes': stats.bytes,
      'p4.batched': stats.batched,
      'p4.printed': stats.printed,
      'p4.batches': stats.batches,
      'p4.retries': stats.retries,
    });

    return {
      directory: toLocalPath(directory),
      items: items.filter((item): item is P4MaterializedFile => item !== undefined),
      messages,
      stats: { ...stats },
    };
  }), 'files') as P4MaterializeOperation;
