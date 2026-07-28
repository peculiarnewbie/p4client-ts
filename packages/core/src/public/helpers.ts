import { existsSync } from "node:fs";
import { Schema } from "effect";
import { P4ParseError } from "./errors.js";
import type {
  DiffFileOptions,
  LocalWorkspaceCandidate,
  P4DiffHunk,
  P4DiffSource,
  P4ProgressSnapshot
} from "./types.js";

const P4TaggedJsonRowSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Parse classic `p4 info`-style `Key: Value` output into an object map.
 *
 * Lines that do not match the `key: value` shape are ignored.
 */
export function parseP4KeyValueOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = /^([^:]+):\s*(.+)$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    const value = match[2]!;
    result[key.trim()] = value.trim();
  }

  return result;
}

/**
 * Parse a single tagged JSON line from Perforce `-Mj` output.
 *
 * @returns `null` for blank lines or non-JSON progress text.
 * @throws {P4ParseError} When the line looks like JSON but cannot be parsed or
 * validated as an object row.
 */
export function parseTaggedJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Schema.decodeUnknownSync(P4TaggedJsonRowSchema)(parsed);
  } catch (error) {
    throw new P4ParseError("Unable to parse tagged Perforce JSON output.", line, error);
  }
}

/**
 * Parse newline-delimited JSON emitted by commands such as `p4 -Mj -z tag`.
 *
 * Empty lines are ignored before parsing.
 */
export function parseP4JsonLines<T = Record<string, unknown>>(output: string): T[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = parseTaggedJsonLine(line);
      if (!parsed) {
        throw new P4ParseError("Unable to parse tagged Perforce JSON output.", line, null);
      }
      return parsed as T;
    });
}

/**
 * Parse a best-effort progress snapshot from a raw Perforce progress line.
 *
 * The CLI progress format is version-dependent, so this parser intentionally
 * extracts only coarse, low-risk fields when they are obvious.
 */
export function parseP4ProgressLine(line: string): P4ProgressSnapshot | null {
  const rawMessage = line.trim();
  if (!rawMessage) return null;

  const percentMatch = /(\d{1,3})(?:\.\d+)?%/.exec(rawMessage);
  const pairMatch = /\b(\d+)\s*\/\s*(\d+)\b/.exec(rawMessage);
  const ofMatch = /\b(\d+)\s+of\s+(\d+)\b/i.exec(rawMessage);
  const completed = pairMatch?.[1] ?? ofMatch?.[1] ?? null;
  const total = pairMatch?.[2] ?? ofMatch?.[2] ?? null;
  const percent = percentMatch ? Number(percentMatch[1]!) : null;

  const phaseMatch = /^([A-Za-z][A-Za-z0-9 /_-]{2,40}?)(?::|\s+-\s+)/.exec(rawMessage);
  const phase = phaseMatch?.[1]?.trim() ?? null;

  return {
    rawMessage,
    phase,
    completed: completed ? Number(completed) : null,
    total: total ? Number(total) : null,
    percent: Number.isFinite(percent) ? percent : null
  };
}

/**
 * Normalize a nullable string-like field from Perforce output.
 *
 * Returns trimmed strings and converts empty or non-string values to `null`.
 */
export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a nullable numeric field from Perforce output.
 *
 * Accepts finite numbers or numeric strings and returns `null` for invalid
 * values.
 */
export function normalizeNullableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize a Perforce changelist identifier into either a number or
 * `"default"`.
 */
export function normalizeP4Change(value: unknown): number | "default" | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) return null;
  if (normalized === "default") return "default";

  const parsed = normalizeNullableNumber(normalized);
  if (parsed === null) return null;

  return Math.trunc(parsed);
}

/**
 * Determine whether a workspace belongs to the current machine.
 *
 * - Host-restricted workspaces are local only when `host` matches exactly.
 * - Hostless workspaces (no `Host` field) are usable from any machine; they
 *   are treated as local when `root` exists on disk (or when no root is
 *   available to check).
 */
export function isLocalWorkspace(
  workspace: LocalWorkspaceCandidate,
  hostName: string,
  options: {
    rootExists?: (root: string) => boolean;
  } = {}
): boolean {
  if (workspace.host === hostName) {
    return true;
  }

  if (workspace.host !== null && workspace.host !== "") {
    return false;
  }

  const root = workspace.root;
  if (!root) {
    return true;
  }

  const rootExists = options.rootExists ?? defaultRootExists;
  return rootExists(root);
}

function defaultRootExists(root: string): boolean {
  try {
    return existsSync(root);
  } catch {
    return false;
  }
}

/**
 * Build a recursive stream file spec, or return null for non-stream workspaces.
 */
