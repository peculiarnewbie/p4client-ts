import { describe, expect, it } from 'bun:test';
import { Effect, Layer } from 'effect';
import { runCommand } from '../../src/engine/command.js';
import { configLayer } from '../../src/engine/config.js';
import { P4CommandError, P4TimeoutError, decodeP4Error, encodeP4Error } from '../../src/errors.js';
import { replayExecutor } from '../../src/testing/executor.js';
import { corpus } from '../support/corpus.js';

const commandError = () => Effect.runPromise(
  runCommand({ args: ['changes', '-m', '1'], format: 'json', decode: (row) => row }).pipe(
    Effect.flip,
    Effect.provide(Layer.merge(replayExecutor([corpus.get('changes-ticket-expired')!]), configLayer())),
  ),
);

describe('error codec', () => {
  it('round-trips a command error through plain data, restoring its class', async () => {
    const error = await commandError();
    expect(error).toBeInstanceOf(P4CommandError);
    // structuredClone stands in for Electron IPC, which drops Error subclass fields.
    const transported = structuredClone(encodeP4Error(error));
    const restored = decodeP4Error(transported);
    expect(restored).toBeInstanceOf(P4CommandError);
    expect(restored).toBeInstanceOf(Error);
    expect(restored).toMatchObject({
      _tag: 'P4CommandError',
      reason: 'ticket_expired',
      category: 'authentication',
      message: error.message,
    });
    if (restored instanceof P4CommandError && error instanceof P4CommandError) expect(restored.messages).toEqual(error.messages);
  });

  it('keeps messages plain enough to clone', async () => {
    const error = await commandError();
    if (!(error instanceof P4CommandError)) throw new Error('Expected a command error.');
    expect(structuredClone(error.messages)).toEqual(error.messages);
  });

  it('rejects data that is not an encoded error', () => {
    expect(() => decodeP4Error({ _tag: 'Unknown' })).toThrow();
  });

  it('round-trips other error types', () => {
    const error = new P4TimeoutError({
      message: 'p4 info timed out after 5ms.', command: 'p4', args: ['info'], timeoutMs: 5, stdout: '', stderr: '',
    });
    expect(decodeP4Error(structuredClone(encodeP4Error(error)))).toBeInstanceOf(P4TimeoutError);
  });
});
