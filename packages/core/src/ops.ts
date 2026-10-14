import { annotateFile } from './commands/annotate.js';
import { listChangelists } from './commands/changelists.js';
import { describeChangelist } from './commands/describe.js';
import { diffFile, getChangelistDiffSummary } from './commands/diff.js';
import { getEnvironment } from './commands/environment.js';
import {
  listDepotDirs,
  listDepotFiles,
  listDepotFilesAtChange,
  listDepots,
  listFiles,
  listHaveFiles,
  statFiles,
  whereFiles,
} from './commands/files.js';
import { getFileHistory } from './commands/history.js';
import { listOpenedFiles } from './commands/opened.js';
import { printBatch, printFile } from './commands/print.js';
import { runTagged } from './commands/raw.js';
import { previewReconcile } from './commands/reconcile.js';
import { getStream, listStreams } from './commands/streams.js';
import { previewSync, sync } from './commands/sync.js';
import { listUsers } from './commands/users.js';
import { listWorkspaces } from './commands/workspaces.js';
import type { Effect } from 'effect';
import type { P4Sink } from './engine/operation.js';

/**
 * Every platform-neutral operation, by method name.
 *
 * The `P4` service and the Promise client are derived from this registry, so
 * an operation added here is available in both. Operations that need Node,
 * such as `materializeDepotFiles` and `findWorkspaceForPath`, live in
 * `p4client-ts/node`.
 */
export const ops = {
  getEnvironment,
  listWorkspaces,
  listChangelists,
  listOpenedFiles,
  describeChangelist,
  getChangelistDiffSummary,
  diffFile,
  listDepots,
  listDepotDirs,
  listDepotFiles,
  listFiles,
  listDepotFilesAtChange,
  statFiles,
  whereFiles,
  listHaveFiles,
  getFileHistory,
  annotateFile,
  printFile,
  printBatch,
  listUsers,
  listStreams,
  getStream,
  previewSync,
  sync,
  previewReconcile,
  runTagged,
} as const;

/** The operation registry's type. */
export type P4Ops = typeof ops;

/** Options of an operation in the registry. */
export type OpOptions<K extends keyof P4Ops> = Parameters<P4Ops[K]['program']>[0];

/** Items an operation in the registry reports while it runs. */
export type OpItem<K extends keyof P4Ops> = Parameters<P4Ops[K]['program']>[1] extends P4Sink<infer I> ? I : never;

/** Result of an operation in the registry. */
export type OpResult<K extends keyof P4Ops> = Effect.Success<ReturnType<P4Ops[K]['program']>>;
