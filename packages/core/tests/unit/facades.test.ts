import { describe, expect, it } from 'bun:test';
import { Effect, Fiber, Layer, Schema, Stream } from 'effect';
import { fileURLToPath } from 'node:url';
import { P4 } from '../../src/P4.js';
import { configLayer, mergeOptions, resolveOptions } from '../../src/engine/config.js';
import { P4Executor } from '../../src/exec/executor.js';
import { P4CommandError, P4ParseError, P4ReadOnlyError } from '../../src/errors.js';
import { ops } from '../../src/ops.js';
import { runNodeProcess } from '../../src/node/index.js';
import { createP4Client, createP4ClientFromLayer } from '../../src/promise/index.js';
import { layerTest, readWireFixtures, replayExecutor, scriptedExecutor } from '../../src/testing/index.js';
import type { P4ClientOptions } from '../../src/engine/config.js';
import type { P4Invocation, P4ProcessEvent } from '../../src/exec/executor.js';
import type { P4Service } from '../../src/P4.js';
import type { P4PromiseClient, P4PromiseWatch } from '../../src/promise/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>(): T => true as T;
const empty = { items: [], messages: [] };
const fixtures = readWireFixtures(fileURLToPath(new URL('../fixtures/wire/', import.meta.url)));
const row = '{"revision":"3"}\n';

function serviceLayer(executor: Layer.Layer<P4Executor>, options: P4ClientOptions = {}) {
  return P4.layer.pipe(Layer.provideMerge(Layer.merge(configLayer(options), executor)));
}

function clientFor(executor: Layer.Layer<P4Executor>, options: P4ClientOptions = {}) {
  const derive = (config: P4ClientOptions) => serviceLayer(executor, config);
  return createP4ClientFromLayer(derive(options), derive, options);
}

function pendingExecutor() {
  let started!: () => void;
  let released!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const closed = new Promise<void>((resolve) => { released = resolve; });
  const scoped = Layer.succeed(P4Executor, {
    run: () => Stream.fromEffect(Effect.sync(started).pipe(
      Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(released)),
    )) as Stream.Stream<P4ProcessEvent>,
  });
  return { executor: scoped, ready, closed };
}

