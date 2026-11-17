import { describe, expect, it } from 'vite-plus/test';
import { Cause, Effect, Exit, Layer, Predicate } from 'effect';
import { listChangelists } from '../../../src/commands/changelists.js';
import { listFiles, listHaveFiles, statFiles, whereFiles } from '../../../src/commands/files.js';
import { openForEdit, previewOpenForAdd, previewOpenForEdit } from '../../../src/commands/open.js';
import { listOpenedFiles, openedCommand } from '../../../src/commands/opened.js';
import { previewReconcile } from '../../../src/commands/reconcile.js';
import { previewRevert, revert } from '../../../src/commands/revert.js';
import { printBatch, printFile } from '../../../src/commands/print.js';
import { listStreams } from '../../../src/commands/streams.js';
import { previewSync, sync } from '../../../src/commands/sync.js';
import { runCommand } from '../../../src/engine/command.js';
import { configLayer } from '../../../src/engine/config.js';
import { runOperation } from '../../../src/engine/operation.js';
import { P4InvalidArgumentError, P4ReadOnlyError } from '../../../src/errors.js';
import { commandArgs, recordingExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { expectFailure } from '../../support/assert.js';
import { failure, fixtures, run, watch } from './support.js';
import type { P4ClientOptions } from '../../../src/engine/config.js';
import type { P4Operation } from '../../../src/engine/operation.js';
import type { P4ScriptedOutput } from '../../../src/testing/executor.js';
import type { P4Error } from '../../../src/errors.js';
import type { P4Executor, P4Invocation } from '../../../src/exec/executor.js';

const TAG = ['-Mj', '-z', 'tag'];

/** About as many depot paths, as long, as a watcher stats in one call: ~54,000 characters. */
const LONG = Array.from({ length: 500 }, (_, index) =>
  `//depot/Content/Characters/Hero/Animations/Locomotion/Sprint/Variants/AS_Hero_Sprint_${String(index).padStart(4, '0')}.uasset`);

const STDIN = ['-x', '-', '-b', '500'];

interface Invoked {
  readonly args: string[];
  readonly input: string | undefined;
}

/** Every `p4` invocation an operation made, without connection options. */
async function invoked<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  client: P4ClientOptions = {},
  respond: () => P4ScriptedOutput = () => ({}),
): Promise<Invoked[]> {
  const recorder = recordingExecutor(scriptedExecutor(respond));
  await Effect.runPromiseExit(runOperation(op, options).pipe(Effect.provide(Layer.merge(recorder.layer, configLayer(client)))));

  return recorder.invocations.map((invocation) => ({ args: commandArgs(invocation.args), input: invocation.input }));
}

const lines = (specs: readonly string[]) => `${specs.join('\n')}\n`;

interface StdinCase {
  readonly name: string;
  readonly run: () => Promise<Invoked[]>;
  readonly expected: readonly Invoked[];
}

const stdinCase = <O, I, R>(
  name: string,
  op: P4Operation<O, I, R>,
  options: O,
  expected: readonly Invoked[],
  client?: P4ClientOptions,
): StdinCase => ({ name, run: () => invoked(op, options, client), expected });

