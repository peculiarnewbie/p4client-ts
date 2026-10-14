import { Effect, Stream } from 'effect';
import { streamCommand } from '../engine/command.js';
import { operation, progressCounter } from '../engine/operation.js';
import { fileAtRevision, isBinaryP4Type } from './diff-text.js';
import {
  depotPath,
  integer,
  invalid,
  isoFromSeconds,
  itemFailure,
  malformed,
  optionalAction,
  text,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4Context, P4ProgressCounter } from '../engine/operation.js';
import type { P4Error } from '../errors.js';
import type { P4DepotPath, P4FileAction } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { P4RevisionSpec } from './diff-text.js';
import type { P4ItemFailure, Row } from './shared.js';

/**
 * Whether `$Keyword$` placeholders in `+k` files are expanded.
 *
 * - `raw` (the default) prints the content as stored, with keywords
 *   unexpanded (`p4 print -K`; servers before 2022.1 spell it `-k`).
 * - `expand` prints what a sync would write, with keywords expanded.
 */
export type P4KeywordMode = 'raw' | 'expand';

/** A printed file revision, without its content. */
export interface P4PrintedFileInfo {
  readonly depotFile: P4DepotPath;
  readonly revision: number | null;
  /** The changelist that submitted (or shelved) this revision. */
  readonly change: number | null;
  readonly action: P4FileAction | null;
  readonly type: string | null;
  /** Time of the revision's changelist, as ISO 8601. */
  readonly time: string | null;
  /** Size of the stored content in bytes, when the server reports it. */
  readonly fileSize: number | null;
}

/** Options for {@link printFile}. */
export interface PrintFileOptions {
  /** File to print, in depot, client or local syntax. May carry its own `#`/`@` revision. */
  readonly file: string;
  /** Revision to print, appended to `file`. Defaults to the head revision. */
  readonly revision?: P4RevisionSpec | undefined;
  /** Keyword expansion. Defaults to `raw`. */
  readonly keywords?: P4KeywordMode | undefined;
}

/**
 * One file revision's content as bytes, exactly as `p4 -G print` sends it.
 *
 * Decode text with {@link printedText}. The result is plain data, so it
 * survives `structuredClone` and IPC.
 */
export interface P4PrintedFile extends P4PrintedFileInfo {
  readonly content: Uint8Array;
  readonly isBinary: boolean;
  readonly messages: P4Message[];
}

/** Options for {@link printBatch}. */
export interface PrintBatchOptions {
  /** Files to print, each in depot, client or local syntax, with an optional revision. */
  readonly files: readonly string[];
  /** Keyword expansion. Defaults to `raw`. */
  readonly keywords?: P4KeywordMode | undefined;
}

/** One file printed by {@link printBatch}. */
export interface P4PrintedBatchItem {
  readonly file: P4PrintedFileInfo;
  readonly content: Uint8Array;
}

/** Everything {@link printBatch} printed. */
export interface P4PrintBatchResult {
  readonly items: P4PrintedBatchItem[];
  readonly messages: P4Message[];
  /** Specs that matched no file or revision, as the messages Perforce reported for them. */
  readonly failures: P4ItemFailure[];
}

/** Reasons that mean a spec printed nothing. */
const MISSING = ['no_such_file', 'not_on_client', 'unknown_revision', 'not_in_view', 'empty'] as const;

const FILE_POLICY: P4MessagePolicy = Object.fromEntries(MISSING.map((reason) => [reason, 'fail']));

const BATCH_POLICY: P4MessagePolicy = {
  ...Object.fromEntries(MISSING.map((reason) => [reason, 'item'])),
  invalid_revision: 'item',
};

type PrintRecord =
  | { readonly _tag: 'stat'; readonly info: P4PrintedFileInfo }
  | { readonly _tag: 'chunk'; readonly data: Uint8Array };

function toPrintRecord(row: Row): PrintRecord | null {
  if (row.code === 'stat') {
    return {
      _tag: 'stat',
      info: {
        depotFile: depotPath(row.depotFile, row),
        revision: integer(row.rev, row),
        change: integer(row.change, row),
        action: optionalAction(row.action, row),
        type: text(row.type),
        time: isoFromSeconds(row.time),
        fileSize: integer(row.fileSize, row),
      },
    };
  }
  if (row.code === 'text' || row.code === 'binary') {
    if (!(row.data instanceof Uint8Array)) throw malformed('print content is not bytes.', { code: row.code });
    return { _tag: 'chunk', data: row.data };
  }
  return null;
}

