import { describe, expect, it } from 'bun:test';
import {
  listDepotDirs,
  listDepotFiles,
  listDepotFilesAtChange,
  listDepots,
  listFiles,
  listHaveFiles,
  statFiles,
  whereFiles,
} from '../../../src/commands/files.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtureTime, fixtures, replay, run, watch } from './support.js';

const TAG = ['-Mj', '-z', 'tag'];

const fileRows = (...rows: Array<[string, string]>) => rows
  .map(([depotFile, action]) => JSON.stringify({ depotFile, action, rev: '1', change: '4', type: 'text', time: '0' }))
  .join('\n');

const reasons = (messages: ReadonlyArray<{ readonly reason: string }>) => messages.map((message) => message.reason);

describe('file operations: argv', () => {
  argvTable([
    argvCase('depots', listDepots, {}, [[...TAG, 'depots']]),
    argvCase('dirs lists one level below the directory, at a changelist', listDepotDirs, {
      depotPath: '//depot/main/', atChange: 5, limit: 2,
    }, [[...TAG, 'dirs', '//depot/main/*@5']]),
    argvCase('depot files leave deleted files out on the server by default', listDepotFiles, { depotPath: '//depot/main' }, [
      [...TAG, 'files', '-e', '//depot/main/*'],
    ]),
    argvCase('depot files bound the listing with one extra row', listDepotFiles, {
      depotPath: '//p4ts/main/wire', atChange: 6, limit: 49,
    }, [[...TAG, 'files', '-e', '-m', '50', '//p4ts/main/wire/*@6']]),
    argvCase('depot files including deleted ones are bounded on the server', listDepotFiles, {
      depotPath: '//depot/main', deletedFiles: 'include', limit: 2,
    }, [[...TAG, 'files', '-m', '3', '//depot/main/*']]),
    argvCase('only deleted depot files list the whole level', listDepotFiles, {
      depotPath: '//depot/main', deletedFiles: 'only', limit: 2,
    }, [[...TAG, 'files', '//depot/main/*']]),
    argvCase('files takes several specs', listFiles, {
      fileSpec: ['//depot/a.txt', '//depot/b/...'], existing: true, limit: 10,
    }, [[...TAG, 'files', '-e', '-m', '11', '//depot/a.txt', '//depot/b/...']]),
    argvCase('files at a changelist', listDepotFilesAtChange, { file: '//depot/main/...', change: 7, limit: 3 }, [
      [...TAG, 'files', '-e', '-m', '4', '//depot/main/...@7'],
    ]),
    argvCase('fstat with sizes, a limit, fields and a changelist', statFiles, {
      fileSpec: ['//depot/a.txt', '//depot/b.txt'], includeFileSize: true, limit: 1, fields: ['headType', 'depotFile'], atChange: 3,
    }, [[...TAG, 'fstat', '-Ol', '-m', '1', '-T', 'depotFile headType', '//depot/a.txt@3', '//depot/b.txt@3']]),
    argvCase('where takes several specs', whereFiles, { fileSpec: ['//depot/a.txt', 'local.txt'] }, [
      [...TAG, 'where', '//depot/a.txt', 'local.txt'],
    ]),
    argvCase('have without specs lists the whole workspace', listHaveFiles, {}, [[...TAG, 'have']]),
    argvCase('fstat without specs runs nothing', statFiles, { fileSpec: [] }, []),
    argvCase('where without specs runs nothing', whereFiles, { fileSpec: [] }, []),
    argvCase('files without specs runs nothing', listFiles, { fileSpec: [] }, []),
  ]);
});

describe('listDepots', () => {
  it('lists depots with their roots', async () => {
    const depots = await run(listDepots, {}, replay('depots'));
    expect(depots.items).toEqual([
      {
        name: 'depot', depotPath: '//depot' as never, type: 'local', map: 'depot/...',
        description: 'Default depot', createdAt: fixtureTime('depots', 'time', (row) => row.name === 'depot'),
      },
      {
        name: 'p4ts', depotPath: '//p4ts' as never, type: 'stream', map: 'p4ts/...',
        description: 'Disposable p4-ts E2E conformance depot.', createdAt: fixtureTime('depots', 'time', (row) => row.name === 'p4ts'),
      },
    ]);
    expect(depots.messages).toEqual([]);
  });
});

