import { describe, expect, it } from 'bun:test';
import { listChangelists } from '../../../src/commands/changelists.js';
import { describeChangelist } from '../../../src/commands/describe.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtureTime, fixtures, replay, run, watch } from './support.js';

const TAG = ['-Mj', '-z', 'tag'];

const changeRows = (...changes: number[]) =>
  changes.map((change) => JSON.stringify({ change: String(change), status: 'submitted', desc: `c${change}`, time: '0' })).join('\n');

describe('changelist operations: argv', () => {
  argvTable([
    argvCase('pending changelists always read full descriptions, then the default changelist', listChangelists, {
      status: 'pending', limit: 4, user: 'arif', client: 'ws',
    }, [
      [...TAG, 'changes', '-s', 'pending', '-l', '-m', '5', '-u', 'arif', '-c', 'ws'],
      [...TAG, 'opened', '-u', 'arif', '-C', 'ws', '-c', 'default'],
    ]),
    argvCase('the default changelist can be left out', listChangelists, { status: 'pending', includeDefault: false }, [
      [...TAG, 'changes', '-s', 'pending', '-l', '-m', '51'],
    ]),
    argvCase('a cursor scopes every spec below it', listChangelists, {
      status: 'submitted', limit: 4, cursor: 4, fileSpec: ['//p4ts/main/wire/...', '//p4ts/main/docs/...'],
    }, [[...TAG, 'changes', '-s', 'submitted', '-l', '-m', '5', '//p4ts/main/wire/...@4', '//p4ts/main/docs/...@4']]),
    argvCase('a cursor without specs scopes the whole depot', listChangelists, { status: 'shelved', cursor: 9 }, [
      [...TAG, 'changes', '-s', 'shelved', '-l', '-m', '51', '//...@9'],
    ]),
    argvCase('describe lists files without diffs', describeChangelist, { change: 6 }, [[...TAG, 'describe', '-s', '6']]),
    argvCase('describe reads shelved files with -S', describeChangelist, { change: 7, shelved: true }, [
      [...TAG, 'describe', '-S', '-s', '7'],
    ]),
    argvCase('the default changelist is described from opened files', describeChangelist, { change: 'default', client: 'ws' }, [
      [...TAG, 'opened', '-C', 'ws', '-c', 'default'],
    ]),
  ]);
});

describe('listChangelists', () => {
  it('lists submitted changelists newest first with full descriptions', async () => {
    const page = await run(listChangelists, { status: 'submitted', limit: 4, fileSpec: '//p4ts/main/wire/...' }, replay('changes-submitted'));
    expect(page.items.map((item) => [item.change, item.status])).toEqual([[6, 'submitted'], [4, 'submitted']]);
    expect(page).toMatchObject({ hasMore: false, nextCursor: null, messages: [] });
  });

  it('merges changelists reported by several scopes', async () => {
    const page = await run(listChangelists, {
      status: 'submitted', limit: 4, cursor: 4, fileSpec: ['//p4ts/main/wire/...', '//p4ts/main/docs/...'],
    }, replay('changes-multi-scope'));
    expect(page.items.map((item) => item.change)).toEqual([4, 2]);
    expect(page.items[0]?.description).toContain('\r\nsecond paragraph');
  });

  it('pages with a cursor below the oldest changelist shown', async () => {
    const page = await run(listChangelists, { status: 'submitted', limit: 2 }, scriptedExecutor(() => ({
      stdout: changeRows(9, 7, 5),
    })));
    expect(page.items.map((item) => item.change)).toEqual([9, 7]);
    expect(page).toMatchObject({ hasMore: true, nextCursor: 6 });
  });

  it('ends paging on an exactly full last page', async () => {
    const page = await run(listChangelists, { status: 'submitted', limit: 2 }, scriptedExecutor(() => ({
      stdout: changeRows(9, 7),
    })));
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('puts the default changelist first when files are open in it', async () => {
    const page = await run(listChangelists, { status: 'pending', limit: 4 }, scriptedExecutor((invocation) => ({
      stdout: invocation.args.includes('opened')
        ? '{"action":"edit","change":"default","client":"ws","depotFile":"//d/a.txt","user":"arif"}\n'
        : '{"change":"7","client":"ws","desc":"Pending\\n","status":"pending","time":"1791937503","user":"arif"}\n',
    })));
    expect(page.items.map((item) => [item.change, item.isDefault, item.description])).toEqual([
      ['default', true, 'Default changelist'],
      [7, false, 'Pending'],
    ]);
  });

  it('reads pending changelists from the long listing', async () => {
    const page = await run(listChangelists, { status: 'pending', limit: 4, includeDefault: false }, replay('changes-pending-long'));
    expect(page.items).toEqual([{
      change: 7,
      status: 'pending',
      user: 'p4ts-e2e',
      client: 'p4ts_e2e_client',
      description: 'Pending wire fixture',
      createdAt: fixtureTime('changes-pending-long', 'time'),
      isDefault: false,
    }]);
  });

  it('filters pending changelists by user and workspace', async () => {
    const page = await run(listChangelists, {
      status: 'pending', limit: 4, user: 'p4ts-e2e', client: 'p4ts_e2e_client', includeDefault: false,
    }, replay('changes-pending'));
    expect(page.items.map((item) => [item.change, item.user, item.client])).toEqual([[7, 'p4ts-e2e', 'p4ts_e2e_client']]);
  });

  it('returns an empty page when nothing matches', async () => {
    const empty = { items: [], messages: [], hasMore: false, nextCursor: null };
    expect(await run(listChangelists, { status: 'submitted', limit: 4, fileSpec: '//p4ts/main/missing.txt' }, replay('changes-empty')))
      .toEqual(empty);
    expect(await run(listChangelists, { status: 'pending', limit: 4, includeDefault: false }, replay('changes-pending-empty')))
      .toEqual(empty);
    expect(await run(listChangelists, { status: 'shelved', limit: 4 }, replay('changes-shelved-empty'))).toEqual(empty);
  });

  it('lists shelved changelists', async () => {
    const page = await run(listChangelists, { status: 'shelved', limit: 4 }, replay('changes-shelved'));
    expect(page.items.map((item) => [item.change, item.status])).toEqual([[7, 'shelved']]);
  });

  it('rejects a cursor on a spec that has its own revision', async () => {
    const error = await failure(listChangelists, { status: 'submitted', cursor: 3, fileSpec: '//d/...@5' }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'cursor' });
  });

  it('rejects a non-positive limit', async () => {
    const error = await failure(listChangelists, { status: 'submitted', limit: 0 }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'limit' });
  });

  it('fails with the session reason when the ticket expired', async () => {
    const [expired] = fixtures('changes-ticket-expired');
    const error = await failure(listChangelists, { status: 'submitted' }, scriptedExecutor(() => ({
      stdout: expired!.stdout ?? '', stderr: expired!.stderr, exitCode: expired!.exitCode,
    })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'ticket_expired' });
  });
});

