import { Effect, Schema } from 'effect';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { runPlainCommand } from '../engine/command.js';
import { P4Config } from '../engine/config.js';
import { operation, progressCounter } from '../engine/operation.js';
import { P4MaterializationError } from '../errors.js';
import { P4LocalPathSchema } from '../schemas.js';
import { requirePositive } from '../commands/shared.js';
import type { P4KeywordMode } from '../commands/print.js';
import type { P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';

/** An exact depot revision to write to disk. */
export interface P4MaterializeSpec {
  /** Depot path, without a revision. */
  readonly depotFile: string;
  /** Exact revision number. */
  readonly revision: number;
}

/** Options for {@link materializeDepotFiles}. */
export interface MaterializeDepotFilesOptions {
  /** Exact revisions, for example from a history or `files` listing. */
  readonly files: readonly P4MaterializeSpec[];
  /** Existing directory that receives the files, relative to the client's `cwd`. */
  readonly directory: string;
  /** Refuse to write more files than this. */
  readonly maxFiles: number;
  /** `p4 print` processes run at once. Defaults to 4. */
  readonly concurrency?: number | undefined;
  /** Keyword expansion. Defaults to `raw`. */
  readonly keywords?: P4KeywordMode | undefined;
}

/** One revision written to disk. */
export interface P4MaterializedFile {
  /** The requested revision, as given. */
  readonly file: P4MaterializeSpec;
  /** Where it was written, beneath the directory. */
  readonly localPath: P4LocalPath;
}

/** Every revision written by {@link materializeDepotFiles}. */
export interface P4MaterializeResult {
  /** The resolved destination directory. */
  readonly directory: P4LocalPath;
  /** Written files, in the order requested. */
  readonly items: P4MaterializedFile[];
  readonly messages: P4Message[];
}

/** Any problem with a revision fails the whole call, as it did before. */
const POLICY: P4MessagePolicy = {
  no_such_file: 'fail',
  not_on_client: 'fail',
  unknown_revision: 'fail',
  not_in_view: 'fail',
  empty: 'fail',
};

const toLocalPath = Schema.decodeUnknownSync(P4LocalPathSchema);

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
  const outputPath = resolve(directory, ...segments);
  const inside = relative(directory, outputPath);
  if (inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw invalidPath(`Depot path escapes the materialization directory: ${depotFile}`);
  }
  return outputPath;
}

function planPaths(
  directory: string,
  files: readonly P4MaterializeSpec[],
): Effect.Effect<Array<{ file: P4MaterializeSpec; outputPath: string }>, P4MaterializationError> {
  return Effect.suspend(() => {
    const seen = new Set<string>();
    const plans: Array<{ file: P4MaterializeSpec; outputPath: string }> = [];
    for (const file of files) {
      let outputPath: string;
      try {
        outputPath = materializedFilePath(directory, file.depotFile);
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
      plans.push({ file, outputPath });
    }
    return Effect.succeed(plans);
  });
}

function destinationError(path: string): P4MaterializationError {
  return new P4MaterializationError({
    message: `Materialization directory is unavailable: ${path}`,
    reason: 'invalid_destination',
    path,
  });
}

/**
 * Write exact depot revisions beneath an existing directory, one
 * `p4 print -q -o <path> <file>#<rev>` per file (`-k` unless keywords are
 * expanded), so content never passes through this process.
 *
 * Files land at `<directory>/<depot>/<path…>`. Nothing is synced and the
 * workspace is untouched. A revision that does not exist fails the call
 * with `P4CommandError`; a deleted revision prints nothing and is not detected.
 *
 * Progress counts files written against the number requested.
 *
 * @returns The destination directory and each file's local path.
 * @throws {P4MaterializationError} When the file count exceeds `maxFiles`, a
 * depot path is invalid or two resolve to one output path, or the directory is unusable.
 * @throws {P4InvalidArgumentError} When `maxFiles`, `concurrency` or a revision is not a positive integer.
 */
export const materializeDepotFiles = operation<
  MaterializeDepotFilesOptions,
  P4MaterializedFile,
  P4MaterializeResult
>('materializeDepotFiles', (options, sink) =>
  Effect.gen(function* () {
    const maxFiles = yield* requirePositive(options.maxFiles, 'maxFiles');
    const concurrency = yield* requirePositive(options.concurrency ?? 4, 'concurrency');
    if (options.files.length > maxFiles) {
      return yield* new P4MaterializationError({
        message: `Refusing to materialize ${options.files.length} files; maxFiles is ${maxFiles}.`,
        reason: 'limit_exceeded',
        path: null,
      });
    }
    for (const file of options.files) yield* requirePositive(file.revision, 'revision');
    const config = yield* P4Config.asEffect();
    const directory = resolve(config.cwd ?? process.cwd(), options.directory);
    const info = yield* Effect.tryPromise({ try: () => stat(directory), catch: () => destinationError(directory) });
    if (!info.isDirectory()) return yield* destinationError(directory);
    const plans = yield* planPaths(directory, options.files);

    const keywordArgs = (options.keywords ?? 'raw') === 'raw' ? ['-k'] : [];
    const counter = progressCounter(sink, 'files', plans.length);
    const messages: P4Message[] = [];
    const items = yield* Effect.forEach(plans, (plan) => Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(plan.outputPath), { recursive: true }),
        catch: () => destinationError(dirname(plan.outputPath)),
      });
      const output = yield* runPlainCommand({
        args: ['print', '-q', ...keywordArgs, '-o', plan.outputPath, `${plan.file.depotFile}#${plan.file.revision}`],
        policy: POLICY,
      });
      messages.push(...output.messages);
      for (const message of output.messages) yield* sink.message(message);
      const item: P4MaterializedFile = { file: plan.file, localPath: toLocalPath(plan.outputPath) };
      yield* sink.item(item);
      yield* counter.advance(1);
      return item;
    }), { concurrency });

    return { directory: toLocalPath(directory), items, messages };
  }));
