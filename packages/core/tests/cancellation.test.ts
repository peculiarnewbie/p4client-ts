import { describe, expect, it } from 'bun:test';
import { Deferred, Effect, Exit, Stream } from 'effect';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsyncEventQueue } from '../src/internal/async-queue.js';
import { watchCommand } from '../src/internal/command.js';
import { P4Client } from '../src/public/client.js';
import { P4ParseError } from '../src/public/errors.js';
import { P4DepotPathSchema, P4FileActionSchema } from '../src/public/schemas.js';
import { createP4Service } from '../src/public/service.js';
import { resolveP4SettingsWithDetails } from '../src/public/settings.js';
import type { P4CommandStreamEvent, P4StreamingCommandExecutor } from '../src/public/types.js';

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!signal) throw new Error('Expected an operation signal');
  return signal;
}

function awaitAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });
}

/** An abort-aware producer whose completion can be held independently of its events. */
function controlledStream(firstLine?: string) {
  const started = Deferred.makeUnsafe<AbortSignal>();
  const aborted = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let finished = false;
  const executor: P4StreamingCommandExecutor = (command, args, options) => {
    const signal = requireSignal(options.signal);
    const queue = createAsyncEventQueue<P4CommandStreamEvent>();
    if (firstLine) queue.push({ type: 'line', source: 'stdout', line: firstLine });
    const result = Effect.runPromise(Effect.gen(function* () {
      yield* Deferred.succeed(started, signal);
      yield* awaitAbort(signal);
      yield* Deferred.succeed(aborted, undefined);
      yield* Deferred.await(release);
      finished = true;
      // Even a custom adapter that resolves on abort must not become a success.
      return { command, args, stdout: '', stderr: '', exitCode: 0 };
    }));
    void result.then(queue.finish, queue.fail);
    return { events: queue.iterable, result };
  };
  return { executor, started, aborted, release, isFinished: () => finished };
}

