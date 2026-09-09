import { describe, expect, it } from "bun:test";
import { createAsyncEventQueue } from "../src/internal/async-queue.js";

describe("createAsyncEventQueue", () => {
  it('preserves null and undefined failure reasons for later consumers', async () => {
    for (const error of [null, undefined]) {
      const queue = createAsyncEventQueue<string>();
      queue.push('before failure');
      queue.fail(error);
      queue.push('ignored');
      const iterator = queue.iterable[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'before failure' });
      await expect(iterator.next()).rejects.toBe(error);
    }
  });

  it('releases queued events and waiting consumers when iteration returns', async () => {
    const queue = createAsyncEventQueue<string>();
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    queue.push('ignored');
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    const buffered = createAsyncEventQueue<string>();
    buffered.push('discarded');
    const bufferedIterator = buffered.iterable[Symbol.asyncIterator]();
    await bufferedIterator.return?.();
    await expect(bufferedIterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('rejects invalid buffer limits', () => {
    for (const maxBuffered of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => createAsyncEventQueue({ maxBuffered })).toThrow('positive safe integer');
    }
  });

  it("preserves event order while compacting consumed values", async () => {
    const queue = createAsyncEventQueue<number>();
    const expected = Array.from({ length: 130 }, (_, index) => index);

    for (const value of expected) {
      queue.push(value);
    }
    queue.finish();

    const actual: number[] = [];
    for await (const value of queue.iterable) {
      actual.push(value);
    }

    expect(actual).toEqual(expected);
  });

  it("fails when buffered events exceed the configured bound", async () => {
    const queue = createAsyncEventQueue<string>({ maxBuffered: 1 });
    const iterator = queue.iterable[Symbol.asyncIterator]();

    queue.push("first");
    queue.push("overflow");

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await expect(iterator.next()).rejects.toThrow(
      "Async event queue exceeded maxBuffered=1 unconsumed events."
    );
  });

  it("wakes waiting consumers when failed or finished", async () => {
    const failedQueue = createAsyncEventQueue<string>();
    const failure = new Error("stream failed");
    const failedNext = failedQueue.iterable[Symbol.asyncIterator]().next();
    failedQueue.fail(failure);

    await expect(failedNext).rejects.toBe(failure);
    failedQueue.push("ignored");
    await expect(
      failedQueue.iterable[Symbol.asyncIterator]().next()
    ).rejects.toBe(failure);

    const finishedQueue = createAsyncEventQueue<string>();
    const finishedNext = finishedQueue.iterable[Symbol.asyncIterator]().next();
    finishedQueue.finish();

    await expect(finishedNext).resolves.toEqual({ done: true, value: undefined });
    finishedQueue.push("ignored");
    await expect(
      finishedQueue.iterable[Symbol.asyncIterator]().next()
    ).resolves.toEqual({ done: true, value: undefined });
  });
});
