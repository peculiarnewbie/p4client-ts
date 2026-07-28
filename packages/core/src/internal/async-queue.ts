/**
 * Bounded async event queue with O(1) dequeue.
 *
 * Unbounded growth is rejected once `maxBuffered` pending values accumulate
 * without a consumer, so late or absent subscribers cannot retain every event.
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
  const values: T[] = [];
  let head = 0;
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let error: unknown = null;
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
    },
    push(event: T) {
      if (done || error !== null) return;

      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value: event });
        return;
      }

      if (pendingCount() >= maxBuffered) {
        const overflow = new Error(
          `Async event queue exceeded maxBuffered=${maxBuffered} unconsumed events.`
        );
        error = overflow;
        while (waiters.length > 0) {
          waiters.shift()!.reject(overflow);
        }
        return;
      }

      values.push(event);
    },
    fail(nextError: unknown) {
      if (done || error !== null) return;
      error = nextError;
      while (waiters.length > 0) {
        waiters.shift()!.reject(nextError);
      }
    },
    finish() {
      if (done || error !== null) return;
      done = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ done: true, value: undefined });
      }
    }
  };
}
