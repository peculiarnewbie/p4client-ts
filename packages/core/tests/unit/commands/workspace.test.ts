import { describe, expect, it } from 'bun:test';
import { getEnvironment } from '../../../src/commands/environment.js';
import { listOpenedFiles } from '../../../src/commands/opened.js';
import { listWorkspaces } from '../../../src/commands/workspaces.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtures, replay, run, watch } from './support.js';

const TAG = ['-Mj', '-z', 'tag'];

describe('workspace operations: argv', () => {
  argvTable([
    argvCase('environment uses info -s', getEnvironment, {}, [[...TAG, 'info', '-s']], () => ({ stdout: '{"userName":"u"}\n' })),
    argvCase('workspaces list every workspace by default', listWorkspaces, {}, [[...TAG, 'clients']]),
    argvCase('workspaces filter by user and stream', listWorkspaces, { user: 'arif', stream: '//p4ts/main' }, [
      [...TAG, 'clients', '-u', 'arif', '-S', '//p4ts/main'],
    ]),
    argvCase('opened files filter by user, workspace, changelist and spec', listOpenedFiles, {
      user: 'arif', client: 'ws', change: 'default', fileSpec: ['//d/a/...', '//d/b/...'],
    }, [[...TAG, 'opened', '-u', 'arif', '-C', 'ws', '-c', 'default', '//d/a/...', '//d/b/...']]),
    argvCase('opened files across workspaces', listOpenedFiles, { allClients: true, fileSpec: '//d/x' }, [
      [...TAG, 'opened', '-a', '//d/x'],
    ]),
  ]);
});

describe('getEnvironment', () => {
  it('reports the server view of the connection and the configured port', async () => {
    const environment = await run(getEnvironment, {}, replay('info-short-json'), { connection: { port: 'ssl:p4:1666' } });
    expect(environment).toEqual({
      user: 'p4ts-e2e',
      client: 'p4ts_e2e_client',
      clientHost: 'p4ts_e2e_client',
      port: 'ssl:p4:1666',
      serverAddress: 'DESKTOP-WORK-ARIF:64747',
      serverVersion: 'P4D/NTX64/2026.1/3089746 (2026/10/07)',
      unicode: true,
      caseInsensitive: true,
      messages: [],
    });
  });

  it('fails when the server cannot be reached', async () => {
    const stderr = fixtures('server-unreachable')[0]!.stderr;
    const error = await failure(getEnvironment, {}, scriptedExecutor(() => ({ stderr, exitCode: 1 })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'server_unreachable' });
  });

  it('reports no workspace when the server knows none', async () => {
    const environment = await run(getEnvironment, {}, scriptedExecutor(() => ({
      stdout: '{"userName":"arif","clientName":"*unknown*"}\n',
    })));
    expect(environment).toMatchObject({ user: 'arif', client: null, port: null });
  });
});

describe('listWorkspaces', () => {
  it('lists workspaces with timestamps as ISO 8601', async () => {
    const result = await run(listWorkspaces, { user: 'p4ts-e2e' }, replay('clients'));
    expect(result.items).toEqual([{
      client: 'p4ts_e2e_client',
      owner: 'p4ts-e2e',
      root: '<WORKSPACE>',
      host: null,
      stream: '//p4ts/main' as never,
      description: null,
      accessedAt: new Date(1791937499 * 1000).toISOString(),
      updatedAt: new Date(1791937500 * 1000).toISOString(),
    }]);
  });

  it('keeps hostless workspaces and those restricted to the host', async () => {
    const result = await run(listWorkspaces, { user: 'p4ts-e2e', host: 'elsewhere' }, replay('clients'));
    expect(result.items.map((workspace) => workspace.client)).toEqual(['p4ts_e2e_client']);
  });
});

describe('listOpenedFiles', () => {
  it('decodes opened files, including both halves of a move', async () => {
    const result = await run(listOpenedFiles, {}, replay('opened-move'));
    expect(result.items.map((file): unknown[] => [file.action, file.depotFile, file.movedFile, file.change, file.haveRevision])).toEqual([
      ['move/add', '//p4ts/main/wire/renamed.txt', '//p4ts/main/wire/text.txt', 'default', 2],
      ['move/delete', '//p4ts/main/wire/text.txt', '//p4ts/main/wire/renamed.txt', 'default', 2],
    ]);
  });

  it('reports locks held by the listing workspace', async () => {
    const [file] = (await run(listOpenedFiles, { allClients: true, fileSpec: '//p4ts/main/wire/exclusive.uasset' }, replay('opened-other-client'))).items;
    expect(file).toMatchObject({ client: 'wire_second', type: 'binary+l', locked: true });
  });

  it('keeps reserved characters escaped in depot paths', async () => {
    const [file] = (await run(listOpenedFiles, { fileSpec: '//p4ts/main/wire/literal%40%23%25.txt' }, replay('opened-reserved'))).items;
    expect(file?.depotFile).toBe('//p4ts/main/wire/literal%40%23%25.txt' as never);
  });

  it('streams each file and counts progress', async () => {
    const events = await watch(listOpenedFiles, { change: 'default' }, replay('opened-default'));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
  });

  it('returns nothing for a spec with no opened files', async () => {
    const result = await run(listOpenedFiles, { fileSpec: '//p4ts/main/wire/text.txt' }, replay('opened-empty'));
    expect(result).toEqual({ items: [], messages: [] });
  });
});