describe('long file spec lists go on stdin in one batch', () => {
  const cases: StdinCase[] = [
    stdinCase('statFiles', statFiles, { fileSpec: LONG, fields: ['headType'] }, [
      { args: [...TAG, ...STDIN, 'fstat', '-T', 'depotFile headType'], input: lines(LONG) },
    ]),
    stdinCase('statFiles at a changelist', statFiles, { fileSpec: LONG, atChange: 7 }, [
      { args: [...TAG, ...STDIN, 'fstat'], input: lines(LONG.map((spec) => `${spec}@7`)) },
    ]),
    stdinCase('listFiles', listFiles, { fileSpec: LONG, existing: true, limit: 10 }, [
      { args: [...TAG, ...STDIN, 'files', '-e', '-m', '11'], input: lines(LONG) },
    ]),
    stdinCase('whereFiles', whereFiles, { fileSpec: LONG }, [{ args: [...TAG, ...STDIN, 'where'], input: lines(LONG) }]),
    stdinCase('listHaveFiles', listHaveFiles, { fileSpec: LONG }, [{ args: [...TAG, ...STDIN, 'have'], input: lines(LONG) }]),
    stdinCase('listOpenedFiles', listOpenedFiles, { fileSpec: LONG, allClients: true }, [
      { args: [...TAG, ...STDIN, 'opened', '-a'], input: lines(LONG) },
    ]),
    stdinCase('previewSync', previewSync, { fileSpec: LONG, force: true }, [
      { args: [...TAG, ...STDIN, 'sync', '-n', '-f'], input: lines(LONG) },
    ]),
    stdinCase('sync', sync, { fileSpec: LONG }, [{ args: [...TAG, ...STDIN, 'sync'], input: lines(LONG) }], { allowMutation: true }),
    stdinCase('listChangelists', listChangelists, { status: 'submitted', fileSpec: LONG, limit: 'all' }, [
      { args: [...TAG, ...STDIN, 'changes', '-s', 'submitted', '-l'], input: lines(LONG) },
    ]),
    stdinCase('listChangelists below a cursor', listChangelists, { status: 'submitted', fileSpec: LONG, cursor: 99 }, [
      { args: [...TAG, ...STDIN, 'changes', '-s', 'submitted', '-l', '-m', '51'], input: lines(LONG.map((spec) => `${spec}@99`)) },
    ]),
    stdinCase('listChangelists with the default changelist', listChangelists, { status: 'pending', fileSpec: LONG }, [
      { args: [...TAG, ...STDIN, 'changes', '-s', 'pending', '-l', '-m', '51'], input: lines(LONG) },
      { args: [...TAG, ...STDIN, 'opened', '-c', 'default'], input: lines(LONG) },
    ]),
    stdinCase('listStreams', listStreams, { fileSpec: LONG }, [{ args: [...TAG, ...STDIN, 'streams'], input: lines(LONG) }]),
    stdinCase('previewOpenForEdit', previewOpenForEdit, { fileSpec: LONG }, [
      { args: [...TAG, ...STDIN, 'edit', '-n'], input: lines(LONG) },
    ]),
    stdinCase('previewOpenForAdd', previewOpenForAdd, { fileSpec: LONG, type: 'binary+l' }, [
      { args: [...TAG, ...STDIN, 'add', '-n', '-t', 'binary+l'], input: lines(LONG) },
    ]),
    stdinCase('previewRevert', previewRevert, { fileSpec: LONG }, [{ args: [...TAG, ...STDIN, 'revert', '-n'], input: lines(LONG) }]),
    stdinCase('previewReconcile', previewReconcile, { fileSpec: LONG }, [
      { args: [...TAG, ...STDIN, 'reconcile', '-n'], input: lines(LONG) },
    ]),
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      expect(await testCase.run()).toEqual(testCase.expected);
    });
  }

  it('reads the same items, failures and messages as the argument list', async () => {
    const [capture] = fixtures('fstat-mixed-missing');
    const respond = () => ({ stdout: capture!.stdout ?? '', exitCode: capture!.exitCode });
    const executor = scriptedExecutor(respond);
    const short = await run(statFiles, { fileSpec: ['//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'] }, executor);
    const long = await run(statFiles, { fileSpec: LONG }, executor);

    expect(short.items).toHaveLength(1);
    expect(short.failures).toHaveLength(1);
    expect(long).toEqual(short);
  });

  it('keeps mutations behind allowMutation', async () => {
    const attempts: ReadonlyArray<(executor: Layer.Layer<P4Executor>) => Promise<P4Error>> = [
      (executor) => failure(sync, { fileSpec: LONG }, executor),
      (executor) => failure(openForEdit, { fileSpec: LONG }, executor),
      (executor) => failure(revert, { fileSpec: LONG }, executor),
    ];

    for (const attempt of attempts) {
      const recorder = recordingExecutor(scriptedExecutor(() => ({})));
      expectFailure(await attempt(recorder.layer), P4ReadOnlyError);
      expect(recorder.invocations).toEqual([]);
    }
  });
});

