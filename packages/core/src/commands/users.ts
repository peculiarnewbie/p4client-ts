import { Effect, Schema } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { decodeField, isoFromSeconds, itemFailure, requirePositive, text } from './shared.js';
import type { P4Message } from '../wire/message.js';
import type { P4ItemFailure, Row } from './shared.js';

/** Options for {@link listUsers}. */
export interface ListUsersOptions {
  /** Only these users. Defaults to every user. */
  readonly users?: readonly string[] | undefined;
  /** At most this many users (`users -m`). */
  readonly limit?: number | undefined;
}

/** A Perforce user, for display and attribution. */
export interface P4User {
  readonly user: string;
  readonly email: string | null;
  readonly fullName: string | null;
  /** `standard`, `operator` or `service`. */
  readonly type: string | null;
  /** Last access, as ISO 8601. */
  readonly accessedAt: string | null;
  /** Last change to the user spec, as ISO 8601. */
  readonly updatedAt: string | null;
}

/** Users, with the requested ones that do not exist. */
export interface P4UserList {
  readonly items: P4User[];
  readonly messages: P4Message[];
  /** One message (reason `unknown_user`) per requested user that does not exist. */
  readonly failures: P4ItemFailure[];
}

const Name = Schema.NonEmptyString;

function toUser(row: Row): P4User {
  return {
    user: decodeField(Name, row.User, row),
    email: text(row.Email),
    fullName: text(row.FullName),
    type: text(row.Type),
    accessedAt: isoFromSeconds(row.Access),
    updatedAt: isoFromSeconds(row.Update),
  };
}

/**
 * List users (`p4 users`), for example to turn the user names on changelists
 * and revisions into full names and emails. A requested user that does not
 * exist is reported in `failures` rather than failing the operation.
 *
 * @returns The users, in the order Perforce lists them.
 */
export const listUsers = operation<ListUsersOptions, P4User, P4UserList>('listUsers', (options, sink) =>
  Effect.gen(function* () {
    const args = ['users'];
    if (options.limit !== undefined) args.push('-m', String(yield* requirePositive(options.limit, 'limit')));
    args.push(...(options.users ?? []));
    const output = yield* drain(sink, streamCommand({
      args,
      format: 'json',
      policy: { unknown_user: 'item' },
      decode: toUser,
    }), { item: (user) => user, counter: progressCounter(sink, 'records') });
    return { items: output.items, messages: output.messages, failures: output.failures.map(itemFailure) };
  }));
