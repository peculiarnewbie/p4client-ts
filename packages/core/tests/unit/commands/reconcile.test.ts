import { describe, expect, it } from 'bun:test';
import { previewReconcile, workspaceRootFileSpec } from '../../../src/commands/reconcile.js';
import { replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { argvCase, argvTable, failure, fixtures, replay, run, watch } from './support.js';
import type { Layer } from 'effect';
import type { PreviewReconcileOptions } from '../../../src/commands/reconcile.js';
import type { P4Executor } from '../../../src/exec/executor.js';

const TAG = ['-Mj', '-z', 'tag'];
const WIRE = '//p4ts/main/wire/...';

/**
 * Replay fixtures captured with `-I`. `reconcile -I` prints no progress
 * through a pipe, so its output is what the operation's command prints
 * without it.
 */
function withoutProgressFlag(...names: string[]): Layer.Layer<P4Executor> {
  return replayExecutor(fixtures(...names).map((fixture) => ({
    ...fixture,
    args: fixture.args.filter((arg) => arg !== '-I'),
  })));
}

const row = (fields: Record<string, string>) => `${JSON.stringify(fields)}\n`;

describe('reconcile operations: argv', () => {
  argvTable([
    argvCase('preview reconciles from the current directory by default', previewReconcile, {}, [
      [...TAG, 'reconcile', '-n'],
    ]),
    argvCase('preview passes changelist, modtime, writable and every spec', previewReconcile, {
      change: 5, useModTime: true, includeWritable: true, fileSpec: ['//d/a/...', '//d/b/...'],
    }, [[...TAG, 'reconcile', '-n', '-c', '5', '-m', '-w', '//d/a/...', '//d/b/...']]),
    argvCase('preview reconciles everything under a workspace root', previewReconcile, {
      change: 'default', workspace: { root: 'C:\\work\\ws\\' },
    }, [[...TAG, 'reconcile', '-n', '-c', 'default', 'C:/work/ws/...']]),
    argvCase('an explicit spec wins over the workspace root', previewReconcile, {
      fileSpec: '//d/x/...', workspace: { root: '/home/ws' },
    }, [[...TAG, 'reconcile', '-n', '//d/x/...']]),
    argvCase('never requests progress with -I', previewReconcile, { fileSpec: WIRE }, [
      [...TAG, 'reconcile', '-n', WIRE],
    ]),
  ]);

  it('derives a workspace spec with forward slashes and no trailing separator', () => {
    expect(workspaceRootFileSpec('/home/arif/ws//')).toBe('/home/arif/ws/...');
    expect(workspaceRootFileSpec('D:\\p4\\ws')).toBe('D:/p4/ws/...');
  });
});

describe('previewReconcile', () => {
  it('groups candidates by the action reconcile would open them for', async () => {
    const result = await run(previewReconcile, { fileSpec: WIRE }, replay('reconcile-data'));
    expect(result.items).toEqual([
      {
        depotFile: '//p4ts/main/wire/text.txt' as never,
        clientFile: '<WORKSPACE>\\wire\\text.txt' as never,
        action: 'edit',
        type: 'text',
        change: null,
        workRevision: 2,
      },
      {
        depotFile: '//p4ts/main/wire/new file.txt' as never,
        clientFile: '<WORKSPACE>\\wire\\new file.txt' as never,
        action: 'add',
        type: 'text',
        change: null,
        workRevision: 1,
      },
    ]);
    expect(result.added).toEqual([result.items[1]!]);
    expect(result.edited).toEqual([result.items[0]!]);
    expect(result.deleted).toEqual([]);
    expect(result.messages).toEqual([]);
  });

  it('reports output captured with -I the same way', async () => {
    const result = await run(previewReconcile, { fileSpec: WIRE }, withoutProgressFlag('reconcile-progress'));
    expect(result).toEqual(await run(previewReconcile, { fileSpec: WIRE }, replay('reconcile-data')));
  });

  it('streams every candidate of a large tree with an indeterminate count', async () => {
    const events = await watch(previewReconcile, { fileSpec: '//p4ts/main/bulk/...' }, withoutProgressFlag('reconcile-progress-large'));
    const done = events.at(-1);
    const result = done?._tag === 'done' ? done.result : null;
    const progress = events.flatMap((event) => (event._tag === 'progress' ? [event.progress] : []));
    expect(result?.added).toHaveLength(2000);
    expect(events.filter((event) => event._tag === 'item')).toHaveLength(2000);
    expect(progress).toHaveLength(2000);
    expect(progress.every((update) => update.total === null && update.unit === 'files')).toBe(true);
    expect(progress.at(-1)?.completed).toBe(2000);
  });

  it.each([
    ['reconcile-modtime', { useModTime: true }],
    ['reconcile-writable', { includeWritable: true }],
    ['reconcile-empty', {}],
  ] as const)('reports nothing to reconcile as a message (%s)', async (name, options) => {
    const result = await run(previewReconcile, { ...options, fileSpec: '//p4ts/main/wire/text.txt' }, replay(name));
    expect(result).toMatchObject({ items: [], added: [], edited: [], deleted: [] });
    expect(result.messages.map((message) => message.reason)).toEqual(['nothing_to_reconcile']);
  });

  it('groups moves with adds and deletes', async () => {
    const result = await run(previewReconcile, {}, scriptedExecutor(() => ({
      stdout: row({ action: 'move/add', depotFile: '//d/new.txt', clientFile: '/ws/new.txt' })
        + row({ action: 'move/delete', depotFile: '//d/old.txt', clientFile: '/ws/old.txt' })
        + row({ action: 'delete', depotFile: '//d/gone.txt', clientFile: '/ws/gone.txt', change: 'default' }),
    })));
    expect(result.added.map((item) => item.action)).toEqual(['move/add']);
    expect(result.deleted.map((item) => [item.action, item.change])).toEqual([['move/delete', null], ['delete', 'default']]);
  });

  it('rejects an action reconcile does not open files for', async () => {
    const error = await failure(previewReconcile, {}, scriptedExecutor(() => ({
      stdout: row({ action: 'integrate', depotFile: '//d/a.txt' }),
    })));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });

  it('fails on a file it cannot read', async () => {
    const error = await failure(previewReconcile, {}, scriptedExecutor(() => ({
      stdout: row({ action: 'edit', depotFile: '//d/a.txt' })
        + `${JSON.stringify({ severity: 3, generic: 33, data: 'open for read: /ws/b.txt: Permission denied.' })}\n`,
      exitCode: 1,
    })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'fault' });
  });

  it('fails for a spec outside the workspace view', async () => {
    const [outside] = fixtures('sync-outside-stream');
    const error = await failure(previewReconcile, {}, scriptedExecutor(() => ({ stdout: fixtureStdout(outside!) })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'not_in_view' });
  });

  it('rejects a workspace without a root', async () => {
    const error = await failure(previewReconcile, { workspace: { root: ' ' } }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'workspace' });
  });
});

