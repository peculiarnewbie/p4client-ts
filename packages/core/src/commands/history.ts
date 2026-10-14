import { Effect, Stream } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  depotPath,
  description,
  indexes,
  integer,
  isoFromSeconds,
  malformed,
  optionalAction,
  positive,
  requirePositive,
  text,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4DepotPath, P4FileAction } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { Row } from './shared.js';

/** Options for {@link getFileHistory}. */
export interface GetFileHistoryOptions {
  /**
   * Depot, client or local file spec. A wildcard matches several files; their
   * revisions are merged as described on {@link P4FileHistory.items}.
   */
  readonly file: string;
  /**
   * Maximum revisions to return, across every path reported. Defaults to all.
   * `hasMore` says whether more were available.
   */
  readonly limit?: number | undefined;
  /**
   * Follow history across branches and integrations (`filelog -i`). Ancestor
   * paths are listed only up to the revision they were branched from.
   * Defaults to `false`. Renames are reported either way; see {@link followMoves}.
   */
  readonly followBranches?: boolean | undefined;
}

/**
 * How a revision relates to another file, as `filelog` reports it: for example
 * `moved from`, `moved into`, `branch from`, `copy into` or `edit from`.
 */
export interface P4Integration {
  /** The relationship, as Perforce words it. */
  readonly how: string;
  /** The other file. */
  readonly file: P4DepotPath;
  /** The other file's revisions after this one are involved; `0` for `#none`. */
  readonly startRevision: number;
  /** The last of the other file's revisions involved; `0` for `#none`. */
  readonly endRevision: number;
}

/** One revision in a file's history. */
export interface P4FileRevision {
  /**
   * Path this revision belongs to. A history can span several paths, and
   * revision numbers restart at 1 on each, so this tells repeated numbers apart.
   */
  readonly depotFile: P4DepotPath;
  /** Revision number within {@link depotFile}. */
  readonly revision: number;
  readonly change: number | null;
  readonly action: P4FileAction | null;
  readonly type: string | null;
  /** Submit time, as ISO 8601. */
  readonly submittedAt: string | null;
  readonly user: string | null;
  readonly client: string | null;
  /** The changelist's full description. */
  readonly description: string | null;
  /** MD5 of the content. */
  readonly digest: string | null;
  readonly fileSize: number | null;
  /** Integrations, branches, copies and moves this revision took part in. */
  readonly integrations: P4Integration[];
}

/** A file's revision history. */
export interface P4FileHistory {
  /**
   * The first path `filelog` reported, in depot syntax: the requested file,
   * never an ancestor. For a wildcard, the first file matched. `null` when
   * nothing matched.
   */
  readonly depotFile: P4DepotPath | null;
  /**
   * Revisions from every path reported, newest first by changelist (then by
   * submit time). Revision number is not the order, since it restarts on each path.
   */
  readonly items: P4FileRevision[];
  readonly messages: P4Message[];
  /** Whether `limit` cut off older revisions. */
  readonly hasMore: boolean;
}

/** `#3` as 3 and `#none` as 0. */
function revisionNumber(value: unknown, row: Row): number {
  const raw = text(value);
  if (raw === '#none') return 0;
  const match = raw === null ? null : /^#(\d+)$/.exec(raw);
  if (match?.[1] === undefined) throw malformed(`Expected a revision such as #3, received ${String(value)}.`, row);
  return Number(match[1]);
}

/** The `how{n},{m}` records of revision `n`, in index order. */
function integrations(row: Row, index: number): P4Integration[] {
  const pattern = new RegExp(`^how${index},(\\d+)$`);
  return Object.keys(row)
    .flatMap((key) => {
      const match = pattern.exec(key);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    })
    .sort((left, right) => left - right)
    .map((other) => {
      const suffix = `${index},${other}`;
      const how = text(row[`how${suffix}`]);
      if (how === null) throw malformed('Expected an integration with a how field.', row);
      return {
        how,
        file: depotPath(row[`file${suffix}`], row),
        startRevision: revisionNumber(row[`srev${suffix}`], row),
        endRevision: revisionNumber(row[`erev${suffix}`], row),
      };
    });
}

/**
 * Convert a `filelog` record, one path with its revisions.
 *
 * @param row One data record.
 * @returns The path's revisions, newest first.
 */
export function toFileRevisions(row: Row): P4FileRevision[] {
  const file = depotPath(row.depotFile, row);
  return indexes(row, 'rev').map((index) => ({
    depotFile: file,
    revision: positive(row[`rev${index}`], row),
    change: integer(row[`change${index}`], row),
    action: optionalAction(row[`action${index}`], row),
    type: text(row[`type${index}`]),
    submittedAt: isoFromSeconds(row[`time${index}`]),
    user: text(row[`user${index}`]),
    client: text(row[`client${index}`]),
    description: description(row[`desc${index}`]),
    digest: text(row[`digest${index}`]),
    fileSize: integer(row[`fileSize${index}`], row),
    integrations: integrations(row, index),
  }));
}