describe('listDepotDirs', () => {
  it('lists one level of directories', async () => {
    const dirs = await run(listDepotDirs, { depotPath: '//p4ts/main' }, replay('dirs'));
    expect(dirs.items.map((dir) => [dir.depotDir, dir.name])).toEqual([
      ['//p4ts/main/docs', 'docs'], ['//p4ts/main/src', 'src'], ['//p4ts/main/wire', 'wire'],
    ]);
    expect(dirs.hasMore).toBe(false);
  });

  it('bounds the directories locally and reports only those returned', async () => {
    const events = await watch(listDepotDirs, { depotPath: '//p4ts/main', limit: 2 }, replay('dirs'));
    const done = events.at(-1);
    expect(done?._tag === 'done' && done.result).toMatchObject({ hasMore: true, items: [{ name: 'docs' }, { name: 'src' }] });
    expect(events.filter((event) => event._tag === 'item')).toHaveLength(2);
  });

  it('lists nothing for a missing directory', async () => {
    expect(await run(listDepotDirs, { depotPath: '//p4ts/main/missing' }, replay('dirs-empty')))
      .toEqual({ items: [], messages: [], hasMore: false });
  });

  it('rejects a path with a wildcard', async () => {
    const error = await failure(listDepotDirs, { depotPath: '//depot/...' }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'depotPath' });
  });
});

describe('listDepotFiles', () => {
  it('flags deleted and binary files when deleted files are included', async () => {
    const files = await run(listDepotFiles, { depotPath: '//p4ts/main/wire', deletedFiles: 'include' }, replay('files'));
    expect(files.items).toHaveLength(8);
    expect(files.items.filter((file) => file.isDeletedAtHead).map((file) => file.name)).toEqual(['deleted.txt']);
    expect(files.items.filter((file) => file.isBinary).map((file) => file.name)).toEqual(['exclusive.uasset', 'full.uasset']);
    expect(files.items[0]).toEqual({
      depotFile: '//p4ts/main/wire/clobber.txt' as never,
      name: 'clobber.txt',
      revision: 1,
      action: 'add' as never,
      type: 'text',
      change: 4,
      submittedAt: fixtureTime('files', 'time'),
      isDeletedAtHead: false,
      isBinary: false,
    });
  });

  it('lists only deleted files', async () => {
    const files = await run(listDepotFiles, { depotPath: '//p4ts/main/wire', deletedFiles: 'only' }, replay('files'));
    expect(files.items.map((file) => [file.name, file.action])).toEqual([['deleted.txt', 'delete']]);
  });

  it('lists existing files at a changelist', async () => {
    const files = await run(listDepotFiles, { depotPath: '//p4ts/main/wire', atChange: 6, limit: 49 }, replay('files-existing'));
    expect(files.items).toHaveLength(7);
    expect(files.items.some((file) => file.isDeletedAtHead)).toBe(false);
    expect(files.hasMore).toBe(false);
  });

  it('applies the limit locally when listing only deleted files', async () => {
    const files = await run(listDepotFiles, { depotPath: '//d', deletedFiles: 'only', limit: 1 }, scriptedExecutor(() => ({
      stdout: fileRows(['//d/a', 'delete'], ['//d/b', 'edit'], ['//d/c', 'move/delete']),
    })));
    expect(files.items.map((file) => file.name)).toEqual(['a']);
    expect(files.hasMore).toBe(true);
  });

  it('rejects a revision in the directory', async () => {
    const error = await failure(listDepotFiles, { depotPath: '//depot/main@3' }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'depotPath' });
  });
});

