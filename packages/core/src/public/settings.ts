import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../internal/command.js";
import type {
  P4CliSettings,
  P4ResolvedSettings,
  P4SettingKey,
  P4SettingsContribution,
  P4SettingsSource,
  ResolveP4SettingsOptions
} from "./types.js";

const P4_SETTING_KEYS: readonly P4SettingKey[] = ["P4PORT", "P4USER", "P4CLIENT"];
const DEFAULT_P4_SETTINGS_SOURCES: readonly P4SettingsSource[] = [
  "cli",
  "registry",
  "p4v-app-settings",
  "p4v-connection-map"
];

function normalizeSettingValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function setSetting(
  settings: P4CliSettings,
  key: P4SettingKey,
  value: string | undefined
): void {
  const normalized = normalizeSettingValue(value);
  if (normalized) {
    settings[key] = normalized;
  }
}

function hasConnectionSettings(settings: P4CliSettings): boolean {
  return Boolean(settings.P4PORT && settings.P4USER);
}

function hasPreferredSettings(settings: P4CliSettings): boolean {
  return Boolean(settings.P4PORT && settings.P4USER && settings.P4CLIENT);
}

function getContributedSettingKeys(
  primary: P4CliSettings,
  fallback: P4CliSettings
): P4SettingKey[] {
  return P4_SETTING_KEYS.filter((key) => !primary[key] && Boolean(fallback[key]));
}

function getBestCandidate(candidates: P4CliSettings[]): P4CliSettings {
  let bestConnectable: P4CliSettings | null = null;
  let bestPartial: P4CliSettings | null = null;

  for (const candidate of candidates) {
    if (hasPreferredSettings(candidate)) {
      return candidate;
    }
    if (!bestConnectable && hasConnectionSettings(candidate)) {
      bestConnectable = candidate;
    }
    if (!bestPartial && P4_SETTING_KEYS.some((key) => Boolean(candidate[key]))) {
      bestPartial = candidate;
    }
  }

  return bestConnectable ?? bestPartial ?? {};
}