describe('long lists with a non-ASCII spec run as several commands of arguments', () => {
  // On stdin `é` is UTF-8; as an argument it is the client's code page, so it would name another file.
  const MIXED = LONG.map((spec, index) => (index === 250 ? spec.replace('Hero_Sprint', 'Héro_Sprint') : spec));

  const split = async <O, I, R>(op: P4Operation<O, I, R>, options: O, prefix: readonly string[], client?: P4ClientOptions) => {
    const calls = await invoked(op, options, client);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.input === undefined && !call.args.includes('-x'))).toBe(true);
    expect(calls.every((call) => call.args.slice(0, prefix.length).join(' ') === prefix.join(' '))).toBe(true);

    return calls.flatMap((call) => call.args.slice(prefix.length));
  };

  it('splits every file-spec operation', async () => {
    expect(await split(statFiles, { fileSpec: MIXED }, [...TAG, 'fstat'])).toEqual(MIXED);
    expect(await split(statFiles, { fileSpec: MIXED, atChange: 7 }, [...TAG, 'fstat'])).toEqual(MIXED.map((spec) => `${spec}@7`));
    expect(await split(listFiles, { fileSpec: MIXED }, [...TAG, 'files'])).toEqual(MIXED);
    expect(await split(whereFiles, { fileSpec: MIXED }, [...TAG, 'where'])).toEqual(MIXED);
    expect(await split(listHaveFiles, { fileSpec: MIXED }, [...TAG, 'have'])).toEqual(MIXED);
    expect(await split(listOpenedFiles, { fileSpec: MIXED }, [...TAG, 'opened'])).toEqual(MIXED);
    expect(await split(previewSync, { fileSpec: MIXED }, [...TAG, 'sync', '-n'])).toEqual(MIXED);
    expect(await split(sync, { fileSpec: MIXED }, [...TAG, 'sync'], { allowMutation: true })).toEqual(MIXED);
    expect(await split(listChangelists, { status: 'submitted', fileSpec: MIXED, limit: 'all' }, [...TAG, 'changes', '-s', 'submitted', '-l']))
      .toEqual(MIXED);
    expect(await split(listStreams, { fileSpec: MIXED }, [...TAG, 'streams'])).toEqual(MIXED);
    expect(await split(previewOpenForEdit, { fileSpec: MIXED }, [...TAG, 'edit', '-n'])).toEqual(MIXED);
    expect(await split(previewRevert, { fileSpec: MIXED }, [...TAG, 'revert', '-n'])).toEqual(MIXED);
    expect(await split(previewReconcile, { fileSpec: MIXED }, [...TAG, 'reconcile', '-n'])).toEqual(MIXED);
    expect(await split(printBatch, { fileSpec: MIXED }, ['-G', 'print', '-k'])).toEqual(MIXED);
  });

  it('prints a short non-ASCII list as arguments too, as printFile sends its spec', async () => {
    const specs = ['//depot/Héro.uasset', '//depot/日本/Run.uasset'];
    expect(await invoked(printBatch, { fileSpec: specs })).toEqual([{ args: ['-G', 'print', '-k', ...specs], input: undefined }]);
    expect(await invoked(printFile, { file: specs[0]! })).toEqual([{ args: ['-G', 'print', '-k', specs[0]], input: undefined }]);
    // An ASCII batch keeps stdin.
    expect(await invoked(printBatch, { fileSpec: ['//depot/a.uasset'] })).toEqual([
      { args: ['-G', '-x', '-', 'print', '-k'], input: '//depot/a.uasset\n' },
    ]);
  });

  it('adds up the sync totals each command announces with its first file', async () => {
    const respond = (invocation: P4Invocation): P4ScriptedOutput => {
      const files = commandArgs(invocation.args).slice(5);

      const rows = files.map((depotFile, index) => {
        const row = { depotFile, clientFile: `C:\\ws\\${index}.uasset`, rev: '2', action: 'updated', change: '9', fileSize: '10' };
        const totals = { totalFileCount: String(files.length), totalFileSize: String(files.length * 10) };

        return JSON.stringify(index === 0 ? { ...row, ...totals } : row);
      });

      return { stdout: rows.join('\n') };
    };

    const recorder = recordingExecutor(scriptedExecutor(respond));
    const result = await run(previewSync, { fileSpec: MIXED }, recorder.layer);
    expect(recorder.invocations.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ totalFileCount: 500, totalFileSize: 5_000 });
    expect(result.items).toHaveLength(500);

    const progress = (await watch(previewSync, { fileSpec: MIXED }, scriptedExecutor(respond)))
      .flatMap((event) => (Predicate.isTagged(event, 'progress') ? [event.progress] : []));

    expect(progress.at(-1)).toMatchObject({ completed: 500, total: 500, bytesCompleted: 5_000, bytesTotal: 5_000 });
  });

  it('keeps listStreams to its limit when each command applies -m on its own', async () => {
    const stream = (name: string) => JSON.stringify({ Stream: `//Héro/${name}`, Name: name, Type: 'development', Parent: 'none' });
    let calls = 0;

    const executor = scriptedExecutor(() => {
      calls += 1;

      return { stdout: [stream(`a${calls}`), stream(`b${calls}`), stream(`c${calls}`)].join('\n') };
    });

    const events = await watch(listStreams, { fileSpec: MIXED, limit: 4 }, executor);
    expect(calls).toBeGreaterThan(1);
    expect(events.filter((event) => Predicate.isTagged(event, 'item'))).toHaveLength(4);

    expect(events.flatMap((event) => (Predicate.isTagged(event, 'done') ? event.result.items.map((item) => item.name) : [])))
      .toEqual(['a1', 'b1', 'c1', 'a2']);
  });
});

