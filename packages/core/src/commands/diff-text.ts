import { P4InvalidArgumentError } from '../errors.js';

/**
 * Pure helpers for unified diffs and for choosing what a file diff compares.
 *
 * Nothing here runs `p4`; the functions throw `P4InvalidArgumentError` for
 * options that cannot describe a diff.
 */

/** Whether a diff compared the workspace file or two depot revisions. */
export type P4DiffSource = 'workspace' | 'depot';

/** A revision as `diffFile` accepts it: a number, `none`, `have`, `head`, or a `#`/`@` specifier. */
export type P4RevisionSpec = string | number;

/** One hunk of a unified diff. */
export interface P4DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Body lines, including the context, `+` and `-` prefixes. */
  readonly lines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const NON_TEXT_BASE_TYPES = new Set(['binary', 'apple', 'resource', 'xb', 'xbinary']);

/**
 * Whether a Perforce file type holds non-text content.
 *
 * Recognizes the base types `binary`, `apple` and `resource`, the historical
 * `xb`/`xbinary` spellings, and `+` modifiers (for example `binary+F`).
 *
 * @param type A file type, such as `text+k` or `binary+F`.
 * @returns `true` for non-text types; `false` for text types and a missing type.
 */
export function isBinaryP4Type(type: string | null | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  const base = normalized.split('+', 1)[0] ?? normalized;
  return NON_TEXT_BASE_TYPES.has(base) || base.includes('binary') || base.includes('xb');
}

/**
 * Count the added and deleted lines of a unified diff.
 *
 * Only lines inside a hunk count, so `---`/`+++` file headers do not.
 *
 * @param diff Unified diff text.
 * @returns Added and deleted line counts.
 */
export function summarizeUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of diff.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
    } else if (line.startsWith('+') && newRemaining > 0) {
      additions += 1;
      newRemaining -= 1;
    } else if (line.startsWith('-') && oldRemaining > 0) {
      deletions += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(' ')) {
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
    }
  }
  return { additions, deletions };
}

/**
 * Split a unified diff into hunks. Text before the first hunk is ignored.
 *
 * @param diff Unified diff text.
 * @returns The hunks in order.
 */
