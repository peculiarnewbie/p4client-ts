import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  clientFile,
  integer,
  itemFailure,
  malformed,
  optionalAction,
  optionalDepotPath,
  specList,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4ProgressCounter, P4Sink } from '../engine/operation.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { P4Reason } from '../wire/reasons.js';
import type { FileSpecs, P4ItemFailure, Row } from './shared.js';

/** Options for {@link previewSync} and {@link sync}. */
export interface SyncOptions {
  /** Files to bring up to date. Defaults to the whole workspace. */
  readonly fileSpec?: FileSpecs | undefined;
  /** Pass `-f`: rewrite files the workspace already has, except writable ones. */
  readonly force?: boolean | undefined;
  /** Pass `-k`: update the workspace's have list without touching its files. */
  readonly keepWorkspaceFiles?: boolean | undefined;
}

/** A file `sync` updated, or would update. */
export interface P4SyncItem {
  /** Depot path, when Perforce reports one. */
  readonly depotFile: P4DepotPath | null;
  /** The workspace file, usually as a local path. */
  readonly clientFile: P4ClientPath | P4LocalPath | null;
  /** Revision the workspace gets. */
  readonly revision: number | null;
  /** What happens to the workspace file: `added`, `updated`, `refreshed`, `deleted` and so on. */
  readonly action: P4FileAction | null;
  /** Changelist of the revision. */
  readonly change: number | null;
  /** Size of the revision in bytes. */
  readonly fileSize: number | null;
}

/** A file `sync` could not update, which does not fail the sync. */
/** A file that could not be synced. */
export type P4SyncFailure = P4ItemFailure;

/** What `sync` updated, or would update. */
export interface P4SyncResult {
  readonly items: P4SyncItem[];
  /** Files that could not be updated: clobbered writable files, filesystem errors, files outside the view. */
  readonly failures: P4SyncFailure[];
  readonly messages: P4Message[];
  /** Files Perforce announced it would transfer, or `null` when nothing needed syncing. */
  readonly totalFileCount: number | null;
  /** Bytes Perforce announced it would transfer, or `null` when nothing needed syncing. */
  readonly totalFileSize: number | null;
}

/**
 * Messages that concern one file rather than the sync: a writable file in
 * the way, an operating-system error writing a file, and a file spec
 * outside the workspace view.
 */
export const SYNC_POLICY: P4MessagePolicy = {
  clobber: 'item',
  filesystem: 'item',
  fault: 'item',
  client_fault: 'item',
  not_in_view: 'item',
};


interface SyncRecord {
  readonly item: P4SyncItem;
  /** Announced on the first record only. */
  readonly totalFileCount: number | null;
  readonly totalFileSize: number | null;
}

/**
 * Convert a `sync` record.
 *
 * @param row One data record.
 * @returns The synced file.
 */
export function toSyncItem(row: Row): P4SyncItem {
  const item: P4SyncItem = {
    depotFile: optionalDepotPath(row.depotFile, row),
    clientFile: clientFile(row.clientFile, row),
    revision: integer(row.rev, row),
    action: optionalAction(row.action, row),
    change: integer(row.change, row),
    fileSize: integer(row.fileSize, row),
  };
  if (item.depotFile === null && item.action === null) throw malformed('A sync record names no file or action.', row);
  return item;
}

function syncCommand(options: SyncOptions, preview: boolean): P4CommandSpec<SyncRecord> {
  const args = ['sync'];
  if (preview) args.push('-n');
  if (options.force) args.push('-f');
  if (options.keepWorkspaceFiles) args.push('-k');
  args.push(...specList(options.fileSpec));
  return {
    args,
    format: 'json',
    policy: SYNC_POLICY,
    decode: (row) => ({
      item: toSyncItem(row),
      totalFileCount: integer(row.totalFileCount, row),
      totalFileSize: integer(row.totalFileSize, row),
    }),
  };
}

function runSync(options: SyncOptions, preview: boolean, sink: P4Sink<P4SyncItem>) {
  return Effect.gen(function* () {
    const counter = progressCounter(sink, 'files');
    let bytes: number | undefined;
    let totals: { files: number | null; bytes: number | null } = { files: null, bytes: null };
    // Each file advances the count by one and the bytes by its size.
    const perFile: P4ProgressCounter = { ...counter, advance: () => counter.advance(1, bytes) };
    const output = yield* drain(sink, streamCommand(syncCommand(options, preview)), {
      item: (record) => record.item,
      counter: perFile,
      inspect: (record) => {
        if (record.totalFileCount !== null && totals.files === null) {
          totals = { files: record.totalFileCount, bytes: record.totalFileSize };
          counter.expect(totals.files, totals.bytes);
        }
        bytes = record.item.fileSize ?? undefined;
      },
    });
    const result: P4SyncResult = {
      items: output.items.map((record) => record.item),
      failures: output.failures.map(itemFailure),
      messages: output.messages,
      totalFileCount: totals.files,
      totalFileSize: totals.bytes,
    };
    return result;
  });
}

/**
 * Preview a sync with `p4 sync -n`: the files it would update, without
 * changing the workspace.
 *
 * Progress is determinate: Perforce announces the file count and size with
 * the first file. Files that could not be synced are `failures`, not errors.
 *
 * @returns The files a sync would update, and those it could not.
 */
export const previewSync = operation<SyncOptions, P4SyncItem, P4SyncResult>('previewSync', (options, sink) =>
  runSync(options, true, sink));

/**
 * Sync workspace files with `p4 sync`.
 *
 * This changes the workspace, so the client must be created with
 * `allowMutation: true`; otherwise it fails with `P4ReadOnlyError`. Progress
 * is determinate, in files and bytes. A file that cannot be written (a
 * writable file in the way, an operating-system error) is reported in
 * `failures` and does not fail the sync.
 *
 * @returns The files synced, and those that could not be.
 * @throws {P4ReadOnlyError} When the client does not allow mutation.
 */
export const sync = operation<SyncOptions, P4SyncItem, P4SyncResult>('sync', (options, sink) =>
  runSync(options, false, sink));
