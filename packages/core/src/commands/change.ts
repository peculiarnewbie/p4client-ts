import { Effect } from 'effect';
import { runPlainCommand, streamCommand } from '../engine/command.js';
import { drain, operation } from '../engine/operation.js';
import { createdChangeNumber } from '../wire/fallback.js';
import { invalid, malformed, requirePositive } from './shared.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';

/** Options for {@link createChange}. */
export interface CreateChangeOptions {
  /** The changelist description. Line breaks are kept; it must not be blank. */
  readonly description: string;
}

/** A pending changelist {@link createChange} created. */
export interface P4CreatedChange {
  /** The new changelist number. */
  readonly change: number;
  readonly messages: P4Message[];
}

/** Options for {@link deleteChange}. */
export interface DeleteChangeOptions {
  /** A pending changelist with no open or shelved files. */
  readonly change: number;
}

/** A pending changelist {@link deleteChange} deleted. */
export interface P4DeletedChange {
  readonly change: number;
  readonly messages: P4Message[];
}

/**
 * A new changelist's spec. Every description line is tab-indented, so no
 * line of it can be read as another field. Without a `Files:` field, files
 * open in the default changelist stay there.
 */
function changeSpec(description: string): string {
  const lines = description.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  return `Change: new\nDescription:\n${lines.map((line) => `\t${line}`).join('\n')}\n`;
}

/**
 * Create an empty pending changelist with `p4 change -i`, in the client's
 * workspace and for its user.
 *
 * This changes the server, so the client must be created with
 * `allowMutation: true`. Files open in the default changelist are not moved
 * into it. p4client-ts never submits; the user submits the changelist.
 *
 * @returns The new changelist number.
 * @throws {P4InvalidArgumentError} When the description is blank.
 * @throws {P4ReadOnlyError} When the client does not allow mutation.
 */
export const createChange = operation<CreateChangeOptions, never, P4CreatedChange>('createChange', (options, sink) =>
  Effect.gen(function* () {
    if (options.description.trim() === '') return yield* invalid('description', 'description must not be blank.');
    // `-Mj` would expect the spec in tagged form, so the form goes in as text.
    const output = yield* runPlainCommand({ args: ['change', '-i'], input: changeSpec(options.description) });
    for (const message of output.messages) yield* sink.message(message);
    const stdout = new TextDecoder().decode(output.stdout);
    const change = createdChangeNumber(stdout);
    if (change === null) return yield* malformed('change -i did not report a new changelist.', stdout);
    return { change, messages: output.messages };
  }), 'changes');

/** Open or shelved files keep a changelist alive; deleting it then fails rather than reporting a notice. */
const DELETE_POLICY: P4MessagePolicy = { changelist_not_empty: 'fail' };

/**
 * Delete a pending changelist with `p4 change -d`.
 *
 * Perforce refuses while files are open or shelved in it, which fails with
 * reason `changelist_not_empty`; revert them first (see `revert`). A
 * changelist that does not exist fails with reason `unknown_changelist`.
 *
 * @returns The deleted changelist number.
 * @throws {P4InvalidArgumentError} When `change` is not a positive integer.
 * @throws {P4ReadOnlyError} When the client does not allow mutation.
 */
export const deleteChange = operation<DeleteChangeOptions, never, P4DeletedChange>('deleteChange', (options, sink) =>
  Effect.gen(function* () {
    const change = yield* requirePositive(options.change, 'change');
    const output = yield* drain(sink, streamCommand({
      args: ['change', '-d', String(change)],
      format: 'json',
      policy: DELETE_POLICY,
      decode: () => null,
    }));
    return { change, messages: output.messages };
  }), 'changes');
