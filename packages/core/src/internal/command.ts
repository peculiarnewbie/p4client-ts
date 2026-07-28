import { spawn } from "node:child_process";
import { createAsyncEventQueue } from "./async-queue.js";
import { P4TimeoutError } from "../public/errors.js";
import { redactCommandArgs } from "../public/command-format.js";
import type {
  P4CommandOptions,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4CommandStreamSource
} from "../public/types.js";

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
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    queue.push({ type: "start", command, args: redactCommandArgs(args) });

    const clearCommandTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearCommandTimeout();
      queue.fail(error);
      reject(error);
    };

    const resolveOnce = (resultValue: P4CommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearCommandTimeout();
      resolve(resultValue);
    };

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
      rejectOnce(error);
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      if (stdoutCarry.length > 0) {
        queue.push({ type: "line", source: "stdout", line: stdoutCarry });
      }
      if (stderrCarry.length > 0) {
        queue.push({ type: "line", source: "stderr", line: stderrCarry });
      }

      queue.push({ type: "exit", exitCode: exitCode ?? 1 });
      queue.finish();
      resolveOnce({
        command,
        args,
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        const timeoutError = new P4TimeoutError(command, args, options.timeoutMs!, stdout, stderr);
        child.kill();
        rejectOnce(timeoutError);
      }, options.timeoutMs);
    }

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
