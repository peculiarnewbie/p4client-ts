import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { decodeField, invalid, itemFailure } from './shared.js';
import type { Schema } from 'effect';
import type { P4Operation } from '../engine/operation.js';
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
  /** Stdin text; `-x -` file arguments are inspected by the mutation guard. */
  readonly input?: string | undefined;
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

/** Options for an operation made by {@link taggedOperation}. */
export interface TaggedCommandOptions {
  /**
   * The subcommand and its arguments, such as `['changes', '-m', '1']`.
   * `-Mj -z tag` and the connection's global options are added.
   */
  readonly args: readonly string[];
  /** Stdin text; `-x -` file arguments are inspected by the mutation guard. */
  readonly input?: string | undefined;
  /** What to do with each message, by reason, beyond the default policy. */
  readonly policy?: P4MessagePolicy | undefined;
}

function taggedProgram<A>(
  name: string,
  decode: (row: Row) => A,
): P4Operation<TaggedCommandOptions, A, P4TaggedResult<A>> {
  return operation<TaggedCommandOptions, A, P4TaggedResult<A>>(name, (options, sink) =>
    Effect.gen(function* () {
      if (options.args.length === 0) return yield* invalid('args', 'args must name a command.');
      const output = yield* drain(sink, streamCommand<A>({
        args: options.args,
        input: options.input,
        format: 'json',
        policy: options.policy,
        decode,
      }), {
        item: (record) => record,
        counter: progressCounter(sink, 'records'),
      });
      const result: P4TaggedResult<A> = {
        items: output.items,
        messages: output.messages,
        failures: output.failures.map(itemFailure),
      };
      return result;
    }));
}

/**
 * Make a typed operation that runs any tagged command (`p4 -Mj -z tag <args>`)
 * and decodes each data record with a schema.
 *
 * Messages are classified like every other operation's, adjusted by
 * `policy`. A command that can change the server or a workspace fails with
 * `P4ReadOnlyError` unless the client allows mutation.
 *
 * @param schema Schema each data record must satisfy; a record that does not fails with `P4ParseError`.
 * @param name Operation name. Defaults to `runTagged`.
 * @returns The operation, whose items are the schema's type.
 */
export function taggedOperation<A>(
  schema: Schema.Decoder<A>,
  name = 'runTagged',
): P4Operation<TaggedCommandOptions, A, P4TaggedResult<A>> {
  return taggedProgram(name, (row) => decodeField(schema, row));
}

const untyped = taggedProgram<unknown>('runTagged', (row) => row);

/**
 * Run any command with tagged JSON output (`p4 -Mj -z tag <args>`).
 *
 * Without `schema`, records are returned as received. For typed records, use
 * {@link taggedOperation}.
 *
 * @returns The data records, messages and per-item failures.
 * @throws {P4InvalidArgumentError} When `args` is empty.
 * @throws {P4ParseError} When a record does not satisfy `schema`.
 * @throws {P4ReadOnlyError} When the command mutates and the client does not allow it.
 */
export const runTagged = operation<RunTaggedOptions, unknown, P4TaggedResult<unknown>>('runTagged', (options, sink) =>
  options.schema === undefined
    ? untyped.program(options, sink)
    : taggedOperation(options.schema).program(options, sink));
