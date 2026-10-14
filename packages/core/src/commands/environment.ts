import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { P4Config } from '../engine/config.js';
import { drain, operation } from '../engine/operation.js';
import { malformed, text } from './shared.js';
import type { P4Message } from '../wire/message.js';
import type { Row } from './shared.js';

/** Options for {@link getEnvironment}. */
export interface GetEnvironmentOptions {}

/** The connection as the server sees it, from `p4 info -s`. */
export interface P4Environment {
  /** User the server resolved, or `null` when it reports none. */
  readonly user: string | null;
  /** Workspace in use, or `null` when none is set or it does not exist. */
  readonly client: string | null;
  /** Host name the client reports. */
  readonly clientHost: string | null;
  /** The configured `P4PORT`, when the client options name one. */
  readonly port: string | null;
  /** Address the server reports for itself; may not be reachable from here. */
  readonly serverAddress: string | null;
  readonly serverVersion: string | null;
  /** Whether the server runs in Unicode mode, which requires a charset. */
  readonly unicode: boolean;
  /** Whether the server compares paths case-insensitively. */
  readonly caseInsensitive: boolean;
  readonly messages: P4Message[];
}

/** `info` reports this for a workspace that is not set or does not exist. */
const UNKNOWN_CLIENT = '*unknown*';

function toEnvironment(row: Row, port: string | null, messages: P4Message[]): P4Environment {
  const client = text(row.clientName);
  return {
    user: text(row.userName),
    client: client === UNKNOWN_CLIENT ? null : client,
    clientHost: text(row.clientHost),
    port,
    serverAddress: text(row.serverAddress),
    serverVersion: text(row.serverVersion),
    unicode: row.unicode === 'enabled',
    caseInsensitive: row.caseHandling === 'insensitive',
    messages,
  };
}

/**
 * Read the connection as the server sees it, with `p4 info -s`, which skips
 * the slow server-side lookups `info` makes.
 *
 * @returns User, workspace, server identity and modes.
 */
export const getEnvironment = operation<GetEnvironmentOptions, never, P4Environment>('getEnvironment', (_options, sink) =>
  Effect.gen(function* () {
    const config = yield* P4Config;
    const output = yield* drain(sink, streamCommand({ args: ['info', '-s'], format: 'json', decode: (row) => row }));
    const row = output.items[0];
    if (row === undefined) return yield* malformed('p4 info printed no server information.', output.messages);
    return toEnvironment(row, config.connection.port ?? null, output.messages);
  }));