export function parseUnifiedDiff(diff: string): P4DiffHunk[] {
  const hunks: P4DiffHunk[] = [];
  let current: P4DiffHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newLines: header[4] ? Number(header[4]) : 1,
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Whether text contains at least one unified diff hunk.
 *
 * @param diff Diff output.
 * @returns `true` when a hunk header is present.
 */
export function hasUnifiedHunk(diff: string): boolean {
  return /^@@ -\d/m.test(diff);
}

/**
 * A file spec at a revision.
 *
 * @param file Depot path, without a revision.
 * @param revision A number, `none`, `have`, `head`, or a specifier starting with `#` or `@`.
 * @returns For example `//d/a.txt#3`, `//d/a.txt#none` or `//d/a.txt@=7`.
 */
export function fileAtRevision(file: string, revision: P4RevisionSpec): string {
  const text = String(revision);
  if (text.toLowerCase() === 'none') return `${file}#none`;
  if (text.startsWith('#') || text.startsWith('@')) return `${file}${text}`;
  return `${file}#${text}`;
}

/** Revisions compared for a file of a submitted or shelved changelist. */
export interface P4DiffRevisions {
  readonly fromRevision: P4RevisionSpec;
  readonly toRevision: P4RevisionSpec;
}

/**
 * Infer the revisions to compare for a file of a submitted changelist.
 *
 * @param file The file's action and submitted revision.
 * @returns The revisions, or `null` when the action does not imply a comparison.
 */
export function submittedDiffRevisions(file: {
  readonly action: string;
  readonly revision: number | null;
}): P4DiffRevisions | null {
  const action = file.action.toLowerCase();
  const revision = file.revision;
  if (action === 'add' || action === 'move/add' || action === 'branch') {
    return { fromRevision: 'none', toRevision: revision ?? 'have' };
  }
  if (revision === null || revision <= 1) return null;
  if (action === 'delete' || action === 'move/delete') return { fromRevision: revision - 1, toRevision: 'none' };
  if (action === 'edit' || action === 'integrate') return { fromRevision: revision - 1, toRevision: revision };
  return null;
}

/**
 * Infer the revisions to compare for a file of a shelved changelist.
 *
 * `describe -S` reports the depot revision a shelved file is based on; the
 * shelved content is addressed as `@=change`.
 *
 * @param file The file and the shelving changelist.
 * @returns The revisions.
 * @throws {P4InvalidArgumentError} When the action or base revision does not allow a comparison.
 */
export function shelvedDiffRevisions(file: {
  readonly depotFile: string;
  readonly action: string;
  readonly revision: number | null;
  readonly shelvedChange: number;
}): P4DiffRevisions {
  const action = file.action.toLowerCase();
  const revision = file.revision;
  const shelf = `@=${file.shelvedChange}`;
  if (action === 'add' || action === 'move/add') return { fromRevision: 'none', toRevision: shelf };
  if (action === 'delete' || action === 'move/delete') {
    if (revision === null) {
      throw new P4InvalidArgumentError({
        message: `Unable to infer the base revision of shelved delete ${file.depotFile}.`,
        option: 'revision',
      });
    }
    return { fromRevision: revision, toRevision: 'none' };
  }
  if (action === 'edit' || action === 'integrate' || action === 'branch') {
    if (revision === null || revision < 1) {
      throw new P4InvalidArgumentError({
        message: `Unable to infer the base revision of shelved file ${file.depotFile}.`,
        option: 'revision',
      });
    }
    return { fromRevision: revision, toRevision: shelf };
  }
  throw new P4InvalidArgumentError({
    message: `Unable to infer revisions for shelved ${action} file ${file.depotFile}.`,
    option: 'action',
  });
}

/** What a file diff compares; see {@link resolveDiffPlan}. */
export interface P4DiffPlanOptions {
  /** Depot file to compare. */
  readonly file: string;
  /** Compare these two depot revisions. Requires `toRevision`. */
  readonly fromRevision?: P4RevisionSpec | undefined;
  readonly toRevision?: P4RevisionSpec | undefined;
  /**
   * `submitted` or `shelved` compare depot revisions inferred from `action`
   * and `revision`; `pending` (the default) compares the workspace file with
   * the revision it was opened at.
   */
  readonly changelistStatus?: 'pending' | 'submitted' | 'shelved' | undefined;
  /** The file's action in the changelist. Defaults to `edit`. */
  readonly action?: string | undefined;
  /** The file's revision in the changelist. */
  readonly revision?: number | null | undefined;
  /** The shelving changelist, required for `shelved`. */
  readonly shelvedChange?: number | undefined;
  /** Diff options. Defaults to `['-du']` (unified). */
  readonly diffFlags?: readonly string[] | undefined;
}

/** The command a file diff runs. */
export interface P4DiffPlan {
  readonly source: P4DiffSource;
  readonly command: 'diff' | 'diff2';
  /** Arguments after the subcommand. */
  readonly args: string[];
  readonly fromRevision: P4RevisionSpec | null;
  readonly toRevision: P4RevisionSpec | null;
}

function depotPlan(options: P4DiffPlanOptions, revisions: P4DiffRevisions, flags: readonly string[]): P4DiffPlan {
  return {
    source: 'depot',
    command: 'diff2',
    args: [
      ...flags,
      fileAtRevision(options.file, revisions.fromRevision),
      fileAtRevision(options.file, revisions.toRevision),
    ],
    fromRevision: revisions.fromRevision,
    toRevision: revisions.toRevision,
  };
}

/**
 * Decide whether a file diff compares the workspace (`p4 diff`) or two depot
 * revisions (`p4 diff2`).
 *
 * @param options The file and what to compare.
 * @returns The command and the revisions it compares.
 * @throws {P4InvalidArgumentError} When only one revision is given, a shelved
 * diff has no `shelvedChange`, or the revisions cannot be inferred.
 */
export function resolveDiffPlan(options: P4DiffPlanOptions): P4DiffPlan {
  const flags = options.diffFlags ?? ['-du'];
  const { fromRevision, toRevision } = options;
  if ((fromRevision === undefined) !== (toRevision === undefined)) {
    throw new P4InvalidArgumentError({
      message: 'A depot-to-depot diff needs both fromRevision and toRevision.',
      option: fromRevision === undefined ? 'fromRevision' : 'toRevision',
    });
  }
  if (fromRevision !== undefined && toRevision !== undefined) {
    return depotPlan(options, { fromRevision, toRevision }, flags);
  }
  const action = options.action ?? 'edit';
  const revision = options.revision ?? null;
  if (options.changelistStatus === 'shelved') {
    if (options.shelvedChange === undefined) {
      throw new P4InvalidArgumentError({
        message: 'A shelved diff needs shelvedChange.',
        option: 'shelvedChange',
      });
    }
    return depotPlan(options, shelvedDiffRevisions({
      depotFile: options.file, action, revision, shelvedChange: options.shelvedChange,
    }), flags);
  }
  if (options.changelistStatus === 'submitted') {
    const revisions = submittedDiffRevisions({ action, revision });
    if (revisions === null) {
      throw new P4InvalidArgumentError({
        message: `Unable to infer revisions for submitted ${action} file ${options.file}#${String(revision)}.`,
        option: 'revision',
      });
    }
    return depotPlan(options, revisions, flags);
  }
  return {
    source: 'workspace',
    command: 'diff',
    args: [...flags, options.file],
    fromRevision: null,
    toRevision: null,
  };
}
