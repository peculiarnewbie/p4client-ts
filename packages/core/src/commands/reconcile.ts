import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  action,
  change,
  clientFile,
  integer,
  invalid,
  malformed,
  optionalDepotPath,
  specList,
  text,
} from './shared.js';
import type { P4CommandSpec } from '../engine/command.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { FileSpecs, Row } from './shared.js';

/** Options for {@link previewReconcile}. */
export interface PreviewReconcileOptions {
  /** Files to reconcile. Takes precedence over `workspace`. */
  readonly fileSpec?: FileSpecs | undefined;
  /** Without `fileSpec`, reconcile everything under this workspace's root. */
  readonly workspace?: { readonly root: string } | undefined;
  /** Changelist the files would be opened in (`-c`). */
  readonly change?: number | 'default' | undefined;
  /** Pass `-m`: compare modification times before content, which is faster. */
  readonly useModTime?: boolean | undefined;
  /** Pass `-w`: also consider writable files that are not opened. */
  readonly includeWritable?: boolean | undefined;
}

/** How reconcile would open a file. */
export type P4ReconcileAction = 'add' | 'edit' | 'delete' | 'move/add' | 'move/delete';

/** A file reconcile would open. */
export interface P4ReconcileCandidate {
  readonly depotFile: P4DepotPath | null;
  /** The workspace file, usually as a local path. */
  readonly clientFile: P4ClientPath | P4LocalPath | null;
  readonly action: P4ReconcileAction;
  readonly type: string | null;
  /** Changelist it would be opened in, when Perforce reports one. */
  readonly change: number | 'default' | null;
  /** Revision of the workspace file. */
  readonly workRevision: number | null;
}

/**
 * What reconcile would open, in output order and grouped by action. Moves
 * are grouped with adds (`move/add`) and deletes (`move/delete`).
 */
export interface P4ReconcilePreview {
  readonly items: P4ReconcileCandidate[];
  readonly added: P4ReconcileCandidate[];
  readonly edited: P4ReconcileCandidate[];
  readonly deleted: P4ReconcileCandidate[];
  readonly messages: P4Message[];
}

const ACTIONS: ReadonlySet<string> = new Set<P4ReconcileAction>(['add', 'edit', 'delete', 'move/add', 'move/delete']);

/**
 * Convert a `reconcile -n` record.
 *
 * @param row One data record.
 * @returns The candidate.
 */
export function toReconcileCandidate(row: Row): P4ReconcileCandidate {
  const decoded: P4FileAction = action(row.action, row);
  if (!ACTIONS.has(decoded)) throw malformed(`Unsupported reconcile action "${decoded}".`, row);
  return {
    depotFile: optionalDepotPath(row.depotFile, row),
    clientFile: clientFile(row.clientFile, row),
    action: decoded as P4ReconcileAction,
    type: text(row.type),
    change: row.change === undefined ? null : change(row.change, row),
    workRevision: integer(row.workRev, row),
  };
}

/**
 * The file spec for everything under a workspace root.
 *
 * @param root The workspace root.
 * @returns `<root>/...` with forward slashes.
 */
export function workspaceRootFileSpec(root: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/...`;
}

function reconcileCommand(options: PreviewReconcileOptions, specs: string[]): P4CommandSpec<P4ReconcileCandidate> {
  const args = ['reconcile', '-n'];
  if (options.change !== undefined) args.push('-c', String(options.change));
  if (options.useModTime) args.push('-m');
  if (options.includeWritable) args.push('-w');
  args.push(...specs);
  return { args, format: 'json', decode: toReconcileCandidate };
}

/**
 * Preview `p4 reconcile -n`: the files reconcile would open for add, edit or
 * delete. Never opens anything.
 *
 * Candidates are reported as they arrive, with an indeterminate file count:
 * `reconcile -I` prints no progress through a pipe, so none is requested.
 *
 * @returns The candidates, in output order and grouped by action.
 * @throws {P4InvalidArgumentError} When `workspace` has an empty root.
 */
export const previewReconcile = operation<PreviewReconcileOptions, P4ReconcileCandidate, P4ReconcilePreview>(
  'previewReconcile',
  (options, sink) => Effect.gen(function* () {
    let specs = specList(options.fileSpec);
    if (options.fileSpec === undefined && options.workspace !== undefined) {
      if (!options.workspace.root.trim()) return yield* invalid('workspace', 'The workspace has no root.');
      specs = [workspaceRootFileSpec(options.workspace.root)];
    }
    const output = yield* drain(sink, streamCommand(reconcileCommand(options, specs)), {
      item: (candidate) => candidate,
      counter: progressCounter(sink, 'files'),
    });
    const result: P4ReconcilePreview = {
      items: output.items,
      added: output.items.filter((item) => item.action === 'add' || item.action === 'move/add'),
      edited: output.items.filter((item) => item.action === 'edit'),
      deleted: output.items.filter((item) => item.action === 'delete' || item.action === 'move/delete'),
      messages: output.messages,
    };
    return result;
  }),
  'files',
);
