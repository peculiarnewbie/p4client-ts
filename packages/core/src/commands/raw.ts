import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { decodeField, invalid, itemFailure } from './shared.js';
import type { Schema } from 'effect';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { P4ItemFailure, Row } from './shared.js';

/** Options for {@link runTagged}. */
export interface RunTaggedOptions {
  /**
   * The subcommand and its arguments, such as `['changes', '-m', '1']`.
   * `-Mj -z tag` and the connection's global options are added.
   */
  readonly args: readonly string[];
  /**
   * Schema each data record must satisfy. Without one, records are returned
   * as received. A record that does not satisfy it fails with `P4ParseError`.
   */
  readonly schema?: Schema.Decoder<unknown> | undefined;
  /** What to do with each message, by reason, beyond the default policy. */
  readonly policy?: P4MessagePolicy | undefined;
}

/** Records of a tagged command with the messages Perforce reported. */
export interface P4TaggedResult<A = Row> {
  /** Data records, decoded by the schema when one was given. */
  readonly items: A[];
  readonly messages: P4Message[];
  /** Messages the policy made per-item failures. */
  readonly failures: P4ItemFailure[];
}

/**
 * Run any command with tagged JSON output (`p4 -Mj -z tag <args>`).
 *
 * Messages are classified like every other operation's, adjusted by
 * `policy`. A command that can change the server or a workspace fails with
 * `P4ReadOnlyError` unless the client allows mutation.
 *
 * @returns The data records, messages and per-item failures.
 * @throws {P4InvalidArgumentError} When `args` is empty.
 * @throws {P4ParseError} When a record does not satisfy `schema`.
 * @throws {P4ReadOnlyError} When the command mutates and the client does not allow it.
 */
export const runTagged = operation<RunTaggedOptions, unknown, P4TaggedResult<unknown>>('runTagged', (options, sink) =>
  Effect.gen(function* () {
    if (options.args.length === 0) return yield* invalid('args', 'args must name a command.');
    const schema = options.schema;
    const output = yield* drain(sink, streamCommand<unknown>({
      args: options.args,
      format: 'json',
      policy: options.policy,
      decode: (row) => (schema === undefined ? row : decodeField(schema, row)),
    }), {
      item: (record) => record,
      counter: progressCounter(sink, 'records'),
    });
    const result: P4TaggedResult<unknown> = {
      items: output.items,
      messages: output.messages,
      failures: output.failures.map(itemFailure),
    };
    return result;
  }));
