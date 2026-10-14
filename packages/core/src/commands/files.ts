import { Effect, Schema } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { P4ClientPathSchema } from '../schemas.js';
import {
  action,
  change,
  decodeField,
  depotPath,
  description,
  integer,
  invalid,
  isoFromSeconds,
  itemFailure,
  localPath,
  malformed,
  optionalAction,
  positive,
  requirePositive,
  specList,
  text,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4DrainOptions, P4ProgressCounter, P4Sink } from '../engine/operation.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { FileSpecs, P4ItemFailure, Row } from './shared.js';

/**
 * Policy of the commands that take several file specs (`files`, `fstat`,
 * `where`, `have`): a spec that matches nothing, is outside the workspace view,
 * or has no such revision is a per-item failure, so the other specs still
 * answer. Session, connection, permission and usage problems still fail.
 */
const FILE_SPEC_POLICY: P4MessagePolicy = {
  no_such_file: 'item',
  unknown_revision: 'item',
  not_on_client: 'item',
  not_in_view: 'item',
};

const NON_TEXT_BASE_TYPES = new Set(['binary', 'apple', 'resource', 'xb', 'xbinary']);

/** Whether a Perforce file type, such as `binary+l`, is non-text. */
function isBinaryType(type: string | null): boolean {
  if (type === null) return false;
  const base = type.toLowerCase().split('+', 1)[0] ?? '';
  return NON_TEXT_BASE_TYPES.has(base) || base.includes('binary') || base.includes('xb');
}

/** Whether an action leaves no file at that revision. */
function isDeleteAction(fileAction: P4FileAction | null): boolean {
  return fileAction === 'delete' || fileAction === 'move/delete' || fileAction === 'archive' || fileAction === 'purge';
}

/** The last segment of a depot path. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Report items until `limit` have been reported; the extra row that sets `hasMore` is not reported. */
function upTo<A>(limit: number | undefined, keep: (value: A) => boolean = () => true): (value: A) => A | null {
  let reported = 0;
  return (value) => {
    if (!keep(value) || (limit !== undefined && reported >= limit)) return null;
    reported += 1;
    return value;
  };
}

/** Run a single command, reporting every decoded record as an item. */
function drainAll<A>(
  sink: P4Sink<A>,
  spec: P4CommandSpec<A>,
  counter: P4ProgressCounter,
  item: P4DrainOptions<A, A>['item'] = (value) => value,
) {
  return drain(sink, streamCommand(spec), { item, counter });
}

/** Validate an optional `atChange` and append it to a spec. */
function atChange(spec: string, changeNumber: number | undefined) {
  return changeNumber === undefined
    ? Effect.succeed(spec)
    : Effect.map(requirePositive(changeNumber, 'atChange'), (value) => `${spec}@${value}`);
}

