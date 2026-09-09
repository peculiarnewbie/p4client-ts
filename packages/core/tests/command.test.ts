import { describe, expect, it } from "bun:test";
import { runCommand, watchCommand } from "../src/internal/command.js";
import { P4TimeoutError } from "../src/public/errors.js";

const inlineScript = [
  "process.stdout.write('out-1 pa');",
  "setTimeout(() => process.stdout.write('rtial\\nout-2\\n'), 5);",
  "process.stderr.write('err-1');",
  "setTimeout(() => process.stderr.write(' tail\\nerr-2\\n'), 1);",
  "setTimeout(() => process.exit(0), 15);"
].join("");

describe("command streaming", () => {
  it('fails the event stream as well as the result when spawn throws synchronously', async () => {
    const handle = watchCommand('', []);
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(Error);
    await expect(handle.result).rejects.toBeInstanceOf(Error);
  });

  it('reports missing executables when events are consumed before the result', async () => {
    const handle = watchCommand('p4-ts-nonexistent-executable-audit', []);
    const consume = async () => {
      for await (const event of handle.events) void event;
    };
    await expect(consume()).rejects.toBeInstanceOf(Error);
    await expect(handle.result).rejects.toBeInstanceOf(Error);
  });

  it('captures large buffered output without an event queue limit', async () => {
    const result = await runCommand(process.execPath, [
      '-e', "process.stdout.write('line\\n'.repeat(50000))"
    ]);
    expect(result.stdout).toBe('line\n'.repeat(50000));
    expect(result.exitCode).toBe(0);
  });

  it('rejects timer overflow instead of scheduling an almost immediate timeout', async () => {
    await expect(runCommand(process.execPath, ['-e', ''], { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow('at most 2147483647');
  });

  it('handles stdin errors when the child exits before reading its input', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(0)'], {
      input: 'x'.repeat(8 * 1024 * 1024)
    })).rejects.toBeInstanceOf(Error);
  });

  it("emits incremental stdout and stderr lines while preserving the final buffers", async () => {
    const handle = watchCommand(process.execPath, ["-e", inlineScript]);
    const events = [];

    for await (const event of handle.events) {
      events.push(event);
    }

    const result = await handle.result;

    expect(events[0]).toEqual({ type: 'start', command: process.execPath, args: ['-e', inlineScript] });
    expect(events.at(-1)).toEqual({ type: 'exit', exitCode: 0 });
    // stdout and stderr are independent pipes; their relative delivery order is unspecified.
    expect(events.filter((event) => event.type === 'line' && event.source === 'stderr')).toEqual([
      { type: "line", source: "stderr", line: "err-1 tail" },
      { type: "line", source: "stderr", line: "err-2" }
    ]);
    expect(events.filter((event) => event.type === 'line' && event.source === 'stdout')).toEqual([
      { type: "line", source: "stdout", line: "out-1 partial" },
      { type: "line", source: "stdout", line: "out-2" }
    ]);

    expect(result.stdout).toBe("out-1 partial\nout-2\n");
    expect(result.stderr).toBe("err-1 tail\nerr-2\n");
    expect(result.exitCode).toBe(0);
  });

  it("keeps the buffered command helper behavior unchanged", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('ok\\n')"]))
      .resolves
      .toMatchObject({
        stdout: "ok\n",
        stderr: "",
        exitCode: 0
      });
  });

  it("kills timed out commands and throws a typed timeout error", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late'), 200)"], {
        timeoutMs: 25
      })
    ).rejects.toBeInstanceOf(P4TimeoutError);
  });

  it("fails watched commands with the same timeout error surface", async () => {
    const handle = watchCommand(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
      timeoutMs: 25
    });

    await expect(handle.result).rejects.toBeInstanceOf(P4TimeoutError);

    try {
      for await (const _event of handle.events) {
        void _event;
      }
      throw new Error("expected timeout while consuming events");
    } catch (error) {
      expect(error).toBeInstanceOf(P4TimeoutError);
    }
  });

  it("aborts a running command when the signal fires", async () => {
    const controller = new AbortController();
    const resultPromise = runCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('late'), 500)"],
      { signal: controller.signal }
    );

    controller.abort();

    await expect(resultPromise).rejects.toThrow();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 500)"], {
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();
  });
});