/** Newest first: by changelist, else by submit time; otherwise keep the input order. */
function newestFirst(left: P4FileRevision, right: P4FileRevision): number {
  if (left.change !== null && right.change !== null) return right.change - left.change;
  if (left.submittedAt !== null && right.submittedAt !== null) {
    return right.submittedAt < left.submittedAt ? -1 : right.submittedAt > left.submittedAt ? 1 : 0;
  }
  return 0;
}

/** Merge every path's revisions, each revision once, newest first. */
function merge(rows: readonly P4FileRevision[][]): P4FileRevision[] {
  const seen = new Set<string>();
  const merged: P4FileRevision[] = [];
  for (const revision of rows.flat()) {
    // A wide integration graph can report one path in several records.
    const key = `${revision.depotFile}#${revision.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(revision);
  }
  return merged.sort(newestFirst);
}

function filelogCommand(options: GetFileHistoryOptions, perPath: number | undefined): P4CommandSpec<P4FileRevision[]> {
  const args = ['filelog', '-l'];
  if (options.followBranches) args.push('-i');
  if (perPath !== undefined) args.push('-m', String(perPath));
  args.push(options.file);
  return { args, format: 'json', decode: toFileRevisions };
}

/**
 * Get a file's revision history with full changelist descriptions
 * (`p4 filelog -l`).
 *
 * `filelog` reports one record per path: several for a wildcard, for a renamed
 * file (its pre-rename path) and with `followBranches` (each ancestor). Their
 * revisions are merged into one newest-first list. `filelog -m` bounds each
 * path separately, so `limit + 1` revisions are requested per path and the
 * merged list is cut to `limit`. A file that does not exist gives an empty
 * history with an `empty` message.
 *
 * @returns The history.
 */
export const getFileHistory = operation<GetFileHistoryOptions, P4FileRevision, P4FileHistory>('getFileHistory', (options, sink) =>
  Effect.gen(function* () {
    const limit = options.limit === undefined ? undefined : yield* requirePositive(options.limit, 'limit');
    const counter = progressCounter(sink, 'revisions');
    const events = streamCommand(filelogCommand(options, limit === undefined ? undefined : limit + 1)).pipe(
      Stream.tap((event) => (event._tag === 'data' ? counter.advance(event.value.length) : Effect.void)),
    );
    const output = yield* drain(sink, events);
    const merged = merge(output.items);
    const items = limit === undefined ? merged : merged.slice(0, limit);
    for (const item of items) yield* sink.item(item);
    return {
      depotFile: output.items[0]?.[0]?.depotFile ?? null,
      items,
      messages: output.messages,
      hasMore: limit !== undefined && merged.length > limit,
    };
  }), 'revisions');

/** A file's history across its renames. */
export interface P4FileLineage {
  /** The file's paths, newest first: where it is now, then where it was moved from. */
  readonly paths: P4DepotPath[];
  /** The revisions of the file under each of those paths, newest first. */
  readonly items: P4FileRevision[];
}

/**
 * Follow a file back through its renames in a history: from the file's
 * `move/add` revision to the path it was `moved from`, up to the revision it
 * was moved at, and so on. Revisions of other files in the history (wildcard
 * matches, branch ancestors) are left out, as are older revisions of a path
 * that a moved file replaced.
 *
 * The lineage is only as complete as the history: one cut short by `limit`
 * gives a shorter lineage, and `paths` can end in a path whose revisions the
 * history does not include.
 *
 * @param history A history from {@link getFileHistory}.
 * @param from The path to start from. Defaults to `history.depotFile`.
 * @returns The file's paths and revisions.
 */
export function followMoves(
  history: Pick<P4FileHistory, 'depotFile' | 'items'>,
  from: P4DepotPath | null = history.depotFile,
): P4FileLineage {
  const paths: P4DepotPath[] = [];
  const items: P4FileRevision[] = [];
  let path = from;
  let upTo = Number.POSITIVE_INFINITY;
  while (path !== null && !paths.includes(path)) {
    paths.push(path);
    const current: P4DepotPath = path;
    const revisions = history.items
      .filter((revision) => revision.depotFile === current && revision.revision <= upTo)
      .sort((left, right) => right.revision - left.revision);
    path = null;
    for (const revision of revisions) {
      items.push(revision);
      const moved = revision.action === 'move/add'
        ? revision.integrations.find((integration) => integration.how === 'moved from')
        : undefined;
      if (moved !== undefined) {
        path = moved.file;
        upTo = moved.endRevision;
        break;
      }
    }
  }
  return { paths, items };
}
