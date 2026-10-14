import { describe, expect, it } from 'bun:test';
import { Effect, Exit, Layer, Stream } from 'effect';
import { streamCommand } from '../../../src/engine/command.js';
import { configLayer } from '../../../src/engine/config.js';
import {
  drain,
  operation,
  progressCounter,
  runOperation,
  watchOperation,
} from '../../../src/engine/operation.js';
import { P4CommandError } from '../../../src/errors.js';
import { replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { corpus } from '../../support/corpus.js';
import type { P4Context, P4OperationEvent } from '../../../src/engine/operation.js';
import type { P4Executor } from '../../../src/exec/executor.js';

const fixture = (name: string) => {
  const found = corpus.get(name);
  if (found === undefined) throw new Error(`Missing fixture ${name}`);
  return found;
};

const provide = <A, E>(effect: Effect.Effect<A, E, P4Context>, executor: Layer.Layer<P4Executor>) =>
  effect.pipe(Effect.provide(Layer.merge(executor, configLayer({}))));

const files = operation('files', (_: { readonly specs: readonly string[] }, sink) => Effect.gen(function* () {
  const counter = progressCounter(sink, 'files', 1);
  const output = yield* drain(sink, streamCommand({
    args: ['files', ..._.specs],
    format: 'json',
    decode: (row) => String(row.depotFile),
  }), { item: (file) => file, counter });
  return { items: output.items, messages: output.messages };
}));

const specs = ['//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'];

describe('operations', () => {
  it('watches the same result it runs, after every item, message and progress', async () => {
    const executor = replayExecutor([fixture('files-mixed')]);
    const result = await Effect.runPromise(provide(runOperation(files, { specs }), executor));
    const events = await Effect.runPromise(provide(Stream.runCollect(watchOperation(files, { specs })), executor));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'message', 'done']);
    expect(events.at(-1)).toEqual({ _tag: 'done', result });
    const progress = events.find((event) => event._tag === 'progress');
    expect(progress?._tag === 'progress' ? progress.progress : null).toMatchObject({ completed: 1, total: 1, unit: 'files' });
  });

  it('fails a watch with the error the run fails with', async () => {
    const executor = replayExecutor([fixture('changes-ticket-expired')]);
    const changes = operation('changes', (_: void, sink) =>
      drain(sink, streamCommand({ args: ['changes', '-m', '1'], format: 'json', decode: (row) => row })));
    const exit = await Effect.runPromiseExit(provide(Stream.runCollect(watchOperation(changes, undefined)), executor));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0];
      expect(reason?._tag === 'Fail' ? reason.error : null).toBeInstanceOf(P4CommandError);
    }
  });

  it('repeats the latest progress while the operation is quiet', async () => {
    const slow = operation('slow', (_: void, sink) => Effect.gen(function* () {
      const counter = progressCounter(sink, 'files', 2);
      yield* counter.advance();
      yield* Effect.sleep(120);
      yield* counter.advance();
      return 'ok';
    }));
    const events: Array<P4OperationEvent<unknown, string>> = await Effect.runPromise(provide(
      Stream.runCollect(watchOperation(slow, undefined, { progressIntervalMs: 25 })),
      scriptedExecutor(() => ({})),
    ));
    const progress = events.flatMap((event) => event._tag === 'progress' ? [event.progress] : []);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.filter((update) => update.completed === 1).length).toBeGreaterThan(2);
    const elapsed = progress.map((update) => update.elapsedMs);
    expect([...elapsed].sort((a, b) => a - b)).toEqual(elapsed);
    expect(events.at(-1)).toEqual({ _tag: 'done', result: 'ok' });
  });

  it('stops the command when the watcher stops reading', async () => {
    let finished = false;
    const endless = operation('endless', (_: void, sink) => Effect.gen(function* () {
      for (let index = 0; ; index += 1) {
        yield* sink.item(index);
        yield* Effect.sleep(1);
      }
    }).pipe(Effect.onExit(() => Effect.sync(() => {
      finished = true;
    }))));
    const firstThree = await Effect.runPromise(provide(
      watchOperation(endless, undefined).pipe(Stream.take(3), Stream.runCollect),
      scriptedExecutor(() => ({})),
    ));
    expect(firstThree.map((event) => event._tag === 'item' ? event.item : null)).toEqual([0, 1, 2]);
    expect(finished).toBe(true);
  });
});
