import { Effect, Stream } from 'effect';
import { runNodeProcess } from '../../src/node/executor.js';
import type { P4Invocation } from '../../src/exec/executor.js';

/** Capture bytes as text for fixture administration; protocol tests use the engine. */
export function captureProcess(invocation: P4Invocation, timeoutMs = 30_000) {
  return runNodeProcess(invocation).pipe(
    Stream.runFold(() => ({ stdout: [] as Uint8Array[], stderr: [] as Uint8Array[], exitCode: 0 }), (result, event) => {
      if (event._tag === 'exit') result.exitCode = event.code ?? -1;
      else result[event._tag].push(event.bytes);
      return result;
    }),
    Effect.map((result) => ({ stdout: Buffer.concat(result.stdout).toString('utf8'),
      stderr: Buffer.concat(result.stderr).toString('utf8'), exitCode: result.exitCode })),
    Effect.timeout(timeoutMs),
  );
}
