import type { LocalWorkspaceCandidate } from "./types.js";

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

export function parseP4JsonLines<T = Record<string, unknown>>(output: string): T[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function isLocalWorkspace(
  workspace: LocalWorkspaceCandidate,
  hostName: string,
  pathExists: (path: string) => boolean
): boolean {
  return workspace.host === hostName || pathExists(workspace.root);
}

export function unixSecondsToIsoString(value: string | null | undefined): string | null {
  if (!value) return null;

  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;

  return new Date(seconds * 1000).toISOString();
}
