import { describe, expect, it } from 'bun:test';
import { previewSync, sync } from '../../../src/commands/sync.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { argvCase, argvTable, failure, fixtures, invocations, replay, run, watch } from './support.js';
import type { Layer } from 'effect';
import type { SyncOptions } from '../../../src/commands/sync.js';
import type { P4ClientOptions } from '../../../src/engine/config.js';
import type { P4Executor } from '../../../src/exec/executor.js';

const TAG = ['-Mj', '-z', 'tag'];
const MUTATE: P4ClientOptions = { allowMutation: true };
const TEXT = '//p4ts/main/wire/text.txt';

/** Replay a fixture's output whatever the invocation, for fixtures recorded without arguments. */
function output(name: string): Layer.Layer<P4Executor> {
  const [fixture] = fixtures(name);
  return scriptedExecutor(() => ({ stdout: fixtureStdout(fixture!), stderr: fixture!.stderr, exitCode: fixture!.exitCode }));
}

describe('sync operations: argv', () => {
  argvTable([
    argvCase('preview syncs the whole workspace by default', previewSync, {}, [[...TAG, 'sync', '-n']]),
    argvCase('preview passes force, keep and every spec', previewSync, {
      force: true, keepWorkspaceFiles: true, fileSpec: ['//d/a/...', '//d/b/...@5'],
    }, [[...TAG, 'sync', '-n', '-f', '-k', '//d/a/...', '//d/b/...@5']]),
    argvCase('a read-only client refuses to sync before running p4', sync, {}, []),
  ]);

  it('sync passes force, keep and specs without -n when mutation is allowed', async () => {
    const argv = await invocations(sync, { force: true, keepWorkspaceFiles: true, fileSpec: TEXT }, () => ({}), MUTATE);
    expect(argv).toEqual([[...TAG, 'sync', '-f', '-k', TEXT]]);
  });
});

describe('previewSync', () => {
  it('lists the files a forced sync would refresh, with the announced totals', async () => {
    const result = await run(previewSync, { force: true, fileSpec: TEXT }, replay('sync-force-preview'));
    expect(result).toEqual({
      items: [{
        depotFile: TEXT as never,
        clientFile: '<WORKSPACE>\\wire\\text.txt' as never,
        revision: 1,
        action: 'refreshed' as never,
        change: 4,
        fileSize: 8,
      }],
      failures: [],
      messages: [],
      totalFileCount: 1,
      totalFileSize: 8,
    });
  });

  it('reports determinate progress in files and bytes', async () => {
    const events = await watch(previewSync, { force: true, fileSpec: TEXT }, replay('sync-os-error-preview'));
    const progress = events.flatMap((event) => (event._tag === 'progress' ? [event.progress] : []));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
    expect(progress).toEqual([{
      completed: 1, total: 1, unit: 'files', bytesCompleted: 23, bytesTotal: 23, elapsedMs: expect.any(Number),
    }]);
  });

  it('reports an up-to-date workspace as a message, not a failure', async () => {
    const result = await run(previewSync, { keepWorkspaceFiles: true, fileSpec: TEXT }, replay('sync-keep-preview'));
    expect(result).toMatchObject({ items: [], failures: [], totalFileCount: null, totalFileSize: null });
    expect(result.messages.map((message) => message.reason)).toEqual(['up_to_date']);
  });

  it('keeps notices about opened files without counting them as files', async () => {
    const result = await run(previewSync, { fileSpec: TEXT }, replay('sync-opened-new-head-preview'));
    expect(result.items).toEqual([]);
    expect(result.messages.map((message) => message.reason)).toEqual(['opened_unchanged', 'resolve_required']);
  });

  it('returns nothing more than a message for a file with no newer revision', async () => {
    const result = await run(previewSync, { fileSpec: TEXT }, replay('opened-unchanged-json'));
    expect(result).toMatchObject({ items: [], failures: [] });
    expect(result.messages.map((message) => message.reason)).toEqual(['up_to_date']);
  });

  it('reports a spec outside the workspace view as a failure naming it', async () => {
    const result = await run(previewSync, { fileSpec: '//p4ts/elsewhere/a.txt' }, replay('sync-outside-stream'));
    expect(result.items).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.failures.map(({ spec, reason }) => ({ spec, reason }))).toEqual([
      { spec: '//p4ts/elsewhere/a.txt', reason: 'not_in_view' },
    ]);
  });

  it('accepts the non-zero exit of a spec outside the client, as a failure', async () => {
    const result = await run(previewSync, { fileSpec: '//other/main/a.txt' }, replay('sync-not-in-view'));
    expect(result.failures.map(({ spec, reason }) => ({ spec, reason }))).toEqual([
      { spec: '//other/main/a.txt', reason: 'not_in_view' },
    ]);
  });

  it('fails for an unknown workspace', async () => {
    const error = await failure(previewSync, { fileSpec: TEXT }, replay('sync-unknown-client'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'unknown_client' });
  });

  it('fails for an expired session', async () => {
    const error = await failure(previewSync, {}, output('changes-ticket-expired'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'ticket_expired' });
  });

  it('rejects a file record without a depot path or action', async () => {
    const error = await failure(previewSync, {}, scriptedExecutor(() => ({ stdout: '{"rev":"1"}\n' })));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });
});

