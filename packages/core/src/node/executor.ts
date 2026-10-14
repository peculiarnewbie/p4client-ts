import { Cause, Effect, Layer, Queue, Stream } from 'effect';
import { spawn } from 'node:child_process';
import { P4SpawnError } from '../errors.js';
import { P4Executor } from '../exec/executor.js';
import { redactArgs } from '../connection/argv.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { P4Invocation, P4ProcessEvent } from '../exec/executor.js';

function environment(overrides: P4Invocation['env']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnError(invocation: P4Invocation, message: string, cause: unknown): P4SpawnError {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : null;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new P4SpawnError({
    message: `${message} ${detail}`,
    command: invocation.executable,
    args: redactArgs(invocation.args),
    code,
  });
}

/**
 * Kill a process that is still running, release its pipes and wait until it has closed.
 *
 * Pipes are destroyed explicitly: aborting while output is being delivered can
 * otherwise leave a readable open on Bun/Windows after the process exits.
 */
function terminate(child: ChildProcessWithoutNullStreams, closed: Promise<void>): Effect.Effect<void> {
  return Effect.promise(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    return child.pid === undefined ? Promise.resolve() : closed;
  });
}

/**
 * Run one invocation as a stream of output chunks ending with its exit.
 *
 * @param invocation The process to run.
 * @returns Output events; interrupting the stream kills and joins the process.
 */
export function runNodeProcess(invocation: P4Invocation): Stream.Stream<P4ProcessEvent, P4SpawnError> {
  return Stream.callback<P4ProcessEvent, P4SpawnError>((queue) =>
    Effect.gen(function* () {
      let resolveClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => spawn(invocation.executable, [...invocation.args], {
            cwd: invocation.cwd,
            env: environment(invocation.env),
            stdio: 'pipe',
            windowsHide: true,
          }),
          catch: (cause) => spawnError(invocation, 'Unable to launch p4.', cause),
        }),
        (child) => terminate(child, closed),
      );
      let stdinFailure: unknown = null;
      const fail = (error: P4SpawnError) => {
        Queue.failCauseUnsafe(queue, Cause.fail(error));
      };
      child.on('error', (cause) => fail(spawnError(invocation, 'p4 failed.', cause)));
      child.stdout.on('error', (cause) => fail(spawnError(invocation, 'Reading p4 output failed.', cause)));
      child.stderr.on('error', (cause) => fail(spawnError(invocation, 'Reading p4 output failed.', cause)));
      // p4 may exit before reading its input, for example when it cannot connect.
      // Its exit then explains the failure; a broken pipe only matters if it exits zero.
      child.stdin.on('error', (cause) => {
        stdinFailure = cause;
      });
      child.stdout.on('data', (bytes: Buffer) => {
        Queue.offerUnsafe(queue, { _tag: 'stdout', bytes });
      });
      child.stderr.on('data', (bytes: Buffer) => {
        Queue.offerUnsafe(queue, { _tag: 'stderr', bytes });
      });
      child.on('close', (code) => {
        resolveClosed();
        if (code === 0 && stdinFailure !== null) {
          fail(spawnError(invocation, 'Writing p4 input failed.', stdinFailure));
          return;
        }
        Queue.offerUnsafe(queue, { _tag: 'exit', code });
        Queue.endUnsafe(queue);
      });
      child.stdin.end(invocation.input);
    }),
  );
}

/** Runs `p4` with Node's `child_process`. */
export const NodeP4Executor: Layer.Layer<P4Executor> = Layer.succeed(P4Executor, { run: runNodeProcess });