function printArgs(keywords: P4KeywordMode | undefined): string[] {
  return (keywords ?? 'raw') === 'raw' ? ['print', '-K'] : ['print'];
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

interface PrintHandlers {
  readonly file: (item: P4PrintedBatchItem) => Effect.Effect<void>;
  readonly message: (message: P4Message) => Effect.Effect<void>;
  readonly failure: (message: P4Message) => Effect.Effect<void>;
}

/**
 * Run a `-G print` and assemble its records into files: each `stat` record
 * is followed by the file's `text` or `binary` content records.
 */
function printFiles(spec: P4CommandSpec<PrintRecord>, handlers: PrintHandlers): Effect.Effect<void, P4Error, P4Context> {
  return Effect.suspend(() => {
    let current: { info: P4PrintedFileInfo; chunks: Uint8Array[] } | null = null;
    const flush = Effect.suspend(() => {
      if (current === null) return Effect.void;
      const item = { file: current.info, content: concat(current.chunks) };
      current = null;
      return handlers.file(item);
    });
    return streamCommand(spec).pipe(
      Stream.runForEach((event): Effect.Effect<void, P4Error> => {
        if (event._tag === 'message') return handlers.message(event.message);
        if (event._tag === 'failure') return Effect.andThen(flush, handlers.failure(event.message));
        const record = event.value;
        if (record._tag === 'stat') {
          return Effect.andThen(flush, Effect.sync(() => {
            current = { info: record.info, chunks: [] };
          }));
        }
        if (current === null) return Effect.fail(malformed('print sent content before naming its file.', null));
        current.chunks.push(record.data);
        return Effect.void;
      }),
      Effect.andThen(flush),
    );
  });
}

function advance(counter: P4ProgressCounter, item: P4PrintedBatchItem): Effect.Effect<void> {
  return counter.advance(1, item.file.fileSize ?? item.content.length);
}

/**
 * Print one file revision as bytes, using `p4 -G print`.
 *
 * Unlike `-Mj print`, `-G` keeps binary content intact. A file or revision
 * that does not exist (`no_such_file`, `unknown_revision`, `not_on_client`
 * for `#have`) fails with `P4CommandError`.
 *
 * @returns The revision's metadata and content.
 * @throws {P4InvalidArgumentError} When `file` matches more than one file.
 */
export const printFile = operation<PrintFileOptions, never, P4PrintedFile>('printFile', (options, sink) =>
  Effect.gen(function* () {
    const spec = options.revision === undefined ? options.file : fileAtRevision(options.file, options.revision);
    const counter = progressCounter(sink, 'files', 1);
    const files: P4PrintedBatchItem[] = [];
    const messages: P4Message[] = [];
    yield* printFiles({
      args: [...printArgs(options.keywords), spec],
      format: 'marshal',
      policy: FILE_POLICY,
      decode: toPrintRecord,
    }, {
      file: (item) => Effect.sync(() => {
        files.push(item);
      }),
      message: (message) => Effect.andThen(Effect.sync(() => messages.push(message)), sink.message(message)),
      // The policy fails every per-file problem, so there are no failures.
      failure: () => Effect.void,
    });
    const printed = files[0];
    if (printed === undefined) return yield* malformed(`print printed nothing for ${spec}.`, messages);
    if (files.length > 1) {
      return yield* invalid('file', `${spec} matches ${files.length} files; printFile prints one. Use printBatch.`);
    }
    yield* advance(counter, printed);
    return {
      ...printed.file,
      content: printed.content,
      isBinary: isBinaryP4Type(printed.file.type),
      messages,
    };
  }));

/**
 * Print several file revisions as bytes with one `p4 -G -x - print`, the
 * specs passed on stdin.
 *
 * Each file is reported as soon as its content is complete. A spec that
 * matches no file or revision is a per-item failure, not an error.
 *
 * Progress counts files against the number of specs (a wildcard spec can
 * print more, which clears the total) and bytes from each file's size.
 *
 * @returns The printed files, messages and failures.
 * @throws {P4InvalidArgumentError} When `files` is empty or a spec contains a line break.
 */
export const printBatch = operation<PrintBatchOptions, P4PrintedBatchItem, P4PrintBatchResult>('printBatch', (options, sink) =>
  Effect.gen(function* () {
    if (options.files.length === 0) return yield* invalid('files', 'printBatch needs at least one file.');
    if (options.files.some((file) => /[\r\n]/.test(file) || file.length === 0)) {
      return yield* invalid('files', 'File specs must be non-empty and on one line.');
    }
    const total = options.files.length;
    const counter = progressCounter(sink, 'files', total);
    const result: P4PrintBatchResult = { items: [], messages: [], failures: [] };
    const step = () => Effect.suspend(() => {
      if (counter.snapshot().completed >= total) counter.expect(null);
      return Effect.void;
    });
    yield* printFiles({
      args: printArgs(options.keywords),
      globalArgs: ['-x', '-'],
      input: `${options.files.join('\n')}\n`,
      format: 'marshal',
      policy: BATCH_POLICY,
      decode: toPrintRecord,
    }, {
      file: (item) => Effect.sync(() => result.items.push(item)).pipe(
        Effect.andThen(sink.item(item)),
        Effect.andThen(step()),
        Effect.andThen(advance(counter, item)),
      ),
      message: (message) => Effect.andThen(Effect.sync(() => result.messages.push(message)), sink.message(message)),
      failure: (message) => Effect.sync(() => result.failures.push(itemFailure(message))).pipe(
        Effect.andThen(sink.failure(message)),
        Effect.andThen(step()),
        Effect.andThen(counter.advance(1)),
      ),
    });
    return result;
  }));

/**
 * Decode printed content as text.
 *
 * `p4 -G print` already translates `utf16` and `unicode` files to the
 * connection's charset (UTF-8 here), so content decodes as UTF-8; a leading
 * byte-order mark is dropped, and content that starts with a UTF-16 mark is
 * decoded as UTF-16.
 *
 * @param printed A {@link printFile} result or a {@link printBatch} item.
 * @returns The content as a string. Binary content is decoded too; check `isBinary` or the type first.
 */
export function printedText(printed: { readonly content: Uint8Array }): string {
  const bytes = printed.content;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes, true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes, false);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Decode UTF-16 after its byte-order mark. */
function utf16(bytes: Uint8Array, littleEndian: boolean): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const units: number[] = [];
  for (let offset = 2; offset + 1 < bytes.length; offset += 2) units.push(view.getUint16(offset, littleEndian));
  let text = '';
  for (let start = 0; start < units.length; start += 8192) {
    text += String.fromCharCode(...units.slice(start, start + 8192));
  }
  return text;
}