describe('listFiles', () => {
  it('reports a spec that matches nothing as a failure beside the others', async () => {
    const files = await run(listFiles, { fileSpec: ['//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'] }, replay('files-mixed'));
    expect(files.items.map((file) => String(file.depotFile))).toEqual(['//p4ts/main/wire/text.txt']);
    expect(reasons(files.failures)).toEqual(['no_such_file']);
    expect(files.messages).toEqual([]);
  });

  it.each([
    ['files-empty', '//p4ts/main/missing.txt', 'no_such_file'],
    ['modes-json-empty', '//p4ts/main/missing.txt', 'no_such_file'],
    ['files-at-unknown-change', '//p4ts/main/wire/text.txt@=999999', 'no_such_file'],
    ['files-missing-revision', '//p4ts/main/wire/text.txt#999999', 'unknown_revision'],
    ['files-unsynced-have', '//p4ts/main/wire/text.txt#have', 'not_on_client'],
  ])('reports %s as a failure', async (name, fileSpec, reason) => {
    const files = await run(listFiles, { fileSpec }, replay(name));
    expect(files.items).toEqual([]);
    expect(reasons(files.failures)).toEqual([reason]);
  });

  it.each([
    ['modes-json-files', '//p4ts/main/wire/text.txt', 'add', 'text'],
    ['files-symlink', '//p4ts/main/wire/link', 'add', 'symlink'],
    ['files-permission', '//p4ts/main/wire/renamed.txt', 'move/add', 'text'],
  ])('lists %s', async (name, fileSpec, fileAction, type) => {
    const files = await run(listFiles, { fileSpec }, replay(name));
    expect(files.items).toMatchObject([{ depotFile: fileSpec, action: fileAction, type, isBinary: false, isDeletedAtHead: false }]);
    expect(files.failures).toEqual([]);
  });

  it('fails on an invalid revision', async () => {
    const error = await failure(listFiles, { fileSpec: '//p4ts/main/wire/text.txt#invalid' }, replay('files-bad-revision'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'invalid_revision' });
  });

  it('pages with one extra row', async () => {
    const files = await run(listFiles, { fileSpec: '//d/...', limit: 2 }, scriptedExecutor(() => ({
      stdout: fileRows(['//d/a', 'add'], ['//d/b', 'add'], ['//d/c', 'add']),
    })));
    expect(files.items.map((file) => file.name)).toEqual(['a', 'b']);
    expect(files.hasMore).toBe(true);
  });

  it('still fails when the session is not usable', async () => {
    const [expired] = fixtures('changes-ticket-expired');
    const error = await failure(listFiles, { fileSpec: ['//d/a', '//d/b'] }, scriptedExecutor(() => ({
      stdout: expired!.stdout ?? '', stderr: expired!.stderr, exitCode: expired!.exitCode,
    })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'ticket_expired' });
  });
});

describe('listDepotFilesAtChange', () => {
  it('lists exact existing revisions at a changelist', async () => {
    const files = await run(listDepotFilesAtChange, { file: '//p4ts/main/wire/*', change: 6, limit: 49 }, replay('files-existing'));
    expect(files.items).toHaveLength(7);
    expect(files.items[0]).toEqual({
      depotFile: '//p4ts/main/wire/clobber.txt' as never, revision: 1, change: 4, action: 'add' as never, type: 'text',
    });
    expect(files).toMatchObject({ hasMore: false, messages: [] });
  });

  it('reports more revisions beyond the limit, and only the limit as items', async () => {
    const events = await watch(listDepotFilesAtChange, { file: '//d/...', change: 9, limit: 1 }, scriptedExecutor(() => ({
      stdout: fileRows(['//d/a', 'add'], ['//d/b', 'edit']),
    })));
    expect(events.filter((event) => event._tag === 'item')).toHaveLength(1);
    expect(events.filter((event) => event._tag === 'progress').at(-1)).toMatchObject({
      progress: { completed: 2, total: 1, unit: 'files' },
    });
    const done = events.at(-1);
    expect(done?._tag === 'done' && done.result).toMatchObject({ hasMore: true, items: [{ depotFile: '//d/a' }] });
  });

  it('fails on a revision without a type', async () => {
    const error = await failure(listDepotFilesAtChange, { file: '//d/...', change: 9, limit: 1 }, scriptedExecutor(() => ({
      stdout: '{"depotFile":"//d/a","rev":"1","change":"4","action":"add"}\n',
    })));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });

  it('rejects a path with a revision', async () => {
    const error = await failure(listDepotFilesAtChange, { file: '//d/...#3', change: 9, limit: 1 }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'file' });
  });
});

