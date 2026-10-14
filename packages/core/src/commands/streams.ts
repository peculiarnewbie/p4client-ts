import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  depotPath,
  description,
  indexes,
  isoFromSeconds,
  malformed,
  requirePositive,
  specList,
  text,
} from './shared.js';
import type { P4DepotPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { FileSpecs, Row } from './shared.js';

/** Options for {@link listStreams}. */
export interface ListStreamsOptions {
  /** Only streams matching these paths, for example `//Project/...`. */
  readonly fileSpec?: FileSpecs | undefined;
  /** At most this many streams (`streams -m`). */
  readonly limit?: number | undefined;
}

/** A stream as `p4 streams` lists it. */
export interface P4Stream {
  /** Stream path, for example `//Project/main`. */
  readonly stream: P4DepotPath;
  /** Display name, for example `main`. */
  readonly name: string;
  readonly owner: string | null;
  /** Parent stream, or `null` for a mainline. With `parent`, enough to assemble the hierarchy. */
  readonly parent: P4DepotPath | null;
  /** `mainline`, `development`, `release`, `virtual`, `task` and so on. */
  readonly type: string | null;
  readonly description: string | null;
  /** Stream options, for example `['allsubmit', 'unlocked', ...]`. */
  readonly options: string[];
  /** Last access, as ISO 8601. */
  readonly accessedAt: string | null;
  /** Last change to the spec, as ISO 8601. */
  readonly updatedAt: string | null;
}

/** Streams with the messages Perforce reported. */
export interface P4StreamList {
  readonly items: P4Stream[];
  readonly messages: P4Message[];
}

function parentStream(value: unknown, row: Row): P4DepotPath | null {
  const parent = text(value);
  return parent === null || parent === 'none' ? null : depotPath(parent, row);
}

function words(value: unknown): string[] {
  return text(value)?.split(/\s+/) ?? [];
}

function baseName(stream: P4DepotPath): string {
  return stream.slice(stream.lastIndexOf('/') + 1);
}

function toStream(row: Row): P4Stream {
  const stream = depotPath(row.Stream, row);
  return {
    stream,
    name: text(row.Name) ?? baseName(stream),
    owner: text(row.Owner),
    parent: parentStream(row.Parent, row),
    type: text(row.Type),
    description: description(row.desc),
    options: words(row.Options),
    accessedAt: isoFromSeconds(row.Access),
    updatedAt: isoFromSeconds(row.Update),
  };
}

/**
 * List streams (`p4 streams`). Each carries its parent, so the hierarchy of
 * a stream depot needs no further queries. A path that matches no stream
 * gives no items and an `empty` message.
 *
 * @returns The streams, in the order Perforce lists them.
 */
export const listStreams = operation<ListStreamsOptions, P4Stream, P4StreamList>('listStreams', (options, sink) =>
  Effect.gen(function* () {
    const args = ['streams'];
    if (options.limit !== undefined) args.push('-m', String(yield* requirePositive(options.limit, 'limit')));
    args.push(...specList(options.fileSpec));
    const output = yield* drain(sink, streamCommand({ args, format: 'json', decode: toStream }), {
      item: (stream) => stream,
      counter: progressCounter(sink, 'records'),
    });
    return { items: output.items, messages: output.messages };
  }));

/** Options for {@link getStream}. */
export interface GetStreamOptions {
  /** Stream path, for example `//Project/main`. */
  readonly stream: string;
}

/** A stream spec (`p4 stream -o`): the stream and its view. */
export interface P4StreamSpec {
  readonly stream: P4DepotPath;
  readonly name: string;
  readonly owner: string | null;
  readonly parent: P4DepotPath | null;
  readonly type: string | null;
  readonly description: string | null;
  readonly options: string[];
  /** How the view follows the parent's: `inherit` or `noinherit`. */
  readonly parentView: string | null;
  /** `Paths` lines as written, for example `share ...` or `import vendor/... //Lib/main/...`. */
  readonly paths: string[];
  /** `Remapped` lines as written. */
  readonly remapped: string[];
  /** `Ignored` lines as written. */
  readonly ignored: string[];
  readonly messages: P4Message[];
}

function lines(row: Row, field: string): string[] {
  return indexes(row, field).flatMap((index) => text(row[`${field}${index}`]) ?? []);
}

function toStreamSpec(row: Row): Omit<P4StreamSpec, 'messages'> {
  const stream = depotPath(row.Stream, row);
  return {
    stream,
    name: text(row.Name) ?? baseName(stream),
    owner: text(row.Owner),
    parent: parentStream(row.Parent, row),
    type: text(row.Type),
    description: description(row.Description),
    options: words(row.Options),
    parentView: text(row.ParentView),
    paths: lines(row, 'Paths'),
    remapped: lines(row, 'Remapped'),
    ignored: lines(row, 'Ignored'),
  };
}

/**
 * Read a stream's spec (`p4 stream -o`), including its `Paths` view.
 * Perforce prints a default spec for a stream that does not exist yet.
 *
 * @returns The stream spec.
 */
export const getStream = operation<GetStreamOptions, never, P4StreamSpec>('getStream', (options, sink) =>
  Effect.gen(function* () {
    const output = yield* drain(sink, streamCommand({ args: ['stream', '-o', options.stream], format: 'json', decode: toStreamSpec }), {
      counter: progressCounter(sink, 'records', 1),
    });
    const spec = output.items[0];
    if (spec === undefined) return yield* malformed('stream -o printed no spec.', output.messages);
    return { ...spec, messages: output.messages };
  }));
