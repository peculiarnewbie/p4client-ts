import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Effect, Layer, Stream } from 'effect';
import { P4Executor } from '../../../src/exec/executor.js';
import { commandArgs } from '../../../src/testing/executor.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeDepotFiles, materializedFilePath } from '../../../src/node/materialize.js';
import { replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { failure, fixtures, invocations, run, watch } from '../commands/support.js';
import { P4MaterializationError } from '../../../src/errors.js';

const scratch = mkdtempSync(join(tmpdir(), 'p4ts-materialize-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TEXT = { depotFile: '//p4ts/main/wire/text.txt', revision: 1 };
const textPath = join(scratch, 'p4ts', 'main', 'wire', 'text.txt');

/** The captured `print -q -K -o` invocation, retargeted at this test's output path. */
function printMaterialize() {
  const fixture = fixtures('print-materialize')[0]!;
  return Layer.succeed(P4Executor, {
    run: (invocation) => {
      const args = commandArgs(invocation.args);
      const outputPath = args[args.indexOf('-o') + 1]!;
      writeFileSync(outputPath, 'fixture contents');
      return Stream.unwrap(Effect.map(P4Executor.pipe(Effect.provide(replayExecutor([{
        ...fixture,
        args: fixture.args.map((arg) => arg === '<WORKSPACE>\\printed.txt' ? outputPath : arg),
      }]))), (executor) => executor.run(invocation)));
    },
  });
}

describe('materializeDepotFiles', () => {
  it('prints each revision beneath <directory>/<depot>/<path>', async () => {
    const result = await run(materializeDepotFiles, { fileSpec: [TEXT], directory: scratch, maxFiles: 1 }, printMaterialize());
    expect(result).toEqual({
      directory: scratch,
      items: [{ file: TEXT, localPath: textPath }],
      messages: [],
    } as never);
    expect(existsSync(join(scratch, 'p4ts', 'main', 'wire'))).toBe(true);
  });

  it('reports each file and progress against the requested count', async () => {
    const events = await watch(materializeDepotFiles, { fileSpec: [TEXT], directory: scratch, maxFiles: 5 }, printMaterialize());
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
    expect(events[1]).toMatchObject({ progress: { completed: 1, total: 1, unit: 'files' } });
  });

  it('expands keywords only when asked', async () => {
    const calls = await invocations(materializeDepotFiles, {
      fileSpec: [TEXT, { depotFile: '//p4ts/main/wire/other.txt', revision: 2 }],
      directory: scratch,
      maxFiles: 2,
      keywords: 'expand',
      concurrency: 1,
    }, (args) => {
      writeFileSync(args[args.indexOf('-o') + 1]!, '');
      return {};
    });
    expect(calls.map((args) => args.filter((_, index) => index !== args.indexOf('-o') + 1))).toEqual([
      ['print', '-q', '-o', '//p4ts/main/wire/text.txt#1'],
      ['print', '-q', '-o', '//p4ts/main/wire/other.txt#2'],
    ]);
  });

  it('fails when a revision does not exist', async () => {
    const error = await failure(materializeDepotFiles, { fileSpec: [TEXT], directory: scratch, maxFiles: 1 }, scriptedExecutor(() => ({
      stderr: '//p4ts/main/wire/text.txt#1 - no such file(s).\r\n',
    })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'no_such_file' });
  });

  it('fails when print exits zero without output, preserving an existing destination', async () => {
    writeFileSync(textPath, 'previous revision');
    const error = await failure(materializeDepotFiles, {
      fileSpec: [{ ...TEXT, revision: 2 }], directory: scratch, maxFiles: 1,
    }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4MaterializationError', reason: 'missing_output' });
    expect(readFileSync(textPath, 'utf8')).toBe('previous revision');
    expect(readdirSync(join(scratch, 'p4ts', 'main', 'wire')).some((name) => name.startsWith('.p4-materialize-'))).toBe(false);
  });

  it('retains snapshot metadata on the returned file', async () => {
    const file = { ...TEXT, action: 'edit', change: 42, type: 'binary' };
    const result = await run(materializeDepotFiles, { fileSpec: [file], directory: scratch, maxFiles: 1 }, printMaterialize());
    expect(result.items[0]?.file).toEqual(file);
    expect(existsSync(textPath)).toBe(true);
  });

  it('refuses more files than maxFiles before running p4', async () => {
    const error = await failure(materializeDepotFiles, { fileSpec: [TEXT, TEXT], directory: scratch, maxFiles: 1 }, scriptedExecutor(() => {
      throw new Error('p4 must not run');
    }));
    expect(error).toMatchObject({ _tag: 'P4MaterializationError', reason: 'limit_exceeded' });
  });

  it('rejects unsafe depot paths and colliding outputs', async () => {
    const none = scriptedExecutor(() => {
      throw new Error('p4 must not run');
    });
    for (const depotFile of ['//depot', '//d/../x', '//d//x', 'd/x', '//d/x#2']) {
      expect(await failure(materializeDepotFiles, { fileSpec: [{ depotFile, revision: 1 }], directory: scratch, maxFiles: 1 }, none))
        .toMatchObject({ _tag: 'P4MaterializationError', reason: 'invalid_depot_path', path: depotFile });
    }
    expect(await failure(materializeDepotFiles, {
      fileSpec: [TEXT, { ...TEXT, revision: 2 }], directory: scratch, maxFiles: 2,
    }, none)).toMatchObject({ _tag: 'P4MaterializationError', reason: 'invalid_depot_path' });
  });

  it('requires an existing directory', async () => {
    const file = join(scratch, 'not-a-directory');
    writeFileSync(file, '');
    for (const directory of [join(scratch, 'missing'), file]) {
      expect(await failure(materializeDepotFiles, { fileSpec: [TEXT], directory, maxFiles: 1 }, scriptedExecutor(() => ({}))))
        .toMatchObject({ _tag: 'P4MaterializationError', reason: 'invalid_destination' });
    }
  });

  it('keeps output paths inside the directory', () => {
    expect(materializedFilePath(scratch, '//d/a/b.txt')).toBe(join(scratch, 'd', 'a', 'b.txt'));
    expect(() => materializedFilePath(scratch, '//d/./b.txt')).toThrow(P4MaterializationError);
  });
});