describe('Phase 5 facades', () => {
  it('derives both service and Promise method keys from ops', async () => {
    assert<Equal<Exclude<keyof P4Service, 'watch'>, keyof typeof ops>>();
    assert<Equal<keyof P4Service['watch'], keyof typeof ops>>();
    assert<Equal<Exclude<keyof P4PromiseClient, 'watch' | 'with' | 'dispose' | 'resolveConnection' | 'workspaceRootExists' | 'findWorkspaceForPath' | 'materializeDepotFiles'>, keyof typeof ops>>();
    assert<Equal<Exclude<keyof P4PromiseWatch, 'findWorkspaceForPath' | 'materializeDepotFiles'>, keyof typeof ops>>();
    const service = await Effect.runPromise(P4.asEffect().pipe(
      Effect.provide(serviceLayer(scriptedExecutor(() => ({ stdout: row })))),
    ));
    const client = clientFor(scriptedExecutor(() => ({ stdout: row })));
    try {
      expect(Object.keys(service).filter((key) => key !== 'watch').sort()).toEqual(Object.keys(ops).sort());
      expect(Object.keys(client.watch).sort()).toEqual([...Object.keys(ops), 'findWorkspaceForPath', 'materializeDepotFiles'].sort());
      expect((await Effect.runPromise(service.runTagged({ args: ['info'] }))).items).toHaveLength(1);
    } finally { await client.dispose(); }
  });

  it('keeps real tagged errors in the service error channel', async () => {
    const error = await Effect.runPromise(Effect.flatMap(P4.asEffect(), (p4) =>
      p4.getEnvironment({})).pipe(
      Effect.catch((cause) => Effect.succeed(cause)),
      Effect.provide(serviceLayer(replayExecutor([fixtures.get('server-unreachable-summary')!]))),
    ));
    expect(error).toBeInstanceOf(P4CommandError);
  });

  it('scopes P4.with to one program, merges connection fields and restores siblings', async () => {
    const calls: P4Invocation[] = [];
    const executor = scriptedExecutor((invocation) => {
      calls.push(invocation);
      return { stdout: row };
    });
    const command = Effect.flatMap(P4.asEffect(), (p4) => p4.runTagged({ args: ['info'] }));
    await Effect.runPromise(Effect.gen(function* () {
      const p4 = yield* P4;
      yield* command;
      yield* p4.runTagged({ args: ['info'] }).pipe(P4.with({ connection: { client: 'second' } }));
      yield* Stream.runDrain(p4.watch.runTagged({ args: ['info'] })).pipe(
        P4.with({ connection: { client: 'third' } }),
      );
      yield* command;
    }).pipe(Effect.provide(serviceLayer(executor, { connection: { port: '1666', client: 'first' } }))));
    expect(calls.map((call) => call.args[call.args.indexOf('-c') + 1])).toEqual(['first', 'second', 'third', 'first']);
    expect(calls.every((call) => call.args.includes('1666'))).toBe(true);
  });

  it('supports partial service mocks and fails loudly for unmocked calls', async () => {
    const layer = layerTest({ listDepots: () => Effect.succeed(empty) });
    const result = await Effect.runPromise(Effect.flatMap(P4.asEffect(), (p4) => p4.listDepots({})).pipe(
      Effect.provide(layer),
    ));
    expect(result).toEqual(empty);
    const events = await Effect.runPromise(Stream.unwrap(Effect.map(P4.asEffect(), (p4) =>
      p4.watch.listDepots({}))).pipe(Stream.runCollect, Effect.provide(layer)));
    expect(events).toEqual([{ _tag: 'done', result: empty }]);
    await expect(Effect.runPromise(Effect.flatMap(P4.asEffect(), (p4) => p4.listUsers({})).pipe(
      Effect.provide(layer),
    ))).rejects.toThrow('Unmocked P4 operation: listUsers');
  });

  it('runs and watches typed tagged schemas and rejects malformed data', async () => {
    const client = clientFor(scriptedExecutor(() => ({ stdout: row })));
    try {
      const schema = Schema.Struct({ revision: Schema.NumberFromString });
      const result = await client.runTagged({ args: ['info'], schema });
      expect(result.items).toEqual([{ revision: 3 }]);
      const handle = client.watch.runTagged({ args: ['info'], schema });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(await handle.result).toEqual(result);
      expect(events[0]).toEqual({ _tag: 'item', item: { revision: 3 } });
      await expect(client.runTagged({ args: ['info'], schema: Schema.Struct({ missing: Schema.String }) }))
        .rejects.toBeInstanceOf(P4ParseError);
    } finally { await client.dispose(); }
  });

  it('watches one strict replay and returns the same result without a second invocation', async () => {
    let calls = 0;
    const fixture = fixtures.get('sync-force-preview')!;
    expect(fixture).toBeDefined();
    const replay = replayExecutor([fixture]);
    const counted = Layer.effect(P4Executor, Effect.map(P4Executor.asEffect(), (executor) => ({
      run: (invocation: P4Invocation) => { calls++; return executor.run(invocation); },
    }))).pipe(Layer.provide(replay));
    const client = clientFor(counted);
    try {
      const options = { force: true, fileSpec: '//p4ts/main/wire/text.txt' };
      const expected = await client.previewSync(options);
      calls = 0;
      const handle = client.watch.previewSync(options);
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(await handle.result).toEqual(expected);
      expect(events.at(-1)).toEqual({ _tag: 'done', result: expected });
      expect(calls).toBe(1);
    } finally { await client.dispose(); }
  });

  it('settles a watched result without consuming events', async () => {
    const client = clientFor(scriptedExecutor(() => ({ stdout: row })));
    try {
      const handle = client.watch.runTagged({ args: ['info'] });
      expect((await handle.result).items).toHaveLength(1);
      const tags = [];
      for await (const event of handle.events) tags.push(event._tag);
      expect(tags.at(-1)).toBe('done');
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow('only be consumed once');
    } finally { await client.dispose(); }
  });

  it('preserves the read-only guard through both facades', async () => {
    const client = clientFor(scriptedExecutor(() => { throw new Error('must not run'); }));
    try {
      await expect(client.sync({})).rejects.toBeInstanceOf(P4ReadOnlyError);
      const watched = client.watch.sync({});
      await expect(watched.result).rejects.toBeInstanceOf(P4ReadOnlyError);
      await expect(watched.events[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(P4ReadOnlyError);
    } finally { await client.dispose(); }
  });

  it('derives independent clients without changing the parent connection or env', async () => {
    const calls: P4Invocation[] = [];
    const client = clientFor(scriptedExecutor((invocation) => {
      calls.push(invocation);
      return { stdout: row };
    }), { connection: { port: '1666', client: 'first' }, env: { ONE: '1' } });
    const child = client.with({ connection: { client: 'second' }, env: { TWO: '2' } });
    try {
      await child.runTagged({ args: ['info'] });
      await child.dispose();
      await client.runTagged({ args: ['info'] });
      expect(calls[0]!.args).toContain('second');
      expect(calls[0]!.args).toContain('1666');
      expect(calls[0]!.env).toMatchObject({ ONE: '1', TWO: '2' });
      expect(calls[1]!.args).toContain('first');
      expect(calls[1]!.env.TWO).toBeUndefined();
    } finally { await Promise.all([client.dispose(), child.dispose()]); }
  });

  it('preserves pre-aborted signal reasons without starting the executor', async () => {
    const client = clientFor(scriptedExecutor(() => { throw new Error('must not start'); }));
    const reason = { cancelled: true };
    const signal = AbortSignal.abort(reason);
    try {
      await expect(client.runTagged({ args: ['info'], signal })).rejects.toBe(reason);
      const handle = client.watch.runTagged({ args: ['info'], signal });
      await expect(handle.result).rejects.toBe(reason);
      await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toBe(reason);
    } finally { await client.dispose(); }
  });

  it('aborts active Promise commands and releases the executor before rejection', async () => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    try {
      const result = client.runTagged({ args: ['info'], signal: controller.signal });
      await pending.ready;
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      await pending.closed;
    } finally { await client.dispose(); }
  });

  it('interrupts Effect watch fibers and releases their executor', async () => {
    const pending = pendingExecutor();
    await Effect.runPromise(Effect.gen(function* () {
      const p4 = yield* P4;
      const fiber = yield* Effect.forkChild(Stream.runDrain(p4.watch.runTagged({ args: ['info'] })));
      yield* Effect.promise(() => pending.ready);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => pending.closed);
    }).pipe(Effect.provide(serviceLayer(pending.executor))));
  });

  it('aborts an active Promise watch with the caller reason on both channels', async () => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    const controller = new AbortController();
    const reason = new Error('watch cancelled by caller');
    try {
      const handle = client.watch.runTagged({ args: ['info'], signal: controller.signal });
      const event = handle.events[Symbol.asyncIterator]().next().then(
        () => undefined, (error: unknown) => error,
      );
      await pending.ready;
      controller.abort(reason);
      await expect(handle.result).rejects.toBe(reason);
      expect(await event).toBe(reason);
      await pending.closed;
    } finally { await client.dispose(); }
  });

  it('emits heartbeats and cancels when iteration ends early', async () => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    try {
      const handle = client.watch.runTagged({ args: ['info'], progressIntervalMs: 1 });
      for await (const event of handle.events) {
        expect(event._tag).toBe('progress');
        break;
      }
      await expect(handle.result).rejects.toThrow('iteration ended early');
      await pending.closed;
    } finally { await client.dispose(); }
  });

  it('dispose cancels active watches and rejects subsequent calls', async () => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    const handle = client.watch.runTagged({ args: ['info'] });
    await pending.ready;
    await client.dispose();
    await pending.closed;
    await expect(handle.result).rejects.toThrow('client disposed');
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toThrow('client disposed');
    await expect(client.runTagged({ args: ['info'] })).rejects.toThrow('client disposed');
    await client.dispose();
  });

  it('constructs the Node Promise entry without starting p4', async () => {
    const client = createP4Client({ connection: { isolated: true } });
    expect(Object.isFrozen(client)).toBe(true);
    expect(await client.resolveConnection({ sources: [] })).toMatchObject({ connection: {}, sources: {} });
    expect(await client.workspaceRootExists({ root: process.cwd() })).toBe(true);
    expect(typeof client.materializeDepotFiles).toBe('function');
    expect(typeof client.findWorkspaceForPath).toBe('function');
    await client.dispose();
  });

  it('stopping facade iteration kills and joins a real Node child', async () => {
    let pid = 0;
    const executor = Layer.succeed(P4Executor, {
      run: (invocation) => runNodeProcess({
        ...invocation,
        executable: process.execPath,
        args: ['-e', "process.stdout.write(JSON.stringify({pid: process.pid}) + '\\n'); setInterval(() => {}, 1000)"],
      }),
    });
    const client = clientFor(executor);
    try {
      const handle = client.watch.runTagged({ args: ['info'], schema: Schema.Struct({ pid: Schema.Number }) });
      for await (const event of handle.events) {
        if (event._tag === 'item') {
          pid = event.item.pid;
          break;
        }
      }
      await expect(handle.result).rejects.toThrow('iteration ended early');
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await client.dispose(); }
  });

  it('bounds unconsumed event buffering while allowing the result to finish', async () => {
    const client = clientFor(scriptedExecutor(() => ({ stdout: row.repeat(5) })));
    try {
      const handle = client.watch.runTagged({ args: ['info'], maxBuffered: 1 });
      expect((await handle.result).items).toHaveLength(5);
      const iterator = handle.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value?._tag).toBe('item');
      await expect(iterator.next()).rejects.toThrow('maxBuffered=1');
    } finally { await client.dispose(); }
  });


  it('clears inherited configuration explicitly and leaves omitted fields intact', async () => {
    const base = resolveOptions({ cwd: 'parent', timeoutMs: 100, executable: 'custom-p4' });
    expect(mergeOptions(base, {})).toEqual(base);
    expect(mergeOptions(base, { cwd: undefined, timeoutMs: undefined, executable: undefined }))
      .toMatchObject({ cwd: undefined, timeoutMs: undefined, executable: 'p4' });
    const calls: P4Invocation[] = [];
    const executor = scriptedExecutor((invocation) => {
      calls.push(invocation);
      return { stdout: row };
    });
    const parent = clientFor(executor, base);
    const child = parent.with({ cwd: undefined, timeoutMs: undefined, executable: undefined });
    try {
      await child.runTagged({ args: ['info'] });
      await parent.runTagged({ args: ['info'] });
      expect(calls.map((call) => [call.cwd, call.executable])).toEqual([
        [undefined, 'p4'], ['parent', 'custom-p4'],
      ]);
    } finally { await child.dispose(); await parent.dispose(); }
    await Effect.runPromise(Effect.flatMap(P4.asEffect(), (p4) =>
      p4.runTagged({ args: ['info'] }).pipe(P4.with({ cwd: undefined, timeoutMs: undefined, executable: undefined })))
      .pipe(Effect.provide(serviceLayer(executor, base))));
    expect(calls.at(-1)).toMatchObject({ executable: 'p4' });
    expect(calls.at(-1)?.cwd).toBeUndefined();
  });

  it('reports environment messages separately before the done result', async () => {
    const client = clientFor(scriptedExecutor(() => ({
      stdout: '{"userName":"u"}\n{"data":"FYI","severity":1,"generic":0}\n',
    })));
    try {
      const handle = client.watch.getEnvironment({});
      const events: Array<import('../../src/engine/operation.js').P4OperationEvent<never, import('../../src/commands/environment.js').P4Environment>> = [];
      for await (const event of handle.events) events.push(event);
      const result = await handle.result;
      expect(events.filter((event) => event._tag === 'message').map((event) => event.message))
        .toEqual(result.messages);
      expect(result.messages).toHaveLength(1);
      expect(events.at(-1)).toEqual({ _tag: 'done', result });
    } finally { await client.dispose(); }
  });

  it.each([
    ['previewSync', 'files', {}],
    ['printFile', 'files', { file: '//d/a' }],
    ['getFileHistory', 'revisions', { file: '//d/a' }],
    ['listChangelists', 'changes', { status: 'submitted' }],
  ] as const)('starts %s heartbeats in %s before any output', async (name, unit, options) => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    try {
      type Watch = (options: object) => { events: AsyncIterable<{ _tag: string; progress?: { unit: string; completed: number } }>; result: Promise<unknown> };
      const handle = (client.watch[name] as Watch)({ ...options, progressIntervalMs: 5 });
      await pending.ready;
      const iterator = handle.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({ _tag: 'progress', progress: { unit, completed: 0 } });
      await iterator.return!();
      await expect(handle.result).rejects.toThrow('iteration ended early');
      await pending.closed;
    } finally { await client.dispose(); }
  });

  it('runs Node helpers with the client executor and derived configuration', async () => {
    const calls: P4Invocation[] = [];
    const executor = scriptedExecutor((invocation) => {
      calls.push(invocation);
      return invocation.args.includes('set')
        ? { stdout: 'P4PORT=local:1666\nP4USER=u\nP4CLIENT=c\n' }
        : {};
    });
    const parent = clientFor(executor, { cwd: 'parent' });
    const child = parent.with({ cwd: 'child' });
    try {
      expect(await child.resolveConnection({ sources: ['p4'] })).toMatchObject({
        connection: { port: 'local:1666', user: 'u', client: 'c' },
      });
      expect(calls[0]?.cwd).toBe('child');
      expect(await child.findWorkspaceForPath({ path: process.cwd() })).toMatchObject({ match: null });
      const handle = child.watch.findWorkspaceForPath({ path: process.cwd() });
      expect(await handle.result).toMatchObject({ match: null });
      expect(await child.workspaceRootExists({ root: process.cwd() })).toBe(true);
      await expect(child.materializeDepotFiles({ fileSpec: [], directory: '.', maxFiles: 0 }))
        .rejects.toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'maxFiles' });
      const written = await child.materializeDepotFiles({ fileSpec: [], directory: process.cwd(), maxFiles: 1 });
      expect(written).toMatchObject({ items: [], messages: [] });
      const materialize = child.watch.materializeDepotFiles({ fileSpec: [], directory: '.', maxFiles: 0 });
      await expect(materialize.result).rejects.toMatchObject({ _tag: 'P4InvalidArgumentError' });
      const aborted = new AbortController();
      const reason = new Error('cancel root check');
      aborted.abort(reason);
      await expect(child.workspaceRootExists({ root: '.', signal: aborted.signal })).rejects.toBe(reason);
    } finally { await child.dispose(); await parent.dispose(); }
    await expect(child.resolveConnection({ sources: [] })).rejects.toThrow('client disposed');
    await expect(child.workspaceRootExists({ root: '.' })).rejects.toThrow('client disposed');
  });

  it('does not execute an already cancelled call after runtime initialization', async () => {
    const calls: P4Invocation[] = [];
    const client = clientFor(scriptedExecutor((invocation) => {
      calls.push(invocation);
      return { stdout: row };
    }));
    try {
      await client.runTagged({ args: ['info'] });
      const controller = new AbortController();
      const reason = new Error('cancel before invocation');
      controller.abort(reason);
      await expect(client.runTagged({ args: ['info'], signal: controller.signal })).rejects.toBe(reason);
      expect(calls).toHaveLength(1);
    } finally { await client.dispose(); }
  });

  it('cancels active Node helpers and joins their cleanup on disposal', async () => {
    const pending = pendingExecutor();
    const client = clientFor(pending.executor);
    const result = client.resolveConnection({ sources: ['p4'] });
    void result.catch(() => {});
    await pending.ready;
    await client.dispose();
    await pending.closed;
    await expect(result).rejects.toThrow('client disposed');
  });

  it('keeps the root entry free of child_process imports in a browser bundle', async () => {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
      target: 'browser',
      external: ['node:*'],
    });
    expect(build.success).toBe(true);
    const bundle = await build.outputs[0]!.text();
    expect(bundle).not.toContain('node:child_process');
    expect(bundle).not.toContain('NodeP4Executor');
  });
});