describe('statFiles', () => {
  it('reads head, have and workspace state', async () => {
    const stats = await run(statFiles, { fileSpec: '//p4ts/main/wire/*', limit: 50 }, replay('fstat'));
    expect(stats.items).toHaveLength(8);
    expect(stats.items.find((stat) => stat.depotFile.endsWith('deleted.txt'))).toMatchObject({
      isDeletedAtHead: true, haveRevision: null, isOutOfDate: false,
    });
    expect(stats.items[0]).toEqual({
      depotFile: '//p4ts/main/wire/clobber.txt' as never,
      localFile: '<WORKSPACE>\\wire\\clobber.txt' as never,
      isMapped: true,
      headAction: 'add' as never,
      headType: 'text',
      headRevision: 1,
      headChange: 4,
      headTime: fixtureTime('fstat', 'headTime'),
      haveRevision: 1,
      fileSize: null,
      digest: null,
      isDeletedAtHead: false,
      isOutOfDate: false,
      isBinary: false,
      openAction: null,
      openChange: null,
      openType: null,
      isUnresolved: false,
      otherOpen: [],
      otherLocked: false,
    });
  });

  it('reads sizes and digests', async () => {
    const stats = await run(statFiles, { fileSpec: '//p4ts/main/wire/text.txt', includeFileSize: true, limit: 1 }, replay('fstat-size'));
    expect(stats.items).toMatchObject([{ fileSize: 8, digest: '2094B601DAAC3D68F5AED51D3C20F7CD' }]);
  });

  it('reads only the requested fields', async () => {
    const stats = await run(statFiles, { fileSpec: '//p4ts/main/wire/text.txt', fields: ['headType', 'headRev'] }, replay('fstat-fields'));
    expect(stats.items).toMatchObject([{ headType: 'text', headRevision: 1, localFile: null, isMapped: false }]);
  });

  it('fails on a record without a depot path', async () => {
    const [capture] = fixtures('fstat-fields-without-path');
    const error = await failure(statFiles, { fileSpec: '//p4ts/main/wire/text.txt' }, scriptedExecutor(() => ({
      stdout: capture!.stdout ?? '',
    })));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });

  it('reads other workspaces that have the file open and locked', async () => {
    const stats = await run(statFiles, { fileSpec: '//p4ts/main/wire/exclusive.uasset' }, replay('fstat-exclusive-other'));
    expect(stats.items).toMatchObject([{ otherOpen: ['p4ts-e2e@wire_second'], otherLocked: true, isBinary: true }]);
  });

  it('reads how this workspace has the file open', async () => {
    const [reserved] = (await run(statFiles, { fileSpec: '//p4ts/main/wire/literal%40%23%25.txt' }, replay('fstat-reserved'))).items;
    expect(reserved).toMatchObject({
      localFile: '<WORKSPACE>\\wire\\literal@#%.txt', openAction: 'edit', openChange: 'default', openType: 'text', isUnresolved: false,
    });
    const [unresolved] = (await run(statFiles, { fileSpec: '//p4ts/main/wire/text.txt' }, replay('fstat-unresolved'))).items;
    expect(unresolved).toMatchObject({ openAction: 'edit', isUnresolved: true, haveRevision: 2, isOutOfDate: false });
  });

  it('reports a missing file as a failure beside the others', async () => {
    const stats = await run(statFiles, { fileSpec: ['//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'] }, replay('fstat-mixed-missing'));
    expect(stats.items.map((stat) => String(stat.depotFile))).toEqual(['//p4ts/main/wire/text.txt']);
    expect(reasons(stats.failures)).toEqual(['no_such_file']);
  });

  it('reports a missing revision as a failure beside the others', async () => {
    const stats = await run(statFiles, {
      fileSpec: ['//p4ts/main/wire/text.txt#999999', '//p4ts/main/docs/guide/getting-started.md'],
    }, replay('fstat-mixed-revision'));
    expect(stats.items.map((stat) => String(stat.depotFile))).toEqual(['//p4ts/main/docs/guide/getting-started.md']);
    expect(reasons(stats.failures)).toEqual(['unknown_revision']);
  });

  it('reports a single missing file as a failure', async () => {
    const stats = await run(statFiles, { fileSpec: '//p4ts/main/missing.txt' }, replay('fstat-empty'));
    expect(stats).toMatchObject({ items: [], messages: [] });
    expect(reasons(stats.failures)).toEqual(['no_such_file']);
  });
});

