import { Effect } from 'effect';
import { spawn } from 'node:child_process';
import { createAsyncEventQueue } from './async-queue.js';
import { createCancellationScope, ownOperation } from './cancellation.js';
import { P4ClientOperationError, P4TimeoutError } from '../public/errors.js';
import { redactCommandArgs } from '../public/command-format.js';
import { requirePositiveTimeoutMs } from '../public/helpers.js';
import type {
  P4CommandOptions,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4CommandStreamSource
} from '../public/types.js';

function flushCompleteLines(
  source: P4CommandStreamSource,
  chunk: string,
  carry: string,
  emit: (event: P4CommandStreamEvent) => void
): string {
  const lines = (carry + chunk).split(/\r?\n/);
  const nextCarry = lines.pop() ?? '';
  for (const line of lines) {
    emit({ type: 'line', source, line });
  }
  return nextCarry;
}

function executeCommand(
  command: string,
  args: string[],
  options: P4CommandOptions,
  emit?: (event: P4CommandStreamEvent) => void
): Effect.Effect<P4CommandResult, P4ClientOperationError | P4TimeoutError> {
  return Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () => {
        options.signal?.throwIfAborted();
        if (options.timeoutMs !== undefined) {
          requirePositiveTimeoutMs(options.timeoutMs);
        }
        return spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: 'pipe',
          signal: options.signal,
          killSignal: 'SIGKILL',
          windowsHide: true
        });
      },
      catch: (error) => new P4ClientOperationError('Unable to launch command.', error)
    });

    return yield* Effect.callback<P4CommandResult, P4ClientOperationError | P4TimeoutError>((resume) => {
      let stdout = '';
      let stderr = '';
      let stdoutCarry = '';
      let stderrCarry = '';
      let settled = false;
      let failure: P4ClientOperationError | P4TimeoutError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const clearCommandTimeout = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };
      const fail = (error: Error) => {
        if (settled || failure !== undefined) return;
        clearCommandTimeout();
        failure = error instanceof P4TimeoutError
          ? error
          : new P4ClientOperationError('Command I/O failed.', error);
        // Cancellation must also terminate children that ignore SIGTERM.
        if (!child.killed) child.kill('SIGKILL');
        // Release pipes explicitly: aborting during a data callback can otherwise
        // leave a readable open on Bun/Windows even after the process exits.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (child.pid === undefined) {
          settled = true;
          resume(Effect.fail(failure));
        }
      };

      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      emit?.({ type: 'start', command, args: redactCommandArgs(args) });

      child.stdout.on('data', (chunk: string) => {
        if (settled || failure !== undefined) return;
        stdout += chunk;
        if (emit) stdoutCarry = flushCompleteLines('stdout', chunk, stdoutCarry, emit);
      });
      child.stderr.on('data', (chunk: string) => {
        if (settled || failure !== undefined) return;
        stderr += chunk;
        if (emit) stderrCarry = flushCompleteLines('stderr', chunk, stderrCarry, emit);
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearCommandTimeout();
        if (failure !== undefined) {
          resume(Effect.fail(failure));
          return;
        }
        if (stdoutCarry) emit?.({ type: 'line', source: 'stdout', line: stdoutCarry });
        if (stderrCarry) emit?.({ type: 'line', source: 'stderr', line: stderrCarry });
        emit?.({ type: 'exit', exitCode: exitCode ?? 1 });
        resume(Effect.succeed({ command, args, stdout, stderr, exitCode: exitCode ?? 1 }));
      });

      const timeoutMs = options.timeoutMs;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          fail(new P4TimeoutError(command, args, timeoutMs, stdout, stderr));
        }, timeoutMs);
      }
      try {
        child.stdin.end(options.input);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error), { cause: error }));
      }

      return Effect.sync(() => {
        clearCommandTimeout();
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
        }
      });
    });
  });
}

function rethrowCommandError(error: unknown): never {
  // Preserve native spawn / AbortError identity at the existing Promise API boundary.
  throw error instanceof P4ClientOperationError ? error.cause : error;
}

export function runCommand(
  command: string,
  args: string[],
  options: P4CommandOptions = {}
): Promise<P4CommandResult> {
  // Buffered callers do not need line splitting, an event queue, or a drain task.
  return Effect.runPromise(executeCommand(command, args, options)).catch(rethrowCommandError);
}

export function watchCommand(
  command: string,
  args: string[],
  options: P4CommandOptions = {}
): P4OperationHandle<P4CommandStreamEvent, P4CommandResult> {
  const queue = createAsyncEventQueue<P4CommandStreamEvent>();
  const scope = createCancellationScope(options.signal);
  const result = Effect.runPromise(executeCommand(command, args, { ...options, signal: scope.signal }, queue.push))
    .catch(rethrowCommandError);
  // Observe rejection immediately: callers may consume events before awaiting result.
  // This also closes the queue when spawn throws synchronously.
  void result.then(queue.finish, queue.fail);
  return ownOperation({ events: queue.iterable, result }, scope);
}
