import { Context } from 'effect';
import type { Stream } from 'effect';
import type { P4SpawnError } from '../errors.js';

/** One `p4` process to run. */
export interface P4Invocation {
  /** Path or name of the `p4` executable. */
  readonly executable: string;
  /** Complete argument vector, including global options. */
  readonly args: readonly string[];
  /** Working directory; the current directory when `undefined`. */
  readonly cwd: string | undefined;
  /**
   * Environment changes applied on top of the executor's base environment.
   * An `undefined` value removes an inherited variable.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Text written to stdin, for `-x -` argument lists; stdin is closed empty otherwise. */
  readonly input: string | undefined;
}

/** Output of a running `p4` process, in the order it arrived. */
export type P4ProcessEvent =
  | { readonly _tag: 'stdout'; readonly bytes: Uint8Array }
  | { readonly _tag: 'stderr'; readonly bytes: Uint8Array }
  /** Always the last event. `code` is `null` when the process was killed by a signal. */
  | { readonly _tag: 'exit'; readonly code: number | null };

/**
 * Runs `p4` processes.
 *
 * `run` returns a stream of output chunks that ends with exactly one `exit`
 * event. Interrupting the stream, for example on timeout or cancellation, must
 * terminate the process and release its pipes before the interruption completes.
 * The Node implementation is `NodeP4Executor` in `p4client-ts/node`; tests can
 * provide a replay from `p4client-ts/testing`.
 */
export class P4Executor extends Context.Service<P4Executor, {
  readonly run: (invocation: P4Invocation) => Stream.Stream<P4ProcessEvent, P4SpawnError>;
}>()('p4client-ts/P4Executor') {}
