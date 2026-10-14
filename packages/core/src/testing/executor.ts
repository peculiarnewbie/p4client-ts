import { Effect, Layer, Stream } from 'effect';
import { P4Executor } from '../exec/executor.js';
import { fixtureStdout } from './fixture.js';
import type { P4Invocation, P4ProcessEvent } from '../exec/executor.js';
import type { P4WireFixture } from './fixture.js';

/** Output a scripted executor returns for one invocation. */
export interface P4ScriptedOutput {
  readonly stdout?: string | Uint8Array | undefined;
  readonly stderr?: string | undefined;
  readonly exitCode?: number | null | undefined;
}

/** Options for test executors. */
export interface P4TestExecutorOptions {
  /**
   * Deliver stdout in chunks of this many bytes, to exercise readers with
   * output split mid-line or mid-record. Defaults to the whole output at once.
   */
  readonly chunkSize?: number | undefined;
}

const encoder = new TextEncoder();
const bytes = (value: string | Uint8Array | undefined): Uint8Array =>
  typeof value === 'string' ? encoder.encode(value) : value ?? new Uint8Array(0);

function chunks(data: Uint8Array, size: number | undefined): Uint8Array[] {
  if (data.length === 0) return [];
  if (size === undefined || size <= 0) return [data];
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) result.push(data.subarray(offset, offset + size));
  return result;
}

function emit(output: P4ScriptedOutput, options: P4TestExecutorOptions): Stream.Stream<P4ProcessEvent> {
  const events: P4ProcessEvent[] = [
    ...chunks(bytes(output.stdout), options.chunkSize).map((chunk) => ({ _tag: 'stdout' as const, bytes: chunk })),
    ...chunks(bytes(output.stderr), undefined).map((chunk) => ({ _tag: 'stderr' as const, bytes: chunk })),
    { _tag: 'exit', code: output.exitCode === undefined ? 0 : output.exitCode },
  ];
  return Stream.fromIterable(events);
}

/**
 * An executor that answers each invocation with output computed by a function.
 *
 * @param respond Output for an invocation. Throwing fails the test as a defect.
 * @param options Delivery options.
 * @returns A layer providing `P4Executor`.
 */
export function scriptedExecutor(
  respond: (invocation: P4Invocation) => P4ScriptedOutput,
  options: P4TestExecutorOptions = {},
): Layer.Layer<P4Executor> {
  return Layer.succeed(P4Executor, {
    run: (invocation) => Stream.unwrap(Effect.sync(() => emit(respond(invocation), options))),
  });
}

/** Global options that identify the connection rather than the command. */
const CONNECTION_OPTIONS = new Set(['-p', '-u', '-c', '-C', '-H']);

/** Other global options that take a separate value. */
const VALUE_OPTIONS = new Set(['-z', '-x', '-d', '-r', '-v', '-P', '-L', '-Q']);

/**
 * The arguments that identify a command, without connection options and
 * program identification, so recordings from any server compare equal.
 * Only global options, before the subcommand, are removed: a subcommand's
 * own `-u` or `-c` is part of the command.
 *
 * @param args Complete argument vector.
 * @returns Arguments without global `-p`, `-u`, `-c`, `-C`, `-H` and `-zprog`/`-zversion`.
 */
export function commandArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  let index = 0;
  for (; index < args.length && args[index]!.startsWith('-'); index += 1) {
    const arg = args[index]!;
    if (CONNECTION_OPTIONS.has(arg)) {
      index += 1;
    } else if (VALUE_OPTIONS.has(arg)) {
      result.push(arg, ...args.slice(index + 1, index + 2));
      index += 1;
    } else if (!/^-z(?:prog|version)=/.test(arg)) {
      result.push(arg);
    }
  }
  return [...result, ...args.slice(index)];
}

const key = (args: readonly string[], input: string | undefined) =>
  JSON.stringify([commandArgs(args), input ?? null]);

/**
 * An executor that replays recorded fixtures. Each invocation must match a
 * fixture's command arguments and stdin exactly, ignoring connection options;
 * an unmatched invocation fails as a defect naming the closest fixture.
 *
 * @param fixtures Recorded invocations, for example from `readWireFixtures`.
 * @param options Delivery options.
 * @returns A layer providing `P4Executor`.
 */
export function replayExecutor(
  fixtures: Iterable<P4WireFixture> | ReadonlyMap<string, P4WireFixture>,
  options: P4TestExecutorOptions = {},
): Layer.Layer<P4Executor> {
  const list = fixtures instanceof Map ? [...fixtures.values()] : [...fixtures as Iterable<P4WireFixture>];
  const byKey = new Map(list.map((fixture) => [key(fixture.args, fixture.input), fixture]));
  return Layer.succeed(P4Executor, {
    run: (invocation) => {
      const fixture = byKey.get(key(invocation.args, invocation.input));
      if (fixture !== undefined) {
        return emit({ stdout: fixtureStdout(fixture), stderr: fixture.stderr, exitCode: fixture.exitCode }, options);
      }
      const wanted = commandArgs(invocation.args);
      const nearest = list
        .map((candidate) => commandArgs(candidate.args))
        .find((args) => args.some((arg) => wanted.includes(arg) && !arg.startsWith('-')));
      return Stream.die(new Error(
        `No fixture records ${JSON.stringify(wanted)}${invocation.input ? ' with input' : ''}.`
          + (nearest ? ` Closest: ${JSON.stringify(nearest)}.` : ''),
      ));
    },
  });
}

/**
 * Wrap an executor layer so every invocation is recorded.
 *
 * @param inner The executor that runs the invocations.
 * @returns The recording layer and the list it appends to.
 */
export function recordingExecutor(inner: Layer.Layer<P4Executor>): {
  readonly layer: Layer.Layer<P4Executor>;
  readonly invocations: P4Invocation[];
} {
  const invocations: P4Invocation[] = [];
  const layer = Layer.effect(P4Executor, Effect.gen(function* () {
    const executor = yield* P4Executor.asEffect();
    return {
      run: (invocation: P4Invocation) => Stream.suspend(() => {
        invocations.push(invocation);
        return executor.run(invocation);
      }),
    };
  })).pipe(Layer.provide(inner));
  return { layer, invocations };
}
