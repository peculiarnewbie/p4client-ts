import { Effect, Schema } from 'effect';
import { runCommand, runPlainCommand } from '../engine/command.js';
import { operation, progressCounter, runOperation } from '../engine/operation.js';
import { P4InvalidArgumentError } from '../errors.js';
import { P4DepotPathSchema, P4LocalPathSchema } from '../schemas.js';
import { describeChangelist } from './describe.js';
import { hasUnifiedHunk, isBinaryP4Type, resolveDiffPlan, summarizeUnifiedDiff } from './diff-text.js';
import { openedCommand } from './opened.js';
import { invalid, localPath, requirePositive, text } from './shared.js';
import type { P4Context } from '../engine/operation.js';
import type { P4Error } from '../errors.js';
import type { P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4ChangelistDescription, P4DescribedFile } from './describe.js';
import type { P4DiffPlan, P4DiffPlanOptions, P4DiffSource, P4RevisionSpec } from './diff-text.js';
import type { P4OpenedFile } from './opened.js';
import type { Row } from './shared.js';

/**
 * Options for {@link diffFile}.
 *
 * Give `fromRevision` and `toRevision` to compare two depot revisions;
 * otherwise `changelistStatus` decides: `submitted` and `shelved` compare
 * depot revisions inferred from `action` and `revision`, and `pending` (the
 * default) compares the workspace file with the revision it was opened at.
 */
export interface DiffFileOptions extends P4DiffPlanOptions {
  /** Local path reported in the result when Perforce does not report one. Not passed to Perforce. */
  readonly localFile?: string | undefined;
  /**
   * When `false`, a file whose `type` is binary returns an empty diff with
   * `isBinary: true` without running Perforce. Defaults to `true`.
   */
  readonly allowBinary?: boolean | undefined;
  /** The file's type, used with `allowBinary: false`. */
  readonly type?: string | null | undefined;
}

/** A unified diff of one file. */
export interface P4FileDiff {
  readonly depotFile: P4DepotPath;
  readonly localFile: P4LocalPath | null;
  readonly source: P4DiffSource;
  /** Start revision when `source` is `depot`. */
  readonly fromRevision: P4RevisionSpec | null;
  /** End revision when `source` is `depot`. */
  readonly toRevision: P4RevisionSpec | null;
  /**
   * Unified diff text: hunks only for a workspace diff; for a depot diff,
   * `diff2`'s `====` header line followed by the hunks. Empty when the file is
   * unchanged, binary and skipped, or not opened.
   */
  readonly unifiedDiff: string;
  readonly isBinary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly messages: P4Message[];
}

const isDepotPath = Schema.is(P4DepotPathSchema);
const isLocalPath = Schema.is(P4LocalPathSchema);

function planFor(options: P4DiffPlanOptions): Effect.Effect<P4DiffPlan, P4InvalidArgumentError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(resolveDiffPlan(options));
    } catch (error) {
      if (error instanceof P4InvalidArgumentError) return Effect.fail(error);
      throw error;
    }
  });
}

type WorkspaceDiffRow =
  | { readonly _tag: 'header'; readonly localFile: P4LocalPath | null; readonly type: string | null }
  | { readonly _tag: 'body'; readonly text: string };

function toWorkspaceDiffRow(row: Row): WorkspaceDiffRow | null {
  if (typeof row.data === 'string') return { _tag: 'body', text: row.data };
  if (row.depotFile !== undefined) return { _tag: 'header', localFile: localPath(row.clientFile, row), type: text(row.type) };
  return null;
}

const utf8 = new TextDecoder('utf-8');