async function readRegistrySettings(signal?: AbortSignal): Promise<P4CliSettings> {
  signal?.throwIfAborted();
  if (process.platform !== "win32") {
    return {};
  }

  try {
    const result = await runCommand("reg", ["query", "HKCU\\Software\\Perforce\\Environment"], {
      allowNonZeroExit: true,
      ...(signal === undefined ? {} : { signal })
    });

    if (result.exitCode !== 0) {
      return {};
    }

    return parseRegQueryOutput(result.stdout);
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

async function readP4vApplicationSettings(signal?: AbortSignal): Promise<P4CliSettings> {
  try {
    const content = await readFile(join(homedir(), ".p4qt", "ApplicationSettings.xml"), {
      encoding: 'utf8', signal
    });
    return parseP4vApplicationSettingsXml(content);
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

async function readP4vConnectionMap(signal?: AbortSignal): Promise<P4CliSettings> {
  try {
    const content = await readFile(join(homedir(), ".p4qt", "connectionmap.xml"), {
      encoding: 'utf8', signal
    });
    return parseP4vConnectionMapXml(content);
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

/**
 * Merge missing Perforce settings from a fallback object without overwriting
 * values that already exist in the primary settings.
 */
export function mergeIncompleteSettings(
  primary: P4CliSettings,
  fallback: P4CliSettings
): P4CliSettings {
  const merged: P4CliSettings = {};

  for (const key of P4_SETTING_KEYS) {
    const value = primary[key] ?? fallback[key];
    if (value) {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Parse `p4 set -q` output into Perforce CLI settings.
 *
 * This parser expects `-q` output where each line is `NAME=value`.
 */
export function parseP4SetOutput(output: string): P4CliSettings {
  const settings: P4CliSettings = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (key === "P4PORT" || key === "P4USER" || key === "P4CLIENT") {
      setSetting(settings, key, value);
    }
  }

  return settings;
}

/**
 * Parse `reg query HKCU\\Software\\Perforce\\Environment` output into
 * Perforce CLI settings.
 */
export function parseRegQueryOutput(output: string): P4CliSettings {
  const settings: P4CliSettings = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(P4PORT|P4USER|P4CLIENT)\s+REG_SZ\s+(.+)$/);

    if (match?.[1]) {
      setSetting(settings, match[1] as P4SettingKey, match[2]);
    }
  }

  return settings;
}

/**
 * Parse a P4V connection string like `ssl:server:1666, user, client`.
 */
export function parseP4vConnectionString(connection: string): P4CliSettings {
  const settings: P4CliSettings = {};
  const parts = connection.split(",");

  setSetting(settings, "P4PORT", parts[0]);
  setSetting(settings, "P4USER", parts[1]);
  setSetting(settings, "P4CLIENT", parts[2]);

  return settings;
}

/**
 * Parse `~/.p4qt/ApplicationSettings.xml` and return the best available local
 * connection candidate, preferring entries with `P4PORT`, `P4USER`, and
 * `P4CLIENT`.
 */
export function parseP4vApplicationSettingsXml(xml: string): P4CliSettings {
  const candidates: P4CliSettings[] = [];
  const singleValuePatterns = [
    /<String\s+varName="LastConnection">([\s\S]*?)<\/String>/i
  ];
  const listValuePatterns = [
    /<StringList\s+varName="OpenWorkspaces">([\s\S]*?)<\/StringList>/i,
    /<StringList\s+varName="RecentConnections">([\s\S]*?)<\/StringList>/i
  ];

  for (const pattern of singleValuePatterns) {
    const match = xml.match(pattern);
    const candidate = parseP4vConnectionString(match?.[1] ?? "");
    if (P4_SETTING_KEYS.some((key) => Boolean(candidate[key]))) {
      candidates.push(candidate);
    }
  }

  for (const pattern of listValuePatterns) {
    const section = xml.match(pattern)?.[1];
    if (!section) {
      continue;
    }

    const stringMatches = section.matchAll(/<String>([\s\S]*?)<\/String>/gi);
    for (const match of stringMatches) {
      const candidate = parseP4vConnectionString(match[1] ?? "");
      if (P4_SETTING_KEYS.some((key) => Boolean(candidate[key]))) {
        candidates.push(candidate);
      }
    }
  }

  return getBestCandidate(candidates);
}

/**
 * Parse `~/.p4qt/connectionmap.xml` and return the first connection entry.
 */
export function parseP4vConnectionMapXml(xml: string): P4CliSettings {
  const entry = xml.match(/<ConnectionMap\b[\s\S]*?<\/ConnectionMap>/i)?.[0];
  if (!entry) {
    return {};
  }

  const settings: P4CliSettings = {};
  setSetting(settings, "P4PORT", entry.match(/<P4Port>([\s\S]*?)<\/P4Port>/i)?.[1]);
  setSetting(settings, "P4USER", entry.match(/<User>([\s\S]*?)<\/User>/i)?.[1]);
  return settings;
}

/**
 * Resolve Perforce settings from ordered local sources without contacting the
 * server.
 *
 * Missing sources are treated as contributing no settings. Cancellation rejects
 * the lookup instead of falling through to another source.
 */
export async function resolveP4Settings(
  cliSettings: P4CliSettings = {},
  options: ResolveP4SettingsOptions = {}
): Promise<P4CliSettings> {
  const resolved = await resolveP4SettingsWithDetails(cliSettings, options);
  return resolved.settings;
}

/**
 * Resolve Perforce settings from ordered local sources and include provenance
 * for the keys contributed by each source.
 */
export async function resolveP4SettingsWithDetails(
  cliSettings: P4CliSettings = {},
  options: ResolveP4SettingsOptions = {}
): Promise<P4ResolvedSettings> {
  options.signal?.throwIfAborted();
  const contributions: P4SettingsContribution[] = [];
  const sources = options.sources ?? [...DEFAULT_P4_SETTINGS_SOURCES];
  const readers: Record<Exclude<P4SettingsSource, "cli">, (signal?: AbortSignal) => Promise<P4CliSettings>> = {
    registry: options.readRegistry ?? readRegistrySettings,
    "p4v-app-settings": options.readP4vAppSettings ?? readP4vApplicationSettings,
    "p4v-connection-map": options.readP4vConnectionMap ?? readP4vConnectionMap
  };
  let settings: P4CliSettings = {};

  for (const source of sources) {
    options.signal?.throwIfAborted();
    const sourceSettings = source === "cli"
      ? cliSettings
      : await readers[source](options.signal).catch(() => {
        options.signal?.throwIfAborted();
        return {};
      });
    options.signal?.throwIfAborted();
    const contributedKeys = getContributedSettingKeys(settings, sourceSettings);

    if (contributedKeys.length > 0) {
      contributions.push({ source, keys: contributedKeys });
      settings = mergeIncompleteSettings(settings, sourceSettings);
    }

    if (hasPreferredSettings(settings)) {
      break;
    }
  }

  return { settings, contributions };
}