describe('sync', () => {
  it('refuses to run on a read-only client', async () => {
    const error = await failure(sync, { force: true, fileSpec: TEXT }, replay('sync-os-error'));
    expect(error._tag).toBe('P4ReadOnlyError');
  });

  it('reports an operating-system error as a failure naming the file', async () => {
    const result = await run(sync, { force: true, fileSpec: TEXT }, replay('sync-os-error'), MUTATE);
    expect(result.items.map((item) => item.depotFile)).toEqual([TEXT as never]);
    expect(result.messages).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      spec: '<WORKSPACE>\\wire\\text.txt',
      reason: 'filesystem',
      message: { args: { operation: 'open for write', errmsg: 'Access is denied.' } },
    });
  });

  it('reports a writable file it would clobber as a failure naming the file', async () => {
    const result = await run(sync, { fileSpec: '//p4ts/main/wire/clobber.txt' }, replay('sync-clobber'), MUTATE);
    expect(result.items).toHaveLength(1);
    expect(result.failures.map(({ spec, reason }) => ({ spec, reason }))).toEqual([
      { spec: '<WORKSPACE>\\wire\\clobber.txt', reason: 'clobber' },
    ]);
  });

  it('syncs a file opened at an older revision with notices only', async () => {
    const result = await run(sync, { fileSpec: TEXT }, replay('sync-opened-new-head'), MUTATE);
    expect(result).toMatchObject({ items: [], failures: [] });
    expect(result.messages).toHaveLength(2);
  });

  it('keeps filesystem errors without a template as failures with no file', async () => {
    const result = await run(sync, {}, output('synthetic-review-sync-permission'), MUTATE);
    expect(result.items).toHaveLength(1);
    expect(result.failures.map(({ spec, reason }) => ({ spec, reason }))).toEqual([
      { spec: null, reason: 'fault' },
      { spec: null, reason: 'fault' },
    ]);
  });

  it('reports per-file failures printed on stderr', async () => {
    const [rename] = fixtures('synthetic-review-sync-rename');
    const lines = (rename!.stdout ?? '').split('\n').filter(Boolean);
    const executor = scriptedExecutor(() => ({
      stdout: `${lines.slice(0, 2).join('\n')}\n`, stderr: `${lines[2]}\n`, exitCode: 1,
    }));
    const result = await run(sync, {}, executor, MUTATE);
    expect(result.items).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message.text).toContain('Access is denied');
  });

  it('still fails when the server denies permission', async () => {
    const error = await failure(sync, {}, scriptedExecutor(() => ({
      stdout: `${JSON.stringify({ generic: 6, severity: 3, data: 'You don\'t have permission for this operation.' })}\n`,
      exitCode: 1,
    })), MUTATE);
    expect(error).toMatchObject({ _tag: 'P4CommandError', category: 'permission' });
  });
});

describe('sync: buffered and watched parity', () => {
  const cases: Array<{
    name: string;
    op: typeof sync;
    options: SyncOptions;
    client: P4ClientOptions;
  }> = [
    { name: 'sync-force-preview', op: previewSync, options: { force: true, fileSpec: TEXT }, client: {} },
    { name: 'sync-os-error-preview', op: previewSync, options: { force: true, fileSpec: TEXT }, client: {} },
    { name: 'sync-keep-preview', op: previewSync, options: { keepWorkspaceFiles: true, fileSpec: TEXT }, client: {} },
    { name: 'sync-outside-stream', op: previewSync, options: { fileSpec: '//p4ts/elsewhere/a.txt' }, client: {} },
    { name: 'sync-os-error', op: sync, options: { force: true, fileSpec: TEXT }, client: MUTATE },
    { name: 'sync-clobber', op: sync, options: { fileSpec: '//p4ts/main/wire/clobber.txt' }, client: MUTATE },
  ];
  for (const testCase of cases) {
    it(`${testCase.name}: the watched events and done equal the run result`, async () => {
      const result = await run(testCase.op, testCase.options, replay(testCase.name), testCase.client);
      const events = await watch(testCase.op, testCase.options, replay(testCase.name), testCase.client);
      const done = events.at(-1);
      expect(done).toEqual({ _tag: 'done', result });
      expect(events.flatMap((event) => (event._tag === 'item' ? [event.item] : []))).toEqual(result.items);
      expect(events.flatMap((event) => (event._tag === 'failure' ? [event.failure] : [])))
        .toEqual(result.failures);
      expect(events.flatMap((event) => (event._tag === 'message' ? [event.message] : []))).toEqual(result.messages);
    });
  }
});
