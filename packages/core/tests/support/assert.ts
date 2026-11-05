import { expect } from 'bun:test';

/**
 * Assert that a failure is an instance of `type` carrying `fields`.
 *
 * @param cause The failure: a caught error, an Effect failure or a rejection.
 * @param type The error class it must be.
 * @param fields Fields it must have, compared as by `toMatchObject`.
 */
export function expectFailure<E extends Error>(
  cause: unknown,
  type: abstract new (...args: never[]) => E,
  fields: Partial<E> = {},
): void {
  expect(cause).toBeInstanceOf(type);
  expect(cause).toMatchObject(fields);
}

/**
 * Wait for a promise that must reject, and return why.
 *
 * @param promise The promise.
 * @returns The rejection reason; a fulfilled promise fails the test.
 */
export async function rejectionOf<A>(promise: PromiseLike<A>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;

    throw new Error(`Rejected with a non-Error: ${String(cause)}`, { cause });
  }

  throw new Error('Expected the promise to reject.');
}