describe('cancellation ownership', () => {
  it('joins an interrupted Effect operation without aborting its caller signal', async () => {
    const caller = new AbortController();
    const runtime = new AbortController();
    const started = Deferred.makeUnsafe<AbortSignal>();
    const aborted = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let finished = false;
    let settled = false;
    const service = createP4Service({
      executor: (command, args, options) => Effect.runPromise(Effect.gen(function* () {
        const signal = requireSignal(options.signal);
        yield* Deferred.succeed(started, signal);
        yield* awaitAbort(signal);
        yield* Deferred.succeed(aborted, undefined);
        yield* Deferred.await(release);
        finished = true;
        return { command, args, stdout: '', stderr: '', exitCode: 0 };
      }))
    });
    const operation = Effect.runPromiseExit(service.listDepots({ signal: caller.signal }), {
      signal: runtime.signal
    }).then((exit) => { settled = true; return exit; });
    const owned = await Effect.runPromise(Deferred.await(started));
    try {
      expect(owned).not.toBe(caller.signal);
      runtime.abort();
      await Effect.runPromise(Deferred.await(aborted));
      expect(settled).toBe(false);
      expect(finished).toBe(false);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      runtime.abort();
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
    const exit = await operation;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(finished).toBe(true);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('isolates concurrent calls and forwards an explicit caller abort', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const starts = [Deferred.makeUnsafe<AbortSignal>(), Deferred.makeUnsafe<AbortSignal>()];
    const releases = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    let calls = 0;
    const service = createP4Service({
      executor: (command, args, options) => {
        const index = calls++;
        const started = starts[index];
        const release = releases[index];
        if (!started || !release) throw new Error('Unexpected extra command');
        return Effect.runPromise(Effect.gen(function* () {
          yield* Deferred.succeed(started, requireSignal(options.signal));
          yield* Deferred.await(release);
          return { command, args, stdout: '', stderr: '', exitCode: 0 };
        }));
      }
    });
    const one = Effect.runPromiseExit(service.listDepots({ signal: first.signal }));
    const two = Effect.runPromiseExit(service.listDepots({ signal: second.signal }));
    const signals = await Effect.runPromise(Effect.forEach(starts, Deferred.await));
    first.abort(new Error('first cancelled'));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await Effect.runPromise(Effect.forEach(releases, (release) => Deferred.succeed(release, undefined)));
    expect(Exit.isFailure(await one)).toBe(true);
    expect(Exit.isSuccess(await two)).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(0);
  });

  it('stops dependent commands and does not cache a cancelled environment lookup', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel environment');
    const calls: string[][] = [];
    const client = new P4Client({ executor: async (command, args) => {
      calls.push(args);
      if (calls.length === 1) controller.abort(reason);
      return { command, args, stdout: 'User name: tester\nClient host: test-host', stderr: '', exitCode: 0 };
    } });
    await expect(client.listWorkspaces({ signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toEqual([['info']]);
    await client.getEnvironment();
    expect(calls).toEqual([['info'], ['info']]);
    await expect(client.getEnvironment({ signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(2);
  });

  it('stops print after metadata lookup is cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new P4Client({ executor: async (command, args, options) => {
      calls++;
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return { command, args, stdout: '{"depotFile":"//depot/a","rev":"1","type":"text"}', stderr: '', exitCode: 0 };
    } });
    await expect(client.printFile('//depot/a', { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not swallow cancelled local settings or cache fallback success', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel settings');
    let calls = 0;
    const client = new P4Client({ executor: async (command, args) => {
      if (++calls === 1) {
        controller.abort(reason);
        throw reason;
      }
      return { command, args, stdout: 'P4USER=tester', stderr: '', exitCode: 0 };
    } });
    await expect(client.getEnvironment({ mode: 'local', settingsSources: ['cli'], signal: controller.signal }))
      .rejects.toBe(reason);
    await expect(client.getEnvironment({ mode: 'local', settingsSources: ['cli'] }))
      .resolves.toMatchObject({ p4User: 'tester' });
    expect(calls).toBe(2);
  });

  it('passes cancellation into settings readers and stops fallback resolution', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel reader');
    let fallbackCalls = 0;
    await expect(resolveP4SettingsWithDetails({}, {
      signal: controller.signal,
      sources: ['registry', 'p4v-app-settings'],
      readRegistry: async (signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
        throw reason;
      },
      readP4vAppSettings: async () => { fallbackCalls++; return {}; }
    })).rejects.toBe(reason);
    expect(fallbackCalls).toBe(0);
    await expect(resolveP4SettingsWithDetails({}, { sources: [], signal: controller.signal }))
      .rejects.toBe(reason);
  });

  it('joins active materialization commands and skips queued files on abort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p4-ts-cancel-'));
    const controller = new AbortController();
    const started = Deferred.makeUnsafe<void>();
    let calls = 0;
    let finished = 0;
    const client = new P4Client({ executor: (command, args, options) => Effect.runPromise(Effect.gen(function* () {
      if (++calls === 2) yield* Deferred.succeed(started, undefined);
      yield* awaitAbort(requireSignal(options.signal));
      finished++;
      return { command, args, stdout: '', stderr: '', exitCode: 0 };
    })) });
    const result = client.materializeDepotFiles({
      directory, maxFiles: 3, concurrency: 2, signal: controller.signal,
      files: ['a', 'b', 'c'].map((name) => ({
        depotFile: P4DepotPathSchema.makeUnsafe(`//depot/${name}`),
        revision: 1, changelist: 1, action: P4FileActionSchema.makeUnsafe('edit'), type: 'text'
      }))
    });
    try {
      await Effect.runPromise(Deferred.await(started));
      controller.abort();
      await expect(result).rejects.toThrow();
      expect(calls).toBe(2);
      expect(finished).toBe(2);
    } finally {
      controller.abort();
      await result.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels and joins a service stream when take stops consuming', async () => {
    const producer = controlledStream();
    const caller = new AbortController();
    const service = createP4Service({ streamExecutor: producer.executor });
    let settled = false;
    const result = Effect.runPromise(service.streamSync({ signal: caller.signal }).pipe(
      Stream.take(1), Stream.runCollect
    )).then((events) => { settled = true; return events; });
    try {
      await Effect.runPromise(Deferred.await(producer.aborted));
      expect(settled).toBe(false);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(producer.release, undefined));
    }
    expect(await result).toHaveLength(1);
    expect(producer.isFinished()).toBe(true);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('interrupts a service stream with a pending event read', async () => {
    const producer = controlledStream();
    const runtime = new AbortController();
    const service = createP4Service({ streamExecutor: producer.executor });
    const result = Effect.runPromiseExit(service.streamPreviewReconcile().pipe(Stream.runDrain), {
      signal: runtime.signal
    });
    await Effect.runPromise(Deferred.await(producer.started));
    runtime.abort();
    await Effect.runPromise(Deferred.await(producer.aborted));
    await Effect.runPromise(Deferred.succeed(producer.release, undefined));
    expect(Exit.hasInterrupts(await result)).toBe(true);
    expect(producer.isFinished()).toBe(true);
  });

  it('cancels and joins the producer before surfacing a schema failure', async () => {
    const producer = controlledStream('{"depotFile":"//depot/a","action":"refresh","rev":"invalid"}');
    const client = new P4Client({ streamExecutor: producer.executor });
    const handle = client.watchSync();
    let settled = false;
    void handle.result.then(() => { settled = true; }, () => { settled = true; });
    try {
      await Effect.runPromise(Deferred.await(producer.aborted));
      expect(settled).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(producer.release, undefined));
    }
    await expect(handle.result).rejects.toBeInstanceOf(P4ParseError);
    expect(producer.isFinished()).toBe(true);
  });

  it('does not retain caller listeners when watch argument validation fails', () => {
    const controller = new AbortController();
    const client = new P4Client({ streamExecutor: () => { throw new Error('Must not launch'); } });
    expect(() => client.watch(['info'], { signal: controller.signal, timeoutMs: 0 })).toThrow();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('joins the producer when an event source rejects a read', async () => {
    const producer = controlledStream();
    const failure = new Error('event read failed');
    const client = new P4Client({ streamExecutor: (command, args, options) => {
      const handle = producer.executor(command, args, options);
      return {
        result: handle.result,
        events: { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }) }
      };
    } });
    const handle = client.watchSync();
    await Effect.runPromise(Deferred.await(producer.aborted));
    await Effect.runPromise(Deferred.succeed(producer.release, undefined));
    await expect(handle.result).rejects.toBe(failure);
    expect(producer.isFinished()).toBe(true);
  });

  it.each(['abort', 'timeout'] as const)('waits for process exit before rejecting on %s', async (mode) => {
    const controller = new AbortController();
    const handle = watchCommand(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"
    ], { signal: controller.signal, ...(mode === 'timeout' ? { timeoutMs: 1000 } : {}) });
    let sawPid = false;
    try {
      for await (const event of handle.events) {
        if (event.type === 'line' && event.source === 'stdout') {
          const pid = Number(event.line);
          sawPid = true;
          if (mode === 'abort') controller.abort();
          await expect(handle.result).rejects.toThrow();
          expect(() => process.kill(pid, 0)).toThrow();
          break;
        }
      }
      expect(sawPid).toBe(true);
    } finally {
      controller.abort();
      await handle.result.catch(() => undefined);
    }
  });

  it('terminates a real process before returning from its event iterator', async () => {
    const caller = new AbortController();
    const handle = watchCommand(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"
    ], { signal: caller.signal });
    let pid: number | undefined;
    try {
      for await (const event of handle.events) {
        if (event.type === 'line' && event.source === 'stdout') {
          pid = Number(event.line);
          break;
        }
      }
      expect(pid).toBeGreaterThan(0);
      const childPid = pid;
      if (childPid !== undefined) expect(() => process.kill(childPid, 0)).toThrow();
      await expect(handle.result).rejects.toThrow();
      expect(caller.signal.aborted).toBe(false);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    } finally {
      caller.abort();
      await handle.result.catch(() => undefined);
    }
  });

  it('terminates a real process when an Effect stream is consumed partially', async () => {
    const service = createP4Service({ streamExecutor: (_command, _args, options) => watchCommand(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log(JSON.stringify({depotFile:'//depot/a',action:'refresh',fileSize:process.pid})); setInterval(() => {}, 1000);"
    ], options) });
    const events = await Effect.runPromise(service.streamSync().pipe(Stream.take(2), Stream.runCollect));
    const progress = events.find((event) => event.type === 'progress');
    expect(progress?.type).toBe('progress');
    if (progress?.type === 'progress' && progress.item.fileSize !== null) {
      const childPid = progress.item.fileSize;
      expect(() => process.kill(childPid, 0)).toThrow();
    }
  });
});
