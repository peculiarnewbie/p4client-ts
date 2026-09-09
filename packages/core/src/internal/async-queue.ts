/**
 * Bounded single-consumer async event queue with amortized O(1) dequeue.
 *
 * Unbounded growth is rejected once `maxBuffered` pending values accumulate
 * without a consumer, so late or absent subscribers cannot retain every event.
 * Returning from iteration closes the queue and discards unconsumed events.
 */
export type AsyncEventQueue<T> = {
  iterable: AsyncIterable<T>;
  push: (event: T) => void;
  fail: (error: unknown) => void;
  finish: () => void;
};

export type CreateAsyncEventQueueOptions = {
  /** Maximum number of unconsumed events retained before failing the queue. */
  maxBuffered?: number;
};

const DEFAULT_MAX_BUFFERED = 10_000;

export function createAsyncEventQueue<T>(
  options: CreateAsyncEventQueueOptions = {}
): AsyncEventQueue<T> {
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  if (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1) {
    throw new Error('maxBuffered must be a positive safe integer.');
  }
  const values: T[] = [];
  let head = 0;
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let failure: { error: unknown } | undefined;
  let done = false;

  const pendingCount = () => values.length - head;

  const compact = () => {
    if (head > 64 && head * 2 > values.length) {
      values.splice(0, head);
      head = 0;
    }
  };

  const takeNext = (): T => {
    const value = values[head]!;
    head += 1;
    compact();
    return value;
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (pendingCount() > 0) {
              return Promise.resolve({ done: false, value: takeNext() });
            }
            if (failure !== undefined) {
              return Promise.reject(failure.error);
            }
            if (done) {
              return Promise.resolve({ done: true, value: undefined });
            }

            return new Promise<IteratorResult<T>>((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return() {
            done = true;
            failure = undefined;
            values.length = 0;
            head = 0;
            for (const waiter of waiters.splice(0)) {
              waiter.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: true as const, value: undefined });
          }
        };
      }
    },
    push(event: T) {
      if (done || failure !== undefined) return;

      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value: event });
        return;
      }

      if (pendingCount() >= maxBuffered) {
        const overflow = new Error(
          `Async event queue exceeded maxBuffered=${maxBuffered} unconsumed events.`
        );
        failure = { error: overflow };
        while (waiters.length > 0) {
          waiters.shift()!.reject(overflow);
        }
        return;
      }

      values.push(event);
    },
    fail(nextError: unknown) {
      if (done || failure !== undefined) return;
      failure = { error: nextError };
      while (waiters.length > 0) {
        waiters.shift()!.reject(nextError);
      }
    },
    finish() {
      if (done || failure !== undefined) return;
      done = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ done: true, value: undefined });
      }
    }
  };
}