describe('whereFiles', () => {
  it('maps a depot path to client and local syntax', async () => {
    const mapped = await run(whereFiles, { fileSpec: '//p4ts/main/wire/text.txt' }, replay('where'));
    expect(mapped).toEqual({
      items: [{
        depotFile: '//p4ts/main/wire/text.txt' as never,
        clientFile: '//p4ts_e2e_client/wire/text.txt' as never,
        localFile: '<WORKSPACE>\\wire\\text.txt' as never,
        isExcluded: false,
      }],
      messages: [],
      failures: [],
    });
  });

  it('keeps reserved characters escaped in depot and client syntax only', async () => {
    const mapped = await run(whereFiles, { fileSpec: '//p4ts/main/wire/literal%40%23%25.txt' }, replay('where-reserved'));
    expect(mapped.items).toMatchObject([{
      depotFile: '//p4ts/main/wire/literal%40%23%25.txt',
      clientFile: '//p4ts_e2e_client/wire/literal%40%23%25.txt',
      localFile: '<WORKSPACE>\\wire\\literal@#%.txt',
    }]);
  });

  it('reports a spec outside the view as a failure beside the others, despite the exit code', async () => {
    const mapped = await run(whereFiles, { fileSpec: ['//p4ts/main/wire/text.txt', '//other/main/a.txt'] }, replay('where-mixed'));
    expect(mapped.items.map((item) => String(item.depotFile))).toEqual(['//p4ts/main/wire/text.txt']);
    expect(reasons(mapped.failures)).toEqual(['not_in_view']);
  });

  it('reports a single spec outside the view as a failure', async () => {
    const mapped = await run(whereFiles, { fileSpec: '//other/main/a.txt' }, replay('where-not-in-view'));
    expect(mapped.items).toEqual([]);
    expect(mapped.failures).toMatchObject([{ spec: '//other/main/a.txt', reason: 'not_in_view', message: { category: 'not_in_view' } }]);
  });

  it('flags exclusion rows', async () => {
    const mapped = await run(whereFiles, { fileSpec: '//d/x/a.txt' }, scriptedExecutor(() => ({
      stdout: '{"depotFile":"-//d/x/a.txt","clientFile":"-//ws/x/a.txt","path":"-C:\\\\ws\\\\x\\\\a.txt","unmap":""}\n',
    })));
    expect(mapped.items).toEqual([{
      depotFile: '//d/x/a.txt' as never, clientFile: '//ws/x/a.txt' as never, localFile: 'C:\\ws\\x\\a.txt' as never, isExcluded: true,
    }]);
  });
});

describe('listHaveFiles', () => {
  it('lists the revisions the workspace has', async () => {
    const have = await run(listHaveFiles, { fileSpec: '//p4ts/main/wire/text.txt' }, replay('have'));
    expect(have.items).toEqual([{
      depotFile: '//p4ts/main/wire/text.txt' as never,
      clientFile: '//p4ts_e2e_client/wire/text.txt' as never,
      localFile: '<WORKSPACE>\\wire\\text.txt' as never,
      haveRevision: 1,
      syncedAt: fixtureTime('have', 'syncTime'),
    }]);
  });

  it('reports a spec the workspace does not have as a failure', async () => {
    const have = await run(listHaveFiles, { fileSpec: '//p4ts/main/missing.txt' }, replay('have-not-on-client'));
    expect(have.items).toEqual([]);
    expect(reasons(have.failures)).toEqual(['not_on_client']);
  });

  it('lists nothing for an empty workspace', async () => {
    const [capture] = fixtures('have-not-on-client');
    const have = await run(listHaveFiles, {}, scriptedExecutor(() => ({ stdout: capture!.stdout ?? '' })));
    expect(have.failures).toEqual([]);
    expect(reasons(have.messages)).toEqual(['not_on_client']);
  });
});