/** Run a diff once its options are validated. */
function runDiff(
  depotFile: P4DepotPath,
  localFile: P4LocalPath | null,
  options: DiffFileOptions,
): Effect.Effect<P4FileDiff, P4Error, P4Context> {
  return Effect.gen(function* () {
    const plan = yield* planFor(options);
    const base = { depotFile, source: plan.source, fromRevision: plan.fromRevision, toRevision: plan.toRevision };
    if (options.allowBinary === false && isBinaryP4Type(options.type)) {
      return {
        ...base, localFile, unifiedDiff: '', isBinary: true, additions: 0, deletions: 0, messages: [],
      };
    }
    let unifiedDiff: string;
    let messages: P4Message[];
    let reportedLocal: P4LocalPath | null = null;
    if (plan.command === 'diff') {
      // `-Mj diff` sends the file as a data row, then the hunks (without ---/+++ headers) as `data` rows.
      const output = yield* runCommand({ args: ['diff', ...plan.args], format: 'json', decode: toWorkspaceDiffRow });
      unifiedDiff = output.items.map((row) => (row._tag === 'body' ? row.text : '')).join('');
      reportedLocal = output.items.find((row) => row._tag === 'header')?.localFile ?? null;
      messages = [...output.messages, ...output.failures];
    } else {
      // `-Mj`/`-G diff2` send only a header, so the hunks come from plain output.
      const output = yield* runPlainCommand({
        args: ['diff2', ...plan.args],
        // An external diff tool may exit 1 when the files differ.
        acceptExit: (code, stdout) => code === 1 && hasUnifiedHunk(utf8.decode(stdout)),
      });
      unifiedDiff = utf8.decode(output.stdout);
      messages = [...output.messages, ...output.failures];
    }
    const { additions, deletions } = summarizeUnifiedDiff(unifiedDiff);
    return {
      ...base,
      localFile: localFile ?? reportedLocal,
      unifiedDiff,
      isBinary: false,
      additions,
      deletions,
      messages,
    };
  });
}

/**
 * Diff one file as a unified diff.
 *
 * A workspace diff runs `p4 -Mj diff -du <depotFile>`; a file that is not
 * opened gives an empty diff with a `not_opened` message. A depot diff runs
 * plain `p4 diff2 -du <from> <to>`, because the structured forms of `diff2`
 * omit the hunks.
 *
 * @returns The diff with its line counts.
 * @throws {P4InvalidArgumentError} When the paths are invalid or the revisions cannot be inferred.
 */
export const diffFile = operation<DiffFileOptions, never, P4FileDiff>('diffFile', (options, sink) =>
  Effect.gen(function* () {
    if (!isDepotPath(options.depotFile)) {
      return yield* invalid('depotFile', `depotFile must be a depot path, received ${options.depotFile}.`);
    }
    const localFile = options.localFile;
    if (localFile !== undefined && !isLocalPath(localFile)) {
      return yield* invalid('localFile', `localFile must be a local path, received ${localFile}.`);
    }
    const result = yield* runDiff(options.depotFile, localFile ?? null, options);
    for (const message of result.messages) yield* sink.message(message);
    return result;
  }));

/** Options for {@link getChangelistDiffSummary}. */
export interface GetChangelistDiffSummaryOptions {
  readonly change: number | 'default';
  /** Summarize the changelist's shelved files rather than its opened ones. */
  readonly shelved?: boolean | undefined;
  /** Workspace whose files are opened in the changelist. Defaults to the connection's. */
  readonly client?: string | undefined;
  /** Diff each text file to count its lines. Defaults to `false`, which runs no diffs. */
  readonly includeLineCounts?: boolean | undefined;
  /** Diffs run at once with `includeLineCounts`. Defaults to 3. */
  readonly concurrency?: number | undefined;
}

