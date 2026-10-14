import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  action,
  change,
  clientFile,
  description,
  integer,
  optionalDepotPath,
  specList,
  text,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { FileSpecs, Row } from './shared.js';

/** Options for {@link listOpenedFiles}. */
export interface ListOpenedFilesOptions {
  /** Files opened by this user. */
  readonly user?: string | undefined;
  /** Files opened in this workspace. Defaults to the connection's workspace. */
  readonly client?: string | undefined;
  /** Files opened in every workspace, not only the connection's. */
  readonly allClients?: boolean | undefined;
  /** Files in this changelist. */
  readonly change?: number | 'default' | undefined;
  /** Only files matching these specs. */
  readonly fileSpec?: FileSpecs | undefined;
}

/** A file opened for add, edit, delete, move or integrate. */
export interface P4OpenedFile {
  /** Depot path, or `null` for a file added outside the depot view. */
  readonly depotFile: P4DepotPath | null;
  /** Path in client syntax (`//client/...`). */
  readonly clientFile: P4ClientPath | P4LocalPath | null;
  readonly action: P4FileAction;
  readonly type: string | null;
  readonly change: number | 'default';
  /** Changelist description, when `opened` reports one. */
  readonly changeDescription: string | null;
  readonly user: string | null;
  readonly client: string | null;
  /** Revision the file was opened at. */
  readonly revision: number | null;
  /** Revision the workspace has. */
  readonly haveRevision: number | null;
  /** The other half of a move: the source of a `move/add`, the target of a `move/delete`. */
  readonly movedFile: P4DepotPath | null;
  /** Whether the file is locked by this workspace (exclusive-open file types). */
  readonly locked: boolean;
}

/** Opened files with the messages Perforce reported. */
export interface P4OpenedFileList {
  readonly items: P4OpenedFile[];
  readonly messages: P4Message[];
}

/**
 * Convert an `opened` record.
 *
 * @param row One data record.
 * @returns The opened file.
 */
export function toOpenedFile(row: Row): P4OpenedFile {
  return {
    depotFile: optionalDepotPath(row.depotFile, row),
    clientFile: clientFile(row.clientFile, row),
    action: action(row.action, row),
    type: text(row.type),
    change: row.change === undefined ? 'default' : change(row.change, row),
    changeDescription: description(row.desc),
    user: text(row.user),
    client: text(row.client),
    revision: row.rev === 'none' ? null : integer(row.rev, row),
    haveRevision: row.haveRev === 'none' ? null : integer(row.haveRev, row),
    movedFile: optionalDepotPath(row.movedFile, row),
    locked: row.ourLock !== undefined,
  };
}

/**
 * The `opened` command for some options.
 *
 * @param options What to list.
 * @returns The command spec.
 */
export function openedCommand(options: ListOpenedFilesOptions): P4CommandSpec<P4OpenedFile> {
  const args = ['opened'];
  if (options.allClients) args.push('-a');
  if (options.user !== undefined) args.push('-u', options.user);
  if (options.client !== undefined) args.push('-C', options.client);
  if (options.change !== undefined) args.push('-c', String(options.change));
  args.push(...specList(options.fileSpec));
  return { args, format: 'json', decode: toOpenedFile };
}

/**
 * List opened files.
 *
 * @returns Opened files, in the order Perforce lists them.
 */
export const listOpenedFiles = operation<ListOpenedFilesOptions, P4OpenedFile, P4OpenedFileList>('listOpenedFiles', (options, sink) =>
  Effect.map(
    drain(sink, streamCommand(openedCommand(options)), {
      item: (file) => file,
      counter: progressCounter(sink, 'files'),
    }),
    (output) => ({ items: output.items, messages: output.messages }),
  ), 'files');
