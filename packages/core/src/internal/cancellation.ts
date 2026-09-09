import { Effect } from 'effect';
import type { P4OperationHandle } from '../public/types.js';

/** One operation owns its controller; cancelling it never aborts its caller. */
export interface CancellationScope {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly dispose: () => void;
}

export function createCancellationScope(parent?: AbortSignal): CancellationScope {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener('abort', forwardAbort, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent?.removeEventListener('abort', forwardAbort)
  };
}

/** Wait for owned work without replacing its authoritative result/error. */
export function settleOperation(result: Promise<unknown>): Effect.Effect<void> {
  return Effect.promise(() => result.then(() => undefined, () => undefined));
}

/** Returning from event iteration cancels and joins the operation. */
export function ownOperation<TEvent, TResult>(
  handle: P4OperationHandle<TEvent, TResult>,
  scope: CancellationScope
): P4OperationHandle<TEvent, TResult> {
  const result = handle.result.finally(scope.dispose);
  void result.catch(() => undefined);
  return {
    result,
    events: {
      [Symbol.asyncIterator]() {
        const iterator = handle.events[Symbol.asyncIterator]();
        const close = () => Effect.runPromise(Effect.gen(function* () {
          scope.abort();
          // Release pending readers before waiting for the producer to settle.
          const returned = Promise.resolve().then(() => iterator.return?.())
            .then(() => undefined, () => undefined);
          yield* settleOperation(result);
          yield* settleOperation(returned);
          return { done: true as const, value: undefined };
        }));
        return {
          next: async () => {
            try {
              return await iterator.next();
            } catch (error) {
              await close();
              throw error;
            }
          },
          return: close
        };
      }
    }
  };
}
