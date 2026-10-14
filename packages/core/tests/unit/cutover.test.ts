import { describe, expect, it } from 'bun:test';
import { Effect, Layer, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, runPlainCommand } from '../../src/engine/command.js';
import { configLayer } from '../../src/engine/config.js';
import { commandArgs, replayExecutor, scriptedExecutor } from '../../src/testing/executor.js';
import { toOpenedFile } from '../../src/commands/opened.js';
import { toWireRecord } from '../../src/wire/record.js';
import { WIRE_ROOT, corpus } from '../support/corpus.js';

describe('cutover wire regressions retained from the legacy suite', () => {
  for (const [name, count, reason] of [
    ['changes-cursor-scoped', 1, null],
    ['changes-cursor-separated', 9, null],
    ['changes-not-logged-in', 0, 'not_logged_in'],
    ['diff2-bad-revision', 0, 'invalid_revision'],
    ['print-permission', 0, 'permission_denied'],
    ['unicode-charset-required', 0, 'charset'],
    ['sync-up-to-date', 0, null],
    ['synthetic-paths', 2, null],
    ['synthetic-stderr', 1, null],
    ['synthetic-review-error-data', 0, 'usage'],
    ['synthetic-review-reconcile-progress', 1, null],
  ] as const) {
    it(`classifies ${name} through the shared engine`, async () => {
      const fixture = corpus.get(name)!;
      // -I is an obsolete progress experiment; retain its output as evidence.
      const normalized = { ...fixture, args: fixture.args.filter((arg) => arg !== '-I') };
      const args = commandArgs(normalized.args).slice(3);
      const program = runCommand({ args, format: 'json', decode: (row) => row })
        .pipe(Effect.provide(Layer.merge(configLayer({ allowMutation: true }), replayExecutor([normalized]))));
      if (reason !== null) {
        await expect(Effect.runPromise(program)).rejects.toMatchObject({ _tag: 'P4CommandError', reason });
      } else {
        const result = await Effect.runPromise(program);
        expect(result.items).toHaveLength(count);
        if (name === 'synthetic-paths') {
          expect(result.items.map((row) => row.depotFile)).toEqual([
            '//depot/main/café_日本 space.txt', '//depot/main/literal%40%23%25%2A.txt',
          ]);
        }
        if (name === 'synthetic-stderr') expect(result.messages).toHaveLength(2);
        if (name === 'sync-up-to-date') expect(result.messages[0]?.reason).toBe('up_to_date');
      }
    });
  }

  for (const name of ['diff-not-opened-plain', 'print-empty-plain', 'synthetic-review-plain-warnings']) {
    it(`retains plain-mode notices from ${name}`, async () => {
      const fixture = corpus.get(name)!;
      const result = await Effect.runPromise(runPlainCommand({ args: commandArgs(fixture.args) }).pipe(
        Effect.provide(Layer.merge(configLayer({}), replayExecutor([fixture]))),
      ));
      expect(result.messages.length).toBeGreaterThan(0);
    });
  }

  it('rejects malformed opened paths and numeric revisions, while accepting #none', async () => {
    const rows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      opened: Schema.Record(Schema.String, Schema.Unknown),
      sync: Schema.Record(Schema.String, Schema.Unknown),
    })))(readFileSync(join(WIRE_ROOT, 'synthetic-malformed.json'), 'utf8'));
    expect(() => toOpenedFile(rows.opened)).toThrow();
    const result = runCommand({ args: ['opened'], format: 'json', decode: toOpenedFile }).pipe(
      Effect.provide(Layer.merge(configLayer({}), scriptedExecutor(() => ({
        stdout: JSON.stringify({ ...rows.sync, clientFile: '//client/a', rev: 'none', haveRev: 'none' }),
      })))),
    );
    expect((await Effect.runPromise(result)).items[0]).toMatchObject({ revision: null, haveRevision: null });
    expect(() => toOpenedFile({ ...rows.sync, clientFile: '//client/a' })).toThrow();
    expect(toWireRecord({ depotFile: '//depot/main/not logged in.txt' })._tag).toBe('data');
  });
});