describe('file spec validation', () => {
  const rejected = ['//d/a.txt\n//d/b.txt', '//d/a.txt\r', '', '  ', '-f', '-c default'];

  type Attempt = (fileSpec: string[], executor: Layer.Layer<P4Executor>) => Promise<P4Error>;

  const ops: ReadonlyArray<readonly [string, Attempt]> = [
    ['statFiles', (fileSpec, executor) => failure(statFiles, { fileSpec }, executor)],
    ['listFiles', (fileSpec, executor) => failure(listFiles, { fileSpec }, executor)],
    ['whereFiles', (fileSpec, executor) => failure(whereFiles, { fileSpec }, executor)],
    ['listHaveFiles', (fileSpec, executor) => failure(listHaveFiles, { fileSpec }, executor)],
    ['listOpenedFiles', (fileSpec, executor) => failure(listOpenedFiles, { fileSpec }, executor)],
    ['previewSync', (fileSpec, executor) => failure(previewSync, { fileSpec }, executor)],
    ['listChangelists', (fileSpec, executor) => failure(listChangelists, { status: 'submitted', fileSpec }, executor)],
    ['listStreams', (fileSpec, executor) => failure(listStreams, { fileSpec }, executor)],
    ['previewOpenForEdit', (fileSpec, executor) => failure(previewOpenForEdit, { fileSpec }, executor)],
    ['previewRevert', (fileSpec, executor) => failure(previewRevert, { fileSpec }, executor)],
    ['previewReconcile', (fileSpec, executor) => failure(previewReconcile, { fileSpec }, executor)],
  ];

  for (const [name, attempt] of ops) {
    it(`${name} rejects a spec that is blank, spans lines or reads as an option, and runs nothing`, async () => {
      for (const spec of rejected) {
        const recorder = recordingExecutor(scriptedExecutor(() => ({})));
        expectFailure(await attempt(['//d/ok.txt', spec], recorder.layer), P4InvalidArgumentError, { option: 'fileSpec' });
        expect(recorder.invocations).toEqual([]);
      }
    });
  }

  it('rejects the same specs through the public openedCommand builder, which does not check them', async () => {
    for (const spec of rejected) {
      const recorder = recordingExecutor(scriptedExecutor(() => ({})));

      const exit = await Effect.runPromiseExit(runCommand(openedCommand({ fileSpec: [...LONG, spec] })).pipe(
        Effect.provide(Layer.merge(recorder.layer, configLayer({}))),
      ));

      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : null).toBeInstanceOf(P4InvalidArgumentError);
      expect(recorder.invocations).toEqual([]);
    }
  });

  it('keeps spaces, which mean the same on stdin', async () => {
    const spec = '//depot/My Project/Content/Hero Idle.uasset';
    expect(await invoked(statFiles, { fileSpec: [spec, ...LONG] })).toMatchObject([{ input: lines([spec, ...LONG]) }]);
    expect(await invoked(statFiles, { fileSpec: spec })).toEqual([{ args: [...TAG, 'fstat', spec], input: undefined }]);
  });
});
