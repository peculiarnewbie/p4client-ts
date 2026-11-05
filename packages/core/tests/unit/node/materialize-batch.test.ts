import { afterAll, describe, expect, it } from 'vite-plus/test';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer, Tracer } from 'effect';
import { configLayer } from '../../../src/engine/config.js';
import { runOperation } from '../../../src/engine/operation.js';
import { materializeDepotFiles } from '../../../src/node/materialize.js';
import { commandArgs, recordingExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { fixtures } from '../commands/support.js';
import { asLocalPath } from '../../support/values.js';
import type { MaterializeDepotFilesOptions, P4MaterializeResult } from '../../../src/node/materialize.js';
import type { P4Error } from '../../../src/errors.js';
import type { P4Invocation } from '../../../src/exec/executor.js';
import type { P4ScriptedOutput } from '../../../src/testing/executor.js';

const scratch = mkdtempSync(join(tmpdir(), 'p4ts-materialize-batch-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let folders = 0;

const folder = () => {
  folders += 1;
  const path = join(scratch, `run-${folders}`);
  mkdirSync(path);

  return path;
};

const encoder = new TextEncoder();

/** `p4 -G` output: Python marshal dictionaries of strings. */
function marshal(records: ReadonlyArray<Readonly<Record<string, string | Uint8Array>>>): Uint8Array {
  const bytes: number[] = [];

  const string = (value: string | Uint8Array) => {
    const data = value instanceof Uint8Array ? value : encoder.encode(value);
    const size = new Uint8Array(new Uint32Array([data.length]).buffer);
    bytes.push(0x73, ...size, ...data);
  };

  for (const record of records) {
    bytes.push(0x7b);

    for (const [key, value] of Object.entries(record)) {
      string(key);
      string(value);
    }

    bytes.push(0x30);
  }

  return new Uint8Array(bytes);
}

const stat = (depotFile: string, fileSize: number, type = 'binary') =>
  ({ code: 'stat', depotFile, rev: '1', action: 'add', type, fileSize: String(fileSize) });

const chunk = (data: string) => ({ code: 'binary', data });

/**
 * Batches answer with `batch`; per-file prints write `<spec> printed` to their
 * `-o` path, unless `perFile` answers otherwise.
 */
function executor(
  batch: (invocation: P4Invocation) => P4ScriptedOutput,
  perFile: (spec: string, outputPath: string, attempt: number) => P4ScriptedOutput | null = () => null,
) {
  const attempts = new Map<string, number>();

  return recordingExecutor(scriptedExecutor((invocation) => {
    if (invocation.args.includes('-x')) return batch(invocation);
    const args = commandArgs(invocation.args);
    const outputPath = args[args.indexOf('-o') + 1]!;
    const spec = args.at(-1)!;
    const attempt = (attempts.get(spec) ?? 0) + 1;
    attempts.set(spec, attempt);
    const scripted = perFile(spec, outputPath, attempt);

    if (scripted !== null) return scripted;
    writeFileSync(outputPath, `${spec} printed`);

    return {};
  }));
}

interface Run {
  readonly exit: Exit.Exit<P4MaterializeResult, P4Error>;
  readonly argv: string[][];
  readonly spans: string[];
}

async function materialize(
  options: MaterializeDepotFilesOptions,
  recorder: ReturnType<typeof executor>,
): Promise<Run> {
  const spans: string[] = [];

  const tracer = Tracer.make({
    span: (span) => {
      spans.push(span.name);

      return new Tracer.NativeSpan(span);
    },
  });

  const exit = await Effect.runPromiseExit(runOperation(materializeDepotFiles, options).pipe(
    Effect.provide(Layer.merge(recorder.layer, configLayer({}))),
    Effect.withTracer(tracer),
  ));

  return { exit, argv: recorder.invocations.map((invocation) => commandArgs(invocation.args)), spans };
}

function succeeded(run: Run): P4MaterializeResult {
  if (Exit.isFailure(run.exit)) throw new Error(`Expected success: ${String(run.exit.cause)}`);

  return run.exit.value;
}

const leftovers = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) => name.includes('.p4-materialize-'));

describe('materializeDepotFiles batches', () => {
  it('streams binary revisions from one batched print and prints the rest per file', async () => {
    const [fixture] = fixtures('print-materialize-batch');
    const directory = folder();

    const recorder = executor((invocation) => {
      expect(invocation.input).toBe(fixture!.input);

      return { stdout: fixtureStdout(fixture!), stderr: fixture!.stderr, exitCode: fixture!.exitCode };
    });

    const fileSpec = ['//p4ts/main/wire/full.uasset', '//p4ts/main/wire/exclusive.uasset', '//p4ts/main/wire/text.txt',
      '//p4ts/main/missing.txt'].map((depotFile) => ({ depotFile, revision: 1 }));

    const run = await materialize({ fileSpec, directory, maxFiles: 4, batch: { processes: 1 } }, recorder);
    const result = succeeded(run);
    expect(result.items.map((item) => [item.file.depotFile, item.method, item.bytes])).toEqual([
      ['//p4ts/main/wire/full.uasset', 'batch', 16],
      ['//p4ts/main/wire/exclusive.uasset', 'batch', 20],
      ['//p4ts/main/wire/text.txt', 'print', '//p4ts/main/wire/text.txt#1 printed'.length],
      ['//p4ts/main/missing.txt', 'print', '//p4ts/main/missing.txt#1 printed'.length],
    ]);
    expect(readFileSync(join(directory, 'p4ts/main/wire/full.uasset'), 'utf8')).toBe('full binary\0data');
    expect(readFileSync(join(directory, 'p4ts/main/wire/exclusive.uasset'), 'utf8')).toBe('synthetic asset\0data');
    expect(result.stats).toEqual({ files: 4, bytes: result.items.reduce((sum, item) => sum + item.bytes, 0),
      batched: 2, printed: 2, batches: 1, retries: 0 });
    // One batch first, then the per-file prints, which run concurrently in any order.
    const [batch, ...perFile] = run.argv.map((args) => args.at(-1) ?? '');
    expect(batch).toBe('-k');
    expect([...perFile].sort((left, right) => left.localeCompare(right))).toEqual(['//p4ts/main/missing.txt#1', '//p4ts/main/wire/text.txt#1']);
    expect(leftovers(directory)).toEqual([]);
  });

  it('fails as before when the per-file print of a revision the batch skipped finds nothing', async () => {
    const [fixture] = fixtures('print-materialize-batch');

    const recorder = executor(
      () => ({ stdout: fixtureStdout(fixture!) }),
      (spec) => (spec.startsWith('//p4ts/main/missing.txt') ? { stderr: `${spec} - no such file(s).\n` } : null),
    );

    const fileSpec = ['//p4ts/main/wire/full.uasset', '//p4ts/main/wire/exclusive.uasset', '//p4ts/main/wire/text.txt',
      '//p4ts/main/missing.txt'].map((depotFile) => ({ depotFile, revision: 1 }));

    const run = await materialize({ fileSpec, directory: folder(), maxFiles: 4, batch: { processes: 1 } }, recorder);
    expect(Exit.isFailure(run.exit) && JSON.stringify(run.exit.cause)).toContain('no_such_file');
  });

  it('does not trust a file cut short, followed by a message, or from a failed batch', async () => {
    const directory = folder();
    const files = ['//d/x/short.bin', '//d/x/interrupted.bin', '//d/x/good.bin'];

    const recorder = executor(() => ({
      stdout: marshal([
        stat(files[0]!, 10), chunk('12345'),
        stat(files[1]!, 4), chunk('ab'), { code: 'error', data: 'librarian: read failed', severity: '3', generic: '33' },
        chunk('cd'),
        stat(files[2]!, 4), chunk('good'),
      ]),
    }));

    const result = succeeded(await materialize({
      fileSpec: files.map((depotFile) => ({ depotFile, revision: 1 })), directory, maxFiles: 3, batch: { processes: 1 },
    }, recorder));

    expect(result.items.map((item) => item.method)).toEqual(['print', 'print', 'batch']);
    expect(readFileSync(join(directory, 'd/x/short.bin'), 'utf8')).toBe('//d/x/short.bin#1 printed');
    expect(readFileSync(join(directory, 'd/x/good.bin'), 'utf8')).toBe('good');

    const failed = executor(() => ({ stdout: marshal([stat(files[2]!, 4), chunk('good')]), stderr: 'Broken pipe.\n', exitCode: 1 }));

    const fallback = succeeded(await materialize({
      fileSpec: [{ depotFile: files[2]!, revision: 1 }], directory: folder(), maxFiles: 1, batch: true,
    }, failed));

    expect(fallback.items.map((item) => item.method)).toEqual(['print']);
    expect(leftovers(directory)).toEqual([]);
  });

  it('prints a revision requested at several output paths once and copies it', async () => {
    const directory = folder();
    const recorder = executor(() => ({ stdout: marshal([stat('//d/x/a.bin', 3), chunk('abc')]) }));

    const result = succeeded(await materialize({
      fileSpec: [
        { depotFile: '//d/x/a.bin', revision: 1, outputPath: 'one/a.bin' },
        { depotFile: '//d/x/a.bin', revision: 1, outputPath: join(directory, 'two', 'a.bin') },
      ],
      directory,
      maxFiles: 2,
      batch: true,
      writable: true,
    }, recorder));

    expect(result.items.map((item) => item.localPath)).toEqual([asLocalPath(join(directory, 'one', 'a.bin')), asLocalPath(join(directory, 'two', 'a.bin'))]);
    expect(readFileSync(join(directory, 'two', 'a.bin'), 'utf8')).toBe('abc');
    expect(recorder.invocations[0]?.input).toBe('//d/x/a.bin#1\n');
    expect(result.stats).toMatchObject({ files: 2, bytes: 6, batched: 2 });
  });

  it('rejects an output path outside the directory before running p4', async () => {
    const recorder = executor(() => {
      throw new Error('p4 must not run');
    });

    const run = await materialize({
      fileSpec: [{ depotFile: '//d/x/a.bin', revision: 1, outputPath: '../escape.bin' }], directory: folder(), maxFiles: 1,
    }, recorder);

    expect(Exit.isFailure(run.exit) && JSON.stringify(run.exit.cause)).toContain('invalid_destination');
  });

  it('skips the batch for known text types and below minFiles', async () => {
    const never = executor(() => {
      throw new Error('no batch expected');
    });

    const text = succeeded(await materialize({
      fileSpec: [{ depotFile: '//d/x/a.txt', revision: 1, type: 'text' }], directory: folder(), maxFiles: 1, batch: true,
    }, never));

    expect(text.stats).toMatchObject({ batches: 0, printed: 1 });

    const few = succeeded(await materialize({
      fileSpec: [{ depotFile: '//d/x/a.bin', revision: 1 }], directory: folder(), maxFiles: 1, batch: { minFiles: 2 },
    }, never));

    expect(few.stats).toMatchObject({ batches: 0, printed: 1 });
  });

  it('spreads a small print over every process, with one bounded span per batch', async () => {
    const recorder = executor((invocation) => ({
      stdout: marshal((invocation.input ?? '').split('\n').filter(Boolean).flatMap((key) => {
        const depotFile = key.slice(0, key.indexOf('#'));

        return [stat(depotFile, 1), chunk('x')];
      })),
    }));

    const run = await materialize({
      fileSpec: Array.from({ length: 5 }, (_, index) => ({ depotFile: `//d/x/${index}.bin`, revision: 1 })),
      directory: folder(),
      maxFiles: 5,
      batch: { processes: 2 },
    }, recorder);

    expect(succeeded(run).stats).toMatchObject({ batches: 2, batched: 5, printed: 0 });
    expect(recorder.invocations.map((invocation) => invocation.input?.split('\n').filter(Boolean).length)).toEqual([3, 2]);
    expect([...run.spans].sort()).toEqual([
      'p4client-ts.materialize.batch',
      'p4client-ts.materialize.batch',
      'p4client-ts.materialize.printEach',
      'p4client-ts.materializeDepotFiles',
    ]);
  });

  it('retries a per-file print that lost its connection, but not a missing revision', async () => {
    const flaky = executor(() => ({}), (spec, _outputPath, attempt) => attempt === 1
      ? { stderr: 'Perforce client error:\n\tConnect to server failed; check $P4PORT.\n\tTCP connect to p4:1666 failed.\n', exitCode: 1 }
      : null);

    const retried = succeeded(await materialize({
      fileSpec: [{ depotFile: '//d/x/a.txt', revision: 1 }], directory: folder(), maxFiles: 1, attempts: 3, retryDelayMs: 1,
    }, flaky));

    expect(retried.stats).toMatchObject({ printed: 1, retries: 1 });
    expect(flaky.invocations).toHaveLength(2);

    const missing = executor(() => ({}), (spec) => ({ stderr: `${spec} - no such file(s).\n` }));

    const run = await materialize({
      fileSpec: [{ depotFile: '//d/x/a.txt', revision: 1 }], directory: folder(), maxFiles: 1, attempts: 3, retryDelayMs: 1,
    }, missing);

    expect(Exit.isFailure(run.exit)).toBe(true);
    expect(missing.invocations).toHaveLength(1);
  });

  it('makes read-only prints writable when asked', async () => {
    const directory = folder();

    const recorder = executor(() => ({}), (spec, outputPath) => {
      writeFileSync(outputPath, spec);
      chmodSync(outputPath, 0o444);

      return {};
    });

    succeeded(await materialize({
      fileSpec: [{ depotFile: '//d/x/a.txt', revision: 1 }], directory, maxFiles: 1, writable: true,
    }, recorder));
    expect(() => accessSync(join(directory, 'd/x/a.txt'), constants.W_OK)).not.toThrow();
  });
});