describe('describeChangelist', () => {
  it('describes a submitted changelist and its files', async () => {
    const described = await run(describeChangelist, { change: 6 }, replay('describe-submitted'));
    expect(described).toMatchObject({ change: 6, status: 'submitted', messages: [] });
    expect(described.files.length).toBeGreaterThan(0);
  });

  it('describes both halves of a move in index order', async () => {
    const described = await run(describeChangelist, { change: 9 }, replay('describe-move'));
    expect(described.files).toEqual([
      { depotFile: '//p4ts/main/wire/renamed.txt' as never, action: 'move/add' as never, type: 'text', revision: 1, digest: '64782508BE6BBB8B63A26A5618632559', fileSize: 23 },
      { depotFile: '//p4ts/main/wire/text.txt' as never, action: 'move/delete' as never, type: 'text', revision: 3, digest: null, fileSize: null },
    ]);
  });

  it('reports shelved files of a pending changelist as shelved', async () => {
    const described = await run(describeChangelist, { change: 7, shelved: true }, replay('describe-shelved'));
    expect(described.status).toBe('shelved');
    expect(described.files.map((file) => [file.depotFile, file.digest])).toEqual([
      ['//p4ts/main/wire/text.txt', 'BEA78C532A285D61600CF8671029102B'],
    ]);
  });

  it('keeps a submitted changelist submitted when asked for shelved files', async () => {
    const described = await run(describeChangelist, { change: 6, shelved: true }, replay('describe-submitted-shelved-flag'));
    expect(described.status).toBe('submitted');
  });

  it('describes a pending changelist with nothing shelved', async () => {
    const described = await run(describeChangelist, { change: 7, shelved: true }, replay('describe-shelved-empty'));
    expect(described).toMatchObject({ status: 'shelved', files: [] });
  });

  it('describes pending opened files', async () => {
    const described = await run(describeChangelist, { change: 7 }, replay('describe-pending'));
    expect(described).toMatchObject({ status: 'pending', description: 'Pending wire fixture' });
    expect(described.files.map((file): string => file.action)).toEqual(['edit']);
  });

  it('fails for a changelist that does not exist', async () => {
    const error = await failure(describeChangelist, { change: 999999 }, replay('describe-unknown'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'unknown_changelist', exitCode: 0 });
  });

  it('decodes thousands of files and reports them as one progress step', async () => {
    const events = await watch(describeChangelist, { change: 11 }, replay('describe-large'));
    const done = events.at(-1);
    const files = done?._tag === 'done' ? done.result.files : [];
    expect(files.length).toBeGreaterThan(1000);
    expect(events.filter((event) => event._tag === 'progress')).toHaveLength(1);
  });

  it('describes the default changelist from opened files', async () => {
    const described = await run(describeChangelist, { change: 'default' }, scriptedExecutor(() => ({
      stdout: '{"action":"add","change":"default","client":"ws","depotFile":"//d/new.txt","rev":"1","type":"text","user":"arif"}\n',
    })));
    expect(described).toMatchObject({ change: 'default', status: 'pending', client: 'ws', user: 'arif' });
    expect(described.files.map((file) => file.depotFile)).toEqual(['//d/new.txt' as never]);
  });

  it('refuses shelved files of the default changelist', async () => {
    const error = await failure(describeChangelist, { change: 'default', shelved: true }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'shelved' });
  });
});
