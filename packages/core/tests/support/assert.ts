import { expect } from 'vite-plus/test';

/** Assert that a failure is an instance of `type` carrying `fields`. */
export function expectFailure<E extends Error>(
  cause: unknown,
  type: abstract new (...args: never[]) => E,
  fields: Partial<E> = {},
): void {
  expect(cause).toBeInstanceOf(type);
  expect(cause).toMatchObject(fields);
}

/** Wait for a promise that must reject, and return why. */
export async function rejectionOf<A>(promise: PromiseLike<A>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;

    throw new Error(`Rejected with a non-Error: ${String(cause)}`, { cause });
  }

  throw new Error('Expected the promise to reject.');
}
