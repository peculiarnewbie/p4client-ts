import { Effect, Match } from 'effect';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runPlainCommand } from '../engine/command.js';
import { P4Config } from '../engine/config.js';
import { operation } from '../engine/operation.js';
import { invalid } from '../commands/shared.js';
import {
  fillMissing,
  parseP4SetOutput,
  parseP4vApplicationSettingsXml,
  parseP4vConnectionMapXml,
  toConnection,
} from '../connection/settings.js';
import type { P4Connection } from '../connection/argv.js';
import type { P4SettingField, P4Settings } from '../connection/settings.js';
import type { P4Error } from '../errors.js';
import type { P4Executor } from '../exec/executor.js';
import type { P4Message } from '../wire/message.js';

/**
 * Where local connection settings come from: `p4` is what `p4 set -q` reports in the working
 * directory (environment, P4CONFIG, P4ENVIRO and the Windows registry); `p4v-app-settings` is
 * P4V's last, open and recent connections; `p4v-connection-map` is P4V's first saved connection.
 */
export type P4SettingsSource = 'p4' | 'p4v-app-settings' | 'p4v-connection-map';

/** Options for {@link resolveConnection}. */
export interface ResolveConnectionOptions {
  /** Sources in precedence order. Defaults to `['p4', 'p4v-app-settings', 'p4v-connection-map']`. */
  readonly sources?: readonly P4SettingsSource[] | undefined;
}

/** A connection resolved from local settings, with the source of each value. */
export interface P4ResolvedConnection {
  readonly connection: P4Connection;
  readonly sources: Readonly<Partial<Record<P4SettingField, P4SettingsSource>>>;
}

const DEFAULT_SOURCES: readonly P4SettingsSource[] = ['p4', 'p4v-app-settings', 'p4v-connection-map'];

/** A missing or unreadable P4V file contributes nothing. */
function readP4vFile(name: string, parse: (xml: string) => P4Settings): Effect.Effect<P4Settings> {
  return Effect.tryPromise((signal) => readFile(join(homedir(), '.p4qt', name), { encoding: 'utf8', signal })).pipe(
    Effect.map(parse),
    Effect.orElseSucceed((): P4Settings => ({})),
  );
}

/** `p4 set -q` in the configured directory, ignoring the configured connection it would otherwise report. */
const p4Settings: Effect.Effect<P4Settings, P4Error, P4Executor | P4Config> = Effect.gen(function* () {
  const options = yield* P4Config;

  const output = yield* runPlainCommand({ args: ['set', '-q'] }).pipe(
    Effect.provideService(P4Config, { ...options, connection: {} }),
  );

  return parseP4SetOutput(new TextDecoder().decode(output.stdout));
});

/**
 * Resolve the server, user, workspace and charset that local settings select,
 * without contacting a server.
 *
 * Each source only fills values earlier sources left unset. Resolution stops
 * once a port, user and workspace are known.
 */
export const resolveConnection: (
  options?: ResolveConnectionOptions,
) => Effect.Effect<P4ResolvedConnection, P4Error, P4Executor | P4Config> = Effect.fn(
  'p4client-ts.resolveConnection',
)(function* (options: ResolveConnectionOptions = {}) {
  let settings: P4Settings = {};
  const sources: Partial<Record<P4SettingField, P4SettingsSource>> = {};

  for (const source of options.sources ?? DEFAULT_SOURCES) {
    const found = yield* Match.value(source).pipe(
      Match.when('p4', () => p4Settings),
      Match.when('p4v-app-settings', () => readP4vFile('ApplicationSettings.xml', parseP4vApplicationSettingsXml)),
      Match.when('p4v-connection-map', () => readP4vFile('connectionmap.xml', parseP4vConnectionMapXml)),
      Match.exhaustive,
    );

    const merged = fillMissing(settings, found);
    settings = merged.settings;

    for (const field of merged.contributed) sources[field] = source;

    if (settings.port && settings.user && settings.client) break;
  }

  return { connection: toConnection(settings), sources };
});

/** Options for {@link setPersistentWorkspace}. */
export interface SetPersistentWorkspaceOptions {
  /** Workspace to select, written as `P4CLIENT`. */
  readonly client: string;
}

/** The persistent workspace selection {@link setPersistentWorkspace} wrote. */
export interface P4PersistentWorkspace {
  readonly client: string;
  readonly messages: P4Message[];
}

/**
 * `p4 set P4CLIENT=<client>`: **writes the user's persistent settings** (Windows registry or
 * P4ENVIRO), so P4V and every later `p4` see it. Nothing else here writes them; call it only on an
 * explicit user request and prefer `connection.client`. P4CLIENT in the environment or P4CONFIG
 * still wins. Ignores the client's connection and isolation. Needs `allowMutation`.
 */
export const setPersistentWorkspace = operation<SetPersistentWorkspaceOptions, never, P4PersistentWorkspace>(
  'setPersistentWorkspace',
  (options, sink) => Effect.gen(function* () {
    const client = options.client.trim();

    if (client === '' || client !== options.client || /[\s=#@%*]|^-|\.\.\./.test(client)) {
      return yield* invalid('client', `"${options.client}" is not a workspace name.`);
    }

    const config = yield* P4Config;

    // The configured connection becomes -c/-p/-u and isolation redirects P4ENVIRO; neither may
    // decide where the persistent setting is written.
    const output = yield* runPlainCommand({ args: ['set', `P4CLIENT=${client}`] }).pipe(
      Effect.provideService(P4Config, { ...config, connection: {} }),
    );

    for (const message of output.messages) yield* sink.message(message);

    return { client, messages: output.messages };
  }),
);