/** One file of a changelist diff summary. */
export interface P4ChangelistDiffFileSummary {
  readonly depotFile: P4DepotPath;
  /** Workspace file, for opened files when Perforce reports a local path. */
  readonly localFile: P4LocalPath | null;
  readonly action: P4FileAction;
  readonly type: string | null;
  readonly revision: number | null;
  readonly isBinary: boolean;
  /** Added lines, or `null` without `includeLineCounts` and for binary files. */
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** A changelist's files, ready for lazily loaded diffs. */
export interface P4ChangelistDiffSummary {
  readonly changelist: P4ChangelistDescription;
  readonly files: P4ChangelistDiffFileSummary[];
  /** Messages from every command run, including the per-file diffs. */
  readonly messages: P4Message[];
}

const DEFAULT_CONCURRENCY = 3;

/** The default changelist described from its opened files, as `describeChangelist` does. */
function defaultChangelist(opened: readonly P4OpenedFile[], messages: P4Message[], client: string | undefined): P4ChangelistDescription {
  const first = opened[0];
  return {
    change: 'default',
    status: 'pending',
    user: first?.user ?? null,
    client: client ?? first?.client ?? null,
    description: first?.changeDescription ?? 'Default changelist',
    createdAt: null,
    files: opened.flatMap((file) => file.depotFile === null ? [] : [{
      depotFile: file.depotFile,
      action: file.action,
      type: file.type,
      revision: file.revision,
      digest: null,
      fileSize: null,
    }]),
    messages,
  };
}

function openedLocalFile(file: P4OpenedFile | undefined): P4LocalPath | null {
  const path = file?.clientFile ?? null;
  return path !== null && isLocalPath(path) && !path.startsWith('//') ? path : null;
}

function summarize(file: P4DescribedFile, opened: P4OpenedFile | undefined): P4ChangelistDiffFileSummary {
  const type = file.type ?? opened?.type ?? null;
  return {
    depotFile: file.depotFile,
    localFile: openedLocalFile(opened),
    action: file.action,
    type,
    revision: file.revision,
    isBinary: isBinaryP4Type(type),
    additions: null,
    deletions: null,
  };
}

/**
 * Summarize a changelist's files for a diff view, without patch bodies.
 *
 * Numbered changelists are read with `describe -s` (`-S` for shelved files),
 * plus `opened -c <change>` for a pending changelist's workspace paths. The
 * default changelist is read from a single `opened -c default`, which serves
 * as both its description and its opened files. With `includeLineCounts`,
 * each text file is diffed as {@link diffFile} would: workspace diffs for
 * pending files, depot diffs for submitted and shelved ones.
 *
 * Progress counts files against the changelist's file count; each file is
 * reported as an item when its summary is complete.
 *
 * @returns The changelist, its file summaries and every message.
 * @throws {P4InvalidArgumentError} For `shelved` with the default changelist, or an invalid `concurrency`.
 */
export const getChangelistDiffSummary = operation<
  GetChangelistDiffSummaryOptions,
  P4ChangelistDiffFileSummary,
  P4ChangelistDiffSummary
>('getChangelistDiffSummary', (options, sink) =>
  Effect.gen(function* () {
    const concurrency = yield* requirePositive(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
    const shelved = options.shelved ?? false;
    const messages: P4Message[] = [];
    let changelist: P4ChangelistDescription;
    let opened: readonly P4OpenedFile[] = [];
    if (options.change === 'default') {
      if (shelved) return yield* invalid('shelved', 'Only a numbered changelist can have shelved files.');
      const output = yield* runCommand(openedCommand({ change: 'default', client: options.client }));
      changelist = defaultChangelist(output.items, output.messages, options.client);
      opened = output.items;
      messages.push(...output.messages);
    } else {
      changelist = yield* runOperation(describeChangelist, { change: options.change, shelved });
      messages.push(...changelist.messages);
      if (!shelved && changelist.status === 'pending') {
        const output = yield* runCommand(openedCommand({ change: options.change, client: options.client }));
        opened = output.items;
        messages.push(...output.messages);
      }
    }
    for (const message of messages) yield* sink.message(message);
    const byDepotFile = new Map(opened.flatMap((file) => file.depotFile === null ? [] : [[file.depotFile, file] as const]));
    const counter = progressCounter(sink, 'files', changelist.files.length);
    const status = shelved ? 'shelved' : changelist.status === 'submitted' ? 'submitted' : 'pending';
    const shelvedChange = typeof changelist.change === 'number' ? changelist.change : undefined;

    const files = yield* Effect.forEach(changelist.files, (file) => Effect.gen(function* () {
      let summary = summarize(file, byDepotFile.get(file.depotFile));
      if (options.includeLineCounts && !summary.isBinary) {
        const diff = yield* runDiff(file.depotFile, summary.localFile, {
          depotFile: file.depotFile,
          changelistStatus: status,
          action: file.action,
          revision: file.revision,
          shelvedChange,
        });
        messages.push(...diff.messages);
        for (const message of diff.messages) yield* sink.message(message);
        summary = { ...summary, localFile: diff.localFile, additions: diff.additions, deletions: diff.deletions };
      }
      yield* sink.item(summary);
      yield* counter.advance(1);
      return summary;
    }), { concurrency: options.includeLineCounts ? concurrency : 1 });

    return { changelist, files, messages };
  }));
