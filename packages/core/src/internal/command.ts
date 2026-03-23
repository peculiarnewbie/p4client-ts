import { spawn } from "node:child_process";
import type {
  P4CommandOptions,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4CommandStreamSource
} from "../public/types.js";

function createAsyncEventQueue<T>(): {
  iterable: AsyncIterable<T>;
  push: (event: T) => void;
  fail: (error: unknown) => void;
  finish: () => void;
} {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let error: unknown = null;
  let done = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ done: false, value: values.shift()! });
          }
          if (error !== null) {
            return Promise.reject(error);
          }
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }

          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        }
      };
    }
  };

  const push = (event: T) => {
    if (done || error !== null) return;

    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }

    values.push(event);
  };

  const fail = (nextError: unknown) => {
    if (done || error !== null) return;

    error = nextError;
    while (waiters.length > 0) {
      waiters.shift()!.reject(nextError);
    }
  };

  const finish = () => {
    if (done || error !== null) return;

    done = true;
    while (waiters.length > 0) {
      waiters.shift()!.resolve({ done: true, value: undefined });
    }
  };

  return { iterable, push, fail, finish };
}

function flushCompleteLines(
  source: P4CommandStreamSource,
  chunk: string,
  carry: string,
  emit: (source: P4CommandStreamSource, line: string) => void
): string {
  const combined = carry + chunk;
  const lines = combined.split(/\r?\n/);
  const nextCarry = lines.pop() ?? "";

  for (const line of lines) {
    emit(source, line);
  }

  return nextCarry;
}

export async function runCommand(
  command: string,
  args: string[],
  options: P4CommandOptions = {}
): Promise<P4CommandResult> {
  const handle = watchCommand(command, args, options);

  void (async () => {
    for await (const _event of handle.events) {
      void _event;
    }
  })().catch(() => {
    // The result promise is the authoritative error surface for buffered calls.
  });

  return await handle.result;
}

export function watchCommand(
  command: string,
  args: string[],
  options: P4CommandOptions = {}
): P4OperationHandle<P4CommandStreamEvent, P4CommandResult> {
  const queue = createAsyncEventQueue<P4CommandStreamEvent>();

  const result = new Promise<P4CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    let stdoutCarry = "";
    let stderrCarry = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    queue.push({ type: "start", command, args });

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutCarry = flushCompleteLines("stdout", chunk, stdoutCarry, (source, line) => {
        queue.push({ type: "line", source, line });
      });
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrCarry = flushCompleteLines("stderr", chunk, stderrCarry, (source, line) => {
        queue.push({ type: "line", source, line });
      });
    });

    child.on("error", (error) => {
      queue.fail(error);
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (stdoutCarry.length > 0) {
        queue.push({ type: "line", source: "stdout", line: stdoutCarry });
      }
      if (stderrCarry.length > 0) {
        queue.push({ type: "line", source: "stderr", line: stderrCarry });
      }

      queue.push({ type: "exit", exitCode: exitCode ?? 1 });
      queue.finish();

      resolve({
        command,
        args,
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });

  return {
    events: queue.iterable,
    result
  };
}
