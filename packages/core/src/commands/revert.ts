import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import {
  clientFile,
  integer,
  invalid,
  itemFailure,
  optionalAction,
  optionalDepotPath,
  requirePositive,
  specList,
  text,
} from './shared.js';
import type { P4Sink } from '../engine/operation.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { FileSpecs, P4ItemFailure, Row } from './shared.js';

/** Options for {@link revert} and {@link previewRevert}. Give `fileSpec`, `change`, or both. */
export interface RevertOptions {
  /** Files to revert. With only `change`, every file open in it (`//...`). */
  readonly fileSpec?: FileSpecs | undefined;
  /** Only files open in this changelist (`-c`). */
  readonly change?: number | 'default' | undefined;
}

/** A file `revert` reverted, or would revert. */
export interface P4RevertedFile {
  readonly depotFile: P4DepotPath | null;
  /** The workspace file, usually as a local path. */
  readonly clientFile: P4ClientPath | P4LocalPath | null;
  /**
   * What happened to it: `reverted` for an opened file restored to its
   * synced revision, `abandoned` for a file that was open for add (the
   * workspace file is kept), and so on.
   */
  readonly action: string;
  /** How the file was open. */
  readonly previousAction: P4FileAction | null;
  /** Revision the workspace has afterwards, or `null` for an abandoned add. */
  readonly haveRevision: number | null;
}

/** What `revert` reverted, or would revert. */
export interface P4RevertResult {
  readonly items: P4RevertedFile[];
  /** Specs outside the workspace view or matching no file. */
  readonly failures: P4ItemFailure[];
  /** Notices, including `not_opened` when nothing matched. */
  readonly messages: P4Message[];
}

const REVERT_POLICY: P4MessagePolicy = { not_in_view: 'item', no_such_file: 'item' };

function toRevertedFile(row: Row): P4RevertedFile {
  return {
    depotFile: optionalDepotPath(row.depotFile, row),
    clientFile: clientFile(row.clientFile, row),
    action: text(row.action) ?? 'reverted',
    previousAction: optionalAction(row.oldAction, row),
    haveRevision: row.haveRev === 'none' ? null : integer(row.haveRev, row),
  };
}

// Untraced: the whole body of revert and previewRevert, which have their own spans.
const runRevert = Effect.fnUntraced(function* (
  options: RevertOptions,
  preview: boolean,
  sink: P4Sink<P4RevertedFile>,
) {
  const args = ['revert'];

  if (preview) args.push('-n');

  if (options.change !== undefined) {
    args.push('-c', options.change === 'default' ? 'default' : String(yield* requirePositive(options.change, 'change')));
  }

  const specs = specList(options.fileSpec);

  if (specs.length === 0) {
    if (options.change === undefined) {
      return yield* invalid('fileSpec', 'revert needs fileSpec, change, or both; it never reverts everything implicitly.');
    }

    specs.push('//...');
  }

  const output = yield* drain(sink, streamCommand({
    args: [...args, ...specs],
    format: 'json',
    policy: REVERT_POLICY,
    decode: toRevertedFile,
  }), { item: (file) => file, counter: progressCounter(sink, 'files') });

  const result: P4RevertResult = {
    items: output.items,
    failures: output.failures.map(itemFailure),
    messages: output.messages,
  };

  return result;
});

/**
 * Revert open files with `p4 revert`, discarding their workspace changes. Needs `allowMutation`.
 * `change` alone reverts everything open in that changelist. Files open for add stay on disk.
 * Nothing open is a `not_opened` message, not an error.
 */
export const revert = operation<RevertOptions, P4RevertedFile, P4RevertResult>('revert', (options, sink) =>
  runRevert(options, false, sink), 'files');

/**
 * Preview {@link revert} with `p4 revert -n`: what would be reverted, without
 * changing anything.
 */
export const previewRevert = operation<RevertOptions, P4RevertedFile, P4RevertResult>('previewRevert', (options, sink) =>
  runRevert(options, true, sink), 'files');
