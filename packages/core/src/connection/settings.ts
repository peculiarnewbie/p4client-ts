import type { P4Connection } from './argv.js';

/** Connection fields that local settings can supply. */
export type P4SettingField = 'port' | 'user' | 'client' | 'charset';

/** Connection values found in one settings source. */
export type P4Settings = Partial<Record<P4SettingField, string>>;

const VARIABLES: Readonly<Record<string, P4SettingField>> = {
  P4PORT: 'port',
  P4USER: 'user',
  P4CLIENT: 'client',
  P4CHARSET: 'charset',
};

/** Connection fields in resolution order. */
export const SETTING_FIELDS: readonly P4SettingField[] = ['port', 'user', 'client', 'charset'];

function set(settings: P4Settings, field: P4SettingField, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) settings[field] = trimmed;
}

/**
 * Parse `p4 set -q` output, which prints one `NAME=value` per line.
 *
 * @param output Command output.
 * @returns Connection values it contains.
 */
export function parseP4SetOutput(output: string): P4Settings {
  const settings: P4Settings = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const field = VARIABLES[line.slice(0, separator).trim()];
    if (field !== undefined) set(settings, field, line.slice(separator + 1));
  }
  return settings;
}

/**
 * Parse a P4V connection string such as `ssl:server:1666, user, client`.
 *
 * @param connection P4V connection text.
 * @returns Its port, user and workspace, where present.
 */
export function parseP4vConnectionString(connection: string): P4Settings {
  const settings: P4Settings = {};
  const [port, user, client] = connection.split(',');
  set(settings, 'port', port);
  set(settings, 'user', user);
  set(settings, 'client', client);
  return settings;
}

const hasAny = (settings: P4Settings) => SETTING_FIELDS.some((field) => settings[field] !== undefined);

/**
 * Choose the most useful P4V connection: one with a port, user and workspace,
 * else one with a port and user, else the first with anything.
 */
function bestCandidate(candidates: readonly P4Settings[]): P4Settings {
  return candidates.find((candidate) => candidate.port && candidate.user && candidate.client)
    ?? candidates.find((candidate) => candidate.port && candidate.user)
    ?? candidates.find(hasAny)
    ?? {};
}

/**
 * Parse P4V's `~/.p4qt/ApplicationSettings.xml`: its last, open and recent connections.
 *
 * @param xml File content.
 * @returns The most complete connection found.
 */
export function parseP4vApplicationSettingsXml(xml: string): P4Settings {
  const candidates: P4Settings[] = [];
  const last = /<String\s+varName="LastConnection">([\s\S]*?)<\/String>/i.exec(xml)?.[1];
  if (last !== undefined) candidates.push(parseP4vConnectionString(last));
  for (const list of ['OpenWorkspaces', 'RecentConnections']) {
    const section = new RegExp(`<StringList\\s+varName="${list}">([\\s\\S]*?)<\\/StringList>`, 'i').exec(xml)?.[1];
    for (const match of section?.matchAll(/<String>([\s\S]*?)<\/String>/gi) ?? []) {
      candidates.push(parseP4vConnectionString(match[1] ?? ''));
    }
  }
  return bestCandidate(candidates.filter(hasAny));
}

/**
 * Parse P4V's `~/.p4qt/connectionmap.xml`.
 *
 * @param xml File content.
 * @returns The port and user of its first entry.
 */
export function parseP4vConnectionMapXml(xml: string): P4Settings {
  const entry = /<ConnectionMap\b[\s\S]*?<\/ConnectionMap>/i.exec(xml)?.[0];
  if (entry === undefined) return {};
  const settings: P4Settings = {};
  set(settings, 'port', /<P4Port>([\s\S]*?)<\/P4Port>/i.exec(entry)?.[1]);
  set(settings, 'user', /<User>([\s\S]*?)<\/User>/i.exec(entry)?.[1]);
  return settings;
}

/**
 * Fill fields missing from `primary` with values from `fallback`.
 *
 * @param primary Values that take precedence.
 * @param fallback Values used only where `primary` has none.
 * @returns The fields `fallback` contributed, and the merged settings.
 */
export function fillMissing(
  primary: P4Settings,
  fallback: P4Settings,
): { readonly settings: P4Settings; readonly contributed: P4SettingField[] } {
  const settings: P4Settings = { ...primary };
  const contributed: P4SettingField[] = [];
  for (const field of SETTING_FIELDS) {
    const value = fallback[field];
    if (settings[field] === undefined && value !== undefined) {
      settings[field] = value;
      contributed.push(field);
    }
  }
  return { settings, contributed };
}

/**
 * The connection described by resolved settings.
 *
 * @param settings Resolved values.
 * @returns A connection to pass to a client.
 */
export function toConnection(settings: P4Settings): P4Connection {
  return {
    ...(settings.port === undefined ? {} : { port: settings.port }),
    ...(settings.user === undefined ? {} : { user: settings.user }),
    ...(settings.client === undefined ? {} : { client: settings.client }),
    ...(settings.charset === undefined ? {} : { charset: settings.charset }),
  };
}