/** Validate a depot directory for one-level browsing, without a trailing slash. */
function browseDirectory(path: string) {
  return !path.startsWith('//') || /[#@*]/.test(path) || path.includes('...')
    ? invalid('depotPath', 'depotPath must be a depot directory without a wildcard or revision specifier.')
    : Effect.succeed(path.replace(/\/+$/, ''));
}

/** Options for {@link listDepots}. */
export interface ListDepotsOptions {}

/** A depot, the root of a depot tree. */
export interface P4Depot {
  /** Depot name, for example `depot`. */
  readonly name: string;
  /** Root path, for example `//depot`. */
  readonly depotPath: P4DepotPath;
  /** `local`, `stream`, `remote`, `spec` and so on. */
  readonly type: string | null;
  /** Storage map, when reported. */
  readonly map: string | null;
  readonly description: string | null;
  /** Creation time, as ISO 8601. */
  readonly createdAt: string | null;
}

/** Depots with the messages Perforce reported. */
export interface P4DepotList {
  readonly items: P4Depot[];
  readonly messages: P4Message[];
}

function toDepot(row: Row): P4Depot {
  const name = text(row.name);
  if (name === null) throw malformed('Expected a depot with a name.', row);
  return {
    name,
    depotPath: depotPath(`//${name}`, row),
    type: text(row.type),
    map: text(row.map),
    description: description(row.desc),
    createdAt: isoFromSeconds(row.time),
  };
}

/**
 * List the depots on the server, the roots that {@link listDepotDirs} and
 * {@link listDepotFiles} expand.
 *
 * @returns Depots, in the order Perforce lists them.
 */
export const listDepots = operation<ListDepotsOptions, P4Depot, P4DepotList>('listDepots', (_, sink) =>
  Effect.map(
    drainAll(sink, { args: ['depots'], format: 'json', decode: toDepot }, progressCounter(sink, 'records')),
    (output) => ({ items: output.items, messages: output.messages }),
  ));

/** Options for {@link listDepotDirs}. */
export interface ListDepotDirsOptions {
  /**
   * Depot directory whose immediate subdirectories are listed, for example
   * `//depot/main`. A one-level `/*` is appended, so the path must not contain
   * a wildcard or revision specifier.
   */
  readonly depotPath: string;
  /** List the directories as they were at this submitted changelist. */
  readonly atChange?: number | undefined;
  /** Most directories to return. `p4 dirs` has no limit of its own, so this is applied as rows arrive. */
  readonly limit?: number | undefined;
}

/** A depot directory. */
export interface P4DepotDir {
  /** Full path, for example `//depot/main/art`. */
  readonly depotDir: P4DepotPath;
  /** Last path segment, for example `art`. */
  readonly name: string;
}

/** One level of depot directories. */
export interface P4DepotDirList {
  readonly items: P4DepotDir[];
  readonly messages: P4Message[];
  /** Whether more directories exist beyond `limit`. */
  readonly hasMore: boolean;
}

function toDepotDir(row: Row): P4DepotDir {
  const dir = depotPath(row.dir, row);
  return { depotDir: dir, name: baseName(dir) };
}

/**
 * List the immediate subdirectories of a depot directory, for lazy tree
 * expansion. An empty or missing directory lists nothing.
 *
 * @returns Subdirectories, in the order Perforce lists them.
 */
export const listDepotDirs = operation<ListDepotDirsOptions, P4DepotDir, P4DepotDirList>('listDepotDirs', (options, sink) =>
  Effect.gen(function* () {
    const limit = options.limit === undefined ? undefined : yield* requirePositive(options.limit, 'limit');
    const spec = yield* atChange(`${yield* browseDirectory(options.depotPath)}/*`, options.atChange);
    const output = yield* drainAll(
      sink,
      { args: ['dirs', spec], format: 'json', decode: toDepotDir },
      progressCounter(sink, 'records'),
      upTo(limit),
    );
    return {
      items: limit === undefined ? output.items : output.items.slice(0, limit),
      messages: output.messages,
      hasMore: limit !== undefined && output.items.length > limit,
    };
  }));

/** A depot file revision as `p4 files` lists it, normally the head revision. */
export interface P4DepotFile {
  readonly depotFile: P4DepotPath;
  /** Last path segment, for example `foo.txt`. */
  readonly name: string;
  readonly revision: number | null;
  /** Action of the revision, such as `add`, `edit` or `delete`. */
  readonly action: P4FileAction | null;
  /** File type, with modifiers, such as `binary+l`. */
  readonly type: string | null;
  /** Changelist that submitted the revision. */
  readonly change: number | null;
  /** Submission time, as ISO 8601. */
  readonly submittedAt: string | null;
  /** Whether the revision is a delete, move/delete, archive or purge. */
  readonly isDeletedAtHead: boolean;
  /** Whether the file type is non-text. */
  readonly isBinary: boolean;
}

/** Depot files, with the messages Perforce reported. */
export interface P4DepotFileList {
  readonly items: P4DepotFile[];
  readonly messages: P4Message[];
  /** Whether more files exist beyond `limit`. */
  readonly hasMore: boolean;
}

/** Depot files for several specs, with the specs that matched nothing. */
export interface P4FileList extends P4DepotFileList {
  /** One message per spec that matched no file, revision or view. */
  readonly failures: P4ItemFailure[];
}

function toDepotFile(row: Row): P4DepotFile {
  const depotFile = depotPath(row.depotFile, row);
  const fileAction = optionalAction(row.action, row);
  const type = text(row.type);
  return {
    depotFile,
    name: baseName(depotFile),
    revision: integer(row.rev, row),
    action: fileAction,
    type,
    change: integer(row.change, row),
    submittedAt: isoFromSeconds(row.time),
    isDeletedAtHead: isDeleteAction(fileAction),
    isBinary: isBinaryType(type),
  };
}

/** Options for {@link listDepotFiles}. */
export interface ListDepotFilesOptions {
  /**
   * Depot directory whose immediate files are listed, for example
   * `//depot/main`. A one-level `/*` is appended, so the path must not contain
   * a wildcard or revision specifier.
   */
  readonly depotPath: string;
  /** List the files as they were at this submitted changelist. */
  readonly atChange?: number | undefined;
  /** Most files to return. Omit for every file. */
  readonly limit?: number | undefined;
  /**
   * Files whose head revision is deleted, moved away, archived or purged:
   * `exclude` (default, with `files -e`), `include`, or `only`. `only` lists the
   * whole level and applies `limit` locally, because `files -m` counts every file.
   */
  readonly deletedFiles?: 'exclude' | 'include' | 'only' | undefined;
}

/**
 * List the immediate files of a depot directory at their head revision (or at
 * `atChange`). An empty or missing directory lists nothing.
 *
 * @returns Files, in the order Perforce lists them.
 */
export const listDepotFiles = operation<ListDepotFilesOptions, P4DepotFile, P4DepotFileList>('listDepotFiles', (options, sink) =>
  Effect.gen(function* () {
    const limit = options.limit === undefined ? undefined : yield* requirePositive(options.limit, 'limit');
    const spec = yield* atChange(`${yield* browseDirectory(options.depotPath)}/*`, options.atChange);
    const deleted = options.deletedFiles ?? 'exclude';
    const args = ['files'];
    if (deleted === 'exclude') args.push('-e');
    if (deleted !== 'only' && limit !== undefined) args.push('-m', String(limit + 1));
    args.push(spec);
    const keep = (file: P4DepotFile) => deleted !== 'only' || file.isDeletedAtHead;
    const output = yield* drainAll(
      sink,
      { args, format: 'json', decode: toDepotFile },
      progressCounter(sink, 'files', deleted === 'only' ? null : limit ?? null),
      upTo(limit, keep),
    );
    const files = output.items.filter(keep);
    return {
      items: limit === undefined ? files : files.slice(0, limit),
      messages: output.messages,
      hasMore: limit !== undefined && files.length > limit,
    };
  }));

/** Options for {@link listFiles}. */
export interface ListFilesOptions {
  /** Depot, client or local file specs, with wildcards and revisions as needed. */
  readonly fileSpec: FileSpecs;
  /** Leave out revisions that are deleted, moved away, archived or purged (`files -e`). */
  readonly existing?: boolean | undefined;
  /** Most files to return. Omit for every file. */
  readonly limit?: number | undefined;
}

/**
 * List the files matching several specs with `p4 files`. A spec that matches
 * nothing (no such file, no such revision, not in the view) is reported in
 * `failures` and does not fail the others.
 *
 * @returns Files, with one failure per spec that matched nothing.
 */
export const listFiles = operation<ListFilesOptions, P4DepotFile, P4FileList>('listFiles', (options, sink) =>
  Effect.gen(function* () {
    const limit = options.limit === undefined ? undefined : yield* requirePositive(options.limit, 'limit');
    const specs = specList(options.fileSpec);
    if (specs.length === 0) return { items: [], messages: [], failures: [], hasMore: false };
    const args = ['files'];
    if (options.existing) args.push('-e');
    if (limit !== undefined) args.push('-m', String(limit + 1));
    args.push(...specs);
    const output = yield* drainAll(
      sink,
      { args, format: 'json', policy: FILE_SPEC_POLICY, decode: toDepotFile },
      progressCounter(sink, 'files', limit ?? null),
      upTo(limit),
    );
    return {
      items: limit === undefined ? output.items : output.items.slice(0, limit),
      messages: output.messages,
      failures: output.failures.map(itemFailure),
      hasMore: limit !== undefined && output.items.length > limit,
    };
  }));

/** Options for {@link listDepotFilesAtChange}. */
export interface ListDepotFilesAtChangeOptions {
  /** Depot file or pattern without a revision, for example `//depot/main/...`. */
  readonly depotPath: string;
  /** Submitted changelist whose state is listed. */
  readonly change: number;
  /** Most revisions to return. */
  readonly limit: number;
}

/** An exact file revision that existed at a changelist. */
export interface P4DepotFileRevision {
  readonly depotFile: P4DepotPath;
  readonly revision: number;
  /** Changelist that submitted the revision. */
  readonly change: number;
  readonly action: P4FileAction;
  /** File type, with modifiers. */
  readonly type: string;
}

/** Revisions at a changelist. */
export interface P4DepotFileRevisionList {
  readonly items: P4DepotFileRevision[];
  readonly messages: P4Message[];
  /** Whether more revisions exist beyond `limit`. */
  readonly hasMore: boolean;
}

const FileType = Schema.NonEmptyString;

function toDepotFileRevision(row: Row): P4DepotFileRevision {
  return {
    depotFile: depotPath(row.depotFile, row),
    revision: positive(row.rev, row),
    change: positive(row.change, row),
    action: action(row.action, row),
    type: decodeField(FileType, row.type, row),
  };
}

/**
 * List the exact revisions under a depot path when a submitted changelist was
 * created, with `p4 files -e`, so deleted, purged and archived revisions are
 * left out. A path with no files at that changelist lists nothing.
 *
 * @returns Revisions, bounded by `limit`.
 */
export const listDepotFilesAtChange = operation<
  ListDepotFilesAtChangeOptions, P4DepotFileRevision, P4DepotFileRevisionList
>('listDepotFilesAtChange', (options, sink) =>
  Effect.gen(function* () {
    const limit = yield* requirePositive(options.limit, 'limit');
    if (limit >= Number.MAX_SAFE_INTEGER) {
      return yield* invalid('limit', 'limit must be smaller than Number.MAX_SAFE_INTEGER.');
    }
    const changeNumber = yield* requirePositive(options.change, 'change');
    if (!options.depotPath.startsWith('//') || /[#@]/.test(options.depotPath)) {
      return yield* invalid('depotPath', 'depotPath must use depot syntax without a revision specifier.');
    }
    const args = ['files', '-e', '-m', String(limit + 1), `${options.depotPath}@${changeNumber}`];
    const output = yield* drainAll(
      sink,
      { args, format: 'json', decode: toDepotFileRevision },
      progressCounter(sink, 'files', limit),
      upTo(limit),
    );
    return {
      items: output.items.slice(0, limit),
      messages: output.messages,
      hasMore: output.items.length > limit,
    };
  }));

/** Options for {@link statFiles}. */
export interface StatFilesOptions {
  /** Depot, client or local file specs, with wildcards as needed. */
  readonly fileSpec: FileSpecs;
  /**
   * Only these `fstat` fields (`fstat -T`); `depotFile` is always added. Fields
   * left out read as `null` (or `false`, `[]`).
   */
  readonly fields?: readonly string[] | undefined;
  /** Also read `fileSize` and `digest` (`fstat -Ol`), which the server must compute. */
  readonly includeFileSize?: boolean | undefined;
  /** Stat the files as they were at this submitted changelist. */
  readonly atChange?: number | undefined;
  /** Most files to return (`fstat -m`). */
  readonly limit?: number | undefined;
}

/** A file's depot, workspace and open state, from `p4 fstat`. */
export interface P4FileStat {
  readonly depotFile: P4DepotPath;
  /** Local path, when the file maps into the workspace. */
  readonly localFile: P4LocalPath | null;
  /** Whether the file maps into the workspace view. */
  readonly isMapped: boolean;
  readonly headAction: P4FileAction | null;
  readonly headType: string | null;
  readonly headRevision: number | null;
  readonly headChange: number | null;
  /** Head submission time, as ISO 8601. */
  readonly headTime: string | null;
  /** Revision the workspace has, or `null` when it has none. */
  readonly haveRevision: number | null;
  /** Head size in bytes; only with `includeFileSize`. */
  readonly fileSize: number | null;
  /** Head content digest; only with `includeFileSize`. */
  readonly digest: string | null;
  /** Whether the head revision is a delete, move/delete, archive or purge. */
  readonly isDeletedAtHead: boolean;
  /** Whether the workspace has the file at an older revision than head, or head deleted it. */
  readonly isOutOfDate: boolean;
  /** Whether the head file type is non-text. */
  readonly isBinary: boolean;
  /** How this workspace has the file open, or `null`. */
  readonly openAction: P4FileAction | null;
  /** Changelist this workspace has the file open in, or `null`. */
  readonly openChange: number | 'default' | null;
  /** File type the file is open as, or `null`. */
  readonly openType: string | null;
  /** Whether the open file needs resolving. */
  readonly isUnresolved: boolean;
  /** `user@client` of each other workspace that has the file open. */
  readonly otherOpen: string[];
  /** Whether another workspace has the file locked. */
  readonly otherLocked: boolean;
}

/** File state for several specs, with the specs that matched nothing. */
export interface P4FileStatList {
  readonly items: P4FileStat[];
  readonly messages: P4Message[];
  /** One message per spec that matched no file, revision or view. */
  readonly failures: P4ItemFailure[];
}

function toFileStat(row: Row): P4FileStat {
  const headAction = optionalAction(row.headAction, row);
  const headType = text(row.headType);
  const headRevision = integer(row.headRev, row);
  const haveRevision = integer(row.haveRev, row);
  const isDeletedAtHead = isDeleteAction(headAction);
  const openAction = optionalAction(row.action, row);
  const keys = Object.keys(row);
  return {
    depotFile: depotPath(row.depotFile, row),
    localFile: localPath(row.clientFile, row),
    isMapped: row.isMapped !== undefined,
    headAction,
    headType,
    headRevision,
    headChange: integer(row.headChange, row),
    headTime: isoFromSeconds(row.headTime),
    haveRevision,
    fileSize: integer(row.fileSize, row),
    digest: text(row.digest),
    isDeletedAtHead,
    isOutOfDate: haveRevision !== null && (isDeletedAtHead || (headRevision !== null && haveRevision < headRevision)),
    isBinary: isBinaryType(headType),
    openAction,
    openChange: openAction !== null && row.change !== undefined ? change(row.change, row) : null,
    openType: openAction === null ? null : text(row.type),
    isUnresolved: row.unresolved !== undefined,
    otherOpen: keys.filter((key) => /^otherOpen\d+$/.test(key)).flatMap((key) => text(row[key]) ?? []),
    otherLocked: keys.some((key) => /^otherLock\d*$/.test(key)),
  };
}

/**
 * Read depot, workspace and open state of files with one `p4 fstat`. A spec
 * that matches nothing is reported in `failures` and does not fail the others.
 *
 * @returns File state, with one failure per spec that matched nothing.
 */
export const statFiles = operation<StatFilesOptions, P4FileStat, P4FileStatList>('statFiles', (options, sink) =>
  Effect.gen(function* () {
    const specs = specList(options.fileSpec);
    const limit = options.limit === undefined ? undefined : yield* requirePositive(options.limit, 'limit');
    const scoped: string[] = [];
    for (const spec of specs) scoped.push(yield* atChange(spec, options.atChange));
    if (scoped.length === 0) return { items: [], messages: [], failures: [] };
    const args = ['fstat'];
    if (options.includeFileSize) args.push('-Ol');
    if (limit !== undefined) args.push('-m', String(limit));
    if (options.fields !== undefined && options.fields.length > 0) {
      args.push('-T', [...new Set(['depotFile', ...options.fields])].join(' '));
    }
    args.push(...scoped);
    const output = yield* drainAll(
      sink,
      { args, format: 'json', policy: FILE_SPEC_POLICY, decode: toFileStat },
      progressCounter(sink, 'files', limit ?? null),
    );
    return { items: output.items, messages: output.messages, failures: output.failures.map(itemFailure) };
  }));

/** Options for {@link whereFiles}. */
export interface WhereFilesOptions {
  /** Depot, client or local file specs to map. */
  readonly fileSpec: FileSpecs;
}

/** Where a file spec maps in depot, client and local syntax. */
export interface P4WhereMapping {
  /** Depot path, for example `//depot/main/foo.txt`. */
  readonly depotFile: P4DepotPath;
  /** Client path, for example `//workspace/foo.txt`. */
  readonly clientFile: P4ClientPath | null;
  /** Local path, for example `C:\ws\foo.txt`. */
  readonly localFile: P4LocalPath | null;
  /** Whether this row is an exclusion (a `-` line of the view), which unmaps rather than maps. */
  readonly isExcluded: boolean;
}

/** Mappings for several specs, with the specs outside the workspace view. */
export interface P4WhereMappingList {
  readonly items: P4WhereMapping[];
  readonly messages: P4Message[];
  /** One message per spec outside the workspace view. */
  readonly failures: P4ItemFailure[];
}

function unexcluded(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === null ? null : trimmed.replace(/^-/, '');
}

function toWhereMapping(row: Row): P4WhereMapping {
  const client = unexcluded(row.clientFile);
  return {
    depotFile: depotPath(unexcluded(row.depotFile), row),
    clientFile: client === null ? null : decodeField(P4ClientPathSchema, client, row),
    localFile: localPath(unexcluded(row.path), row),
    isExcluded: row.unmap !== undefined || (text(row.depotFile)?.startsWith('-') ?? false),
  };
}

/**
 * Map file specs between depot, client and local syntax with `p4 where`. A
 * view with overlapping or exclusion lines can map a spec to several rows. A
 * spec outside the workspace view is reported in `failures`.
 *
 * @returns Mappings, with one failure per spec outside the view.
 */
export const whereFiles = operation<WhereFilesOptions, P4WhereMapping, P4WhereMappingList>('whereFiles', (options, sink) =>
  Effect.gen(function* () {
    const specs = specList(options.fileSpec);
    if (specs.length === 0) return { items: [], messages: [], failures: [] };
    const output = yield* drainAll(
      sink,
      { args: ['where', ...specs], format: 'json', policy: FILE_SPEC_POLICY, decode: toWhereMapping },
      progressCounter(sink, 'files'),
    );
    return { items: output.items, messages: output.messages, failures: output.failures.map(itemFailure) };
  }));

/** Options for {@link listHaveFiles}. */
export interface ListHaveFilesOptions {
  /** Only files matching these specs. Defaults to every file the workspace has. */
  readonly fileSpec?: FileSpecs | undefined;
}

/** A file revision the workspace has. */
export interface P4HaveFile {
  readonly depotFile: P4DepotPath;
  readonly clientFile: P4ClientPath | null;
  readonly localFile: P4LocalPath | null;
  readonly haveRevision: number;
  /** When the revision was synced, as ISO 8601. */
  readonly syncedAt: string | null;
}

/** Files the workspace has, with the specs it has nothing for. */
export interface P4HaveFileList {
  readonly items: P4HaveFile[];
  readonly messages: P4Message[];
  /** One message per given spec the workspace has no file for. */
  readonly failures: P4ItemFailure[];
}

function toHaveFile(row: Row): P4HaveFile {
  const client = text(row.clientFile);
  return {
    depotFile: depotPath(row.depotFile, row),
    clientFile: client === null ? null : decodeField(P4ClientPathSchema, client, row),
    localFile: localPath(row.path, row),
    haveRevision: positive(row.haveRev, row),
    syncedAt: isoFromSeconds(row.syncTime),
  };
}

/**
 * List the file revisions the workspace has, with `p4 have`. A given spec the
 * workspace has nothing for is reported in `failures`; with no specs, an empty
 * workspace lists nothing.
 *
 * @returns Files the workspace has.
 */
export const listHaveFiles = operation<ListHaveFilesOptions, P4HaveFile, P4HaveFileList>('listHaveFiles', (options, sink) =>
  Effect.gen(function* () {
    const specs = specList(options.fileSpec);
    const output = yield* drainAll(
      sink,
      { args: ['have', ...specs], format: 'json', policy: specs.length > 0 ? FILE_SPEC_POLICY : undefined, decode: toHaveFile },
      progressCounter(sink, 'files'),
    );
    return { items: output.items, messages: output.messages, failures: output.failures.map(itemFailure) };
  }));
