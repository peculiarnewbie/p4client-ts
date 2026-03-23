import type { LocalWorkspaceCandidate } from "./types.js";

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
 * Parse newline-delimited JSON emitted by commands such as `p4 -Mj -z tag`.
 *
 * Empty lines are ignored before parsing.
 */
export function parseP4JsonLines<T = Record<string, unknown>>(output: string): T[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
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
 * A workspace is treated as local only when its configured host matches the
 * requested host name exactly.
 */
export function isLocalWorkspace(
  workspace: LocalWorkspaceCandidate,
  hostName: string
): boolean {
  return workspace.host === hostName;
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