describe('reconcile: buffered and watched parity', () => {
  const cases: Array<{ name: string; options: PreviewReconcileOptions; executor: () => Layer.Layer<P4Executor> }> = [
    { name: 'reconcile-data', options: { fileSpec: WIRE }, executor: () => replay('reconcile-data') },
    { name: 'reconcile-modtime', options: { useModTime: true, fileSpec: '//p4ts/main/wire/text.txt' }, executor: () => replay('reconcile-modtime') },
    {
      name: 'reconcile-progress-large',
      options: { fileSpec: '//p4ts/main/bulk/...' },
      executor: () => withoutProgressFlag('reconcile-progress-large'),
    },
  ];
  for (const testCase of cases) {
    it(`${testCase.name}: the watched events and done equal the run result`, async () => {
      const result = await run(previewReconcile, testCase.options, testCase.executor());
      const events = await watch(previewReconcile, testCase.options, testCase.executor());
      expect(events.at(-1)).toEqual({ _tag: 'done', result });
      expect(events.flatMap((event) => (event._tag === 'item' ? [event.item] : []))).toEqual(result.items);
      expect(events.filter((event) => event._tag === 'failure')).toEqual([]);
      expect(events.flatMap((event) => (event._tag === 'message' ? [event.message] : []))).toEqual(result.messages);
    });
  }
});