export function workspaceStreamFileSpec(
  workspace: Pick<import("./types.js").P4WorkspaceSummary, "stream">
): string | null {
  const stream = normalizeNullableString(workspace.stream);
  if (!stream) return null;

  return `${stream.replace(/\/+$/, "")}/...`;
}

/**
 * Build a recursive stream file spec and throw when the workspace is not stream-based.
 */
export function requireWorkspaceStreamFileSpec(
  workspace: Pick<import("./types.js").P4WorkspaceSummary, "stream">
): string {
  const fileSpec = workspaceStreamFileSpec(workspace);
  if (!fileSpec) {
    throw new Error("Workspace is not stream-based.");
  }

  return fileSpec;
}

/**
 * Build a recursive local workspace-root file spec for commands such as reconcile.
 */
export function workspaceRootFileSpec(
  workspace: Pick<import("./types.js").P4WorkspaceSummary, "root">
): string {
  const normalizedRoot = workspace.root.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizedRoot}/...`;
}

/**
 * Convert a unix timestamp expressed in seconds to an ISO-8601 string.
 */
export function unixSecondsToIsoString(value: string | null | undefined): string | null {
  if (!value) return null;

  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;

  return new Date(seconds * 1000).toISOString();
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const NON_TEXT_BASE_TYPES = new Set([
  "binary",
  "apple",
  "resource",
  "xb",
  "xbinary"
]);

/**
 * Determine whether a Perforce file type should be treated as non-text.
 *
 * Recognizes base types `binary`, `apple`, and `resource`, plus historical
 * `xb`/`xbinary` spellings and `+` modifiers (for example `binary+F`).
 */
export function isBinaryP4Type(type: string | null | undefined): boolean {
  if (!type) return false;

  const normalized = type.toLowerCase();
  const base = normalized.split("+", 1)[0] ?? normalized;
  if (NON_TEXT_BASE_TYPES.has(base)) {
    return true;
  }

  return base.includes("binary") || base.includes("xb");
}

/**
 * Assert a positive finite integer suitable for limits and concurrency.
 *
 * @throws {Error} When the value is not a positive finite integer.
 */
export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive finite integer, received ${String(value)}.`);
  }

  return value;
}

/**
 * Assert a non-negative finite integer suitable for changelist cursors.
 *
 * @throws {Error} When the value is not a non-negative finite integer.
 */
export function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite integer, received ${String(value)}.`);
  }

  return value;
}

/**
 * Assert a positive finite timeout duration in milliseconds.
 *
 * @throws {Error} When the value is not a positive finite number.
 */
export function requirePositiveTimeoutMs(value: number, name = "timeoutMs"): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number of milliseconds, received ${String(value)}.`);
  }

  return value;
}

/**
 * Count addition and deletion lines in unified diff output.
 */
export function summarizeUnifiedDiff(stdout: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

/**
 * Parse unified diff output into hunk records.
 *
 * The parser is intentionally tolerant of Perforce's unified diff output.
 */
export function parseUnifiedDiff(stdout: string): P4DiffHunk[] {
  const hunks: P4DiffHunk[] = [];
  let current: P4DiffHunk | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const headerMatch = HUNK_HEADER_PATTERN.exec(rawLine);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }

      current = {
        oldStart: Number(headerMatch[1]),
        oldLines: headerMatch[2] ? Number(headerMatch[2]) : 1,
        newStart: Number(headerMatch[3]),
        newLines: headerMatch[4] ? Number(headerMatch[4]) : 1,
        lines: []
      };
      continue;
    }

    if (current) {
      current.lines.push(rawLine);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
}

/**
 * Parse the header line emitted by `p4 print`.
 */
/**
 * Resolved diff invocation details for {@link P4Client.diffFile}.
 */
export interface ResolvedDiffPlan {
  source: P4DiffSource;
  command: "diff" | "diff2";
  args: string[];
  fromRevision: string | number | null;
  toRevision: string | number | null;
}

/**
 * Build a depot filespec for `p4 diff2` or `p4 print`.
 */
export function buildDepotDiffFilespec(
  depotFile: string,
  revision: string | number
): string {
  const revisionText = String(revision);
  if (revisionText.toLowerCase() === "none") {
    return `${depotFile}#none`;
  }
  if (revisionText.startsWith("#") || revisionText.startsWith("@")) {
    return `${depotFile}${revisionText}`;
  }

  return `${depotFile}#${revisionText}`;
}

/**
 * Infer depot revision endpoints for a submitted changelist file.
 */
