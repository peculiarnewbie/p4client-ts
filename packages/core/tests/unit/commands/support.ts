import { expect, it } from 'bun:test';
import { Effect, Exit, Layer, Stream } from 'effect';
import { configLayer } from '../../../src/engine/config.js';
import { runOperation, watchOperation } from '../../../src/engine/operation.js';
import { commandArgs, recordingExecutor, replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { corpus } from '../../support/corpus.js';
import type { P4ClientOptions } from '../../../src/engine/config.js';
import type { P4Context, P4Operation, P4OperationEvent } from '../../../src/engine/operation.js';
import type { P4Error } from '../../../src/errors.js';
import type { P4Executor } from '../../../src/exec/executor.js';
import type { P4ScriptedOutput } from '../../../src/testing/executor.js';
import type { P4WireFixture } from '../../../src/testing/fixture.js';

/** Fixtures by name; a missing name fails the test. */
export function fixtures(...names: string[]): P4WireFixture[] {
  return names.map((name) => {
    const fixture = corpus.get(name);
    if (fixture === undefined) throw new Error(`Missing fixture ${name}`);
    return fixture;
  });
}

/** A strict replay executor over named fixtures. */
export function replay(...names: string[]): Layer.Layer<P4Executor> {
  return replayExecutor(fixtures(...names));
}

function provide<A, E>(effect: Effect.Effect<A, E, P4Context>, executor: Layer.Layer<P4Executor>, options: P4ClientOptions) {
  return effect.pipe(Effect.provide(Layer.merge(executor, configLayer(options))));
}

/** Run an operation for its result. */
export function run<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  executor: Layer.Layer<P4Executor>,
  client: P4ClientOptions = {},
): Promise<R> {
  return Effect.runPromise(provide(runOperation(op, options), executor, client));
}

/** Watch an operation and collect every event. */
export function watch<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  executor: Layer.Layer<P4Executor>,
  client: P4ClientOptions = {},
): Promise<Array<P4OperationEvent<I, R>>> {
  return Effect.runPromise(provide(Stream.runCollect(watchOperation(op, options)), executor, client));
}

/** Run an operation that must fail, and return its error. */
export async function failure<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  executor: Layer.Layer<P4Executor>,
  client: P4ClientOptions = {},
): Promise<P4Error> {
  const exit = await Effect.runPromiseExit(provide(runOperation(op, options), executor, client));
  if (Exit.isSuccess(exit)) throw new Error('Expected the operation to fail.');
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== 'Fail') throw new Error(`Expected a failure, got ${String(reason?._tag)}: ${String(exit.cause)}`);
  return reason.error;
}

/**
 * The command arguments (without global connection options) of every `p4`
 * invocation an operation makes, answering each with scripted output.
 */
export async function invocations<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  respond: (args: string[]) => P4ScriptedOutput = () => ({}),
  client: P4ClientOptions = {},
): Promise<string[][]> {
  const recorder = recordingExecutor(scriptedExecutor((invocation) => respond(commandArgs(invocation.args))));
  await Effect.runPromiseExit(provide(runOperation(op, options), recorder.layer, client));
  return recorder.invocations.map((invocation) => commandArgs(invocation.args));
}

/** One row of an argv table: an operation call and the `p4` commands it must run. */
export interface ArgvCase {
  readonly name: string;
  readonly run: () => Promise<string[][]>;
  readonly argv: readonly (readonly string[])[];
}

/**
 * Define an argv case.
 *
 * @param name Test name.
 * @param op The operation.
 * @param options Its options.
 * @param argv Command arguments of each invocation, without connection options.
 * @param respond Scripted output for each invocation.
 */
export function argvCase<O, I, R>(
  name: string,
  op: P4Operation<O, I, R>,
  options: O,
  argv: readonly (readonly string[])[],
  respond?: (args: string[]) => P4ScriptedOutput,
): ArgvCase {
  return { name, run: () => invocations(op, options, respond), argv };
}

/** Register a test per argv case. */
export function argvTable(cases: readonly ArgvCase[]): void {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      expect(await testCase.run()).toEqual(testCase.argv.map((args) => [...args]));
    });
  }
}