export function resolveDepotDiffRevisions(
  file: {
    depotFile: string;
    action: string;
    revision: number | null;
  }
): { fromRevision: string | number; toRevision: string | number } | null {
  const action = file.action.toLowerCase();
  const revision = file.revision;

  if (action === "add") {
    if (revision === null) {
      return { fromRevision: "none", toRevision: "have" };
    }

    return { fromRevision: "none", toRevision: revision };
  }

  if (action === "delete") {
    if (revision === null) {
      return null;
    }

    return { fromRevision: revision, toRevision: "none" };
  }

  if (action === "edit" || action === "integrate" || action === "branch") {
    if (revision === null || revision <= 1) {
      return null;
    }

    return { fromRevision: revision - 1, toRevision: revision };
  }

  return null;
}

/**
 * Infer depot revision endpoints for a shelved changelist file.
 */
export function resolveShelvedDiffRevisions(
  file: {
    depotFile: string;
    action: string;
    revision: number | null;
    shelvedChange: number;
  }
): { fromRevision: string | number; toRevision: string | number } {
  const action = file.action.toLowerCase();
  const revision = file.revision;
  const shelfRevision = `@=${file.shelvedChange}`;

  if (action === "add") {
    return { fromRevision: "none", toRevision: shelfRevision };
  }

  if (action === "delete") {
    if (revision === null) {
      throw new Error(
        `Unable to infer base revision for shelved delete ${file.depotFile}.`
      );
    }

    return { fromRevision: revision, toRevision: "none" };
  }

  if (action === "edit" || action === "integrate" || action === "branch") {
    if (revision === null || revision <= 1) {
      throw new Error(
        `Unable to infer base revision for shelved file ${file.depotFile}.`
      );
    }

    return { fromRevision: revision - 1, toRevision: shelfRevision };
  }

  throw new Error(
    `Unable to infer depot revisions for shelved ${action} file ${file.depotFile}.`
  );
}

/**
 * Decide whether `diffFile()` should compare the workspace or two depot revisions.
 */
export function resolveDiffPlan(options: DiffFileOptions): ResolvedDiffPlan {
  const diffFlags = (options.diffFlags ?? "-du").trim().split(/\s+/).filter(Boolean);
  const hasFrom = options.fromRevision !== undefined;
  const hasTo = options.toRevision !== undefined;

  if (hasFrom !== hasTo) {
    throw new Error(
      "diffFile() requires both fromRevision and toRevision for depot-vs-depot diffs."
    );
  }

  if (hasFrom && hasTo) {
    const fromRevision = options.fromRevision!;
    const toRevision = options.toRevision!;
    const left = buildDepotDiffFilespec(options.depotFile, fromRevision);
    const right = buildDepotDiffFilespec(options.depotFile, toRevision);

    return {
      source: "depot",
      command: "diff2",
      args: [...diffFlags, left, right],
      fromRevision,
      toRevision
    };
  }

  if (options.changelistStatus === "shelved") {
    const shelvedChange = options.shelvedChange;
    if (shelvedChange === undefined) {
      throw new Error(
        'diffFile() requires shelvedChange when changelistStatus is "shelved".'
      );
    }

    const revisions = resolveShelvedDiffRevisions({
      depotFile: options.depotFile,
      action: options.action ?? "edit",
      revision: options.revision ?? null,
      shelvedChange
    });
    const left = buildDepotDiffFilespec(options.depotFile, revisions.fromRevision);
    const right = buildDepotDiffFilespec(options.depotFile, revisions.toRevision);

    return {
      source: "depot",
      command: "diff2",
      args: [...diffFlags, left, right],
      fromRevision: revisions.fromRevision,
      toRevision: revisions.toRevision
    };
  }

  if (options.changelistStatus === "submitted") {
    const revisions = resolveDepotDiffRevisions({
      depotFile: options.depotFile,
      action: options.action ?? "edit",
      revision: options.revision ?? null
    });

    if (!revisions) {
      throw new Error(
        `Unable to infer depot revisions for submitted file ${options.depotFile}.`
      );
    }

    const left = buildDepotDiffFilespec(options.depotFile, revisions.fromRevision);
    const right = buildDepotDiffFilespec(options.depotFile, revisions.toRevision);

    return {
      source: "depot",
      command: "diff2",
      args: [...diffFlags, left, right],
      fromRevision: revisions.fromRevision,
      toRevision: revisions.toRevision
    };
  }

  return {
    source: "workspace",
    command: "diff",
    args: [...diffFlags, options.depotFile],
    fromRevision: null,
    toRevision: null
  };
}

export function parseP4PrintHeader(line: string): {
  depotFile: string;
  revision: string | null;
  type: string | null;
} | null {
  const match = /^(\/\/[^\s#]+)#(\S+)\s+-\s+(.+)$/.exec(line.trim());
  if (!match) return null;

  return {
    depotFile: match[1]!,
    revision: match[2]!,
    type: match[3]!.trim() || null
  };
}
