import { describe, expect, it } from 'bun:test';
import { getStream, listStreams } from '../../../src/commands/streams.js';
import { listUsers } from '../../../src/commands/users.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtureTime, replay, run, watch } from './support.js';
import type { P4DepotPath } from '../../../src/schemas.js';

const TAG = ['-Mj', '-z', 'tag'];

const path = (value: string) => value as P4DepotPath;

describe('directory operations: argv', () => {
  argvTable([
    argvCase('users lists every user by default', listUsers, {}, [[...TAG, 'users']]),
    argvCase('users resolves specific users, limited', listUsers, { users: ['surya', 'maya'], limit: 10 }, [
      [...TAG, 'users', '-m', '10', 'surya', 'maya'],
    ]),
    argvCase('streams lists every stream by default', listStreams, {}, [[...TAG, 'streams']]),
    argvCase('streams filters by path, limited', listStreams, { fileSpec: ['//a/...', '//b/...'], limit: 5 }, [
      [...TAG, 'streams', '-m', '5', '//a/...', '//b/...'],
    ]),
    argvCase('a stream spec is read with stream -o', getStream, { stream: '//p4ts/main' }, [[...TAG, 'stream', '-o', '//p4ts/main']], () => ({
      stdout: '{"Stream":"//p4ts/main"}\n',
    })),
  ]);
});

describe('listUsers', () => {
  it('lists users with names, emails and times', async () => {
    const users = await run(listUsers, { limit: 50 }, replay('users'));
    expect(users).toEqual({
      items: [{
        user: 'p4ts-e2e',
        email: 'p4-ts-e2e@example.invalid',
        fullName: 'p4-ts isolated E2E fixture',
        type: 'standard',
        accessedAt: fixtureTime('users', 'Access'),
        updatedAt: fixtureTime('users', 'Update'),
      }],
      messages: [],
      failures: [],
    });
  });

  it('reports a requested user that does not exist as a failure', async () => {
    const users = await run(listUsers, { users: ['p4ts-e2e', 'missing-user'] }, replay('users-mixed'));
    expect(users.items.map((user) => user.user)).toEqual(['p4ts-e2e']);
    expect(users.failures.map((failure) => [failure.reason, failure.message.severity, failure.spec])).toEqual([
      ['unknown_user', 'warning', 'missing-user'],
    ]);
    expect(users.messages).toEqual([]);
  });

  it('does not fail when no requested user exists', async () => {
    const users = await run(listUsers, { users: ['missing-user'] }, replay('users-unknown'));
    expect(users.items).toEqual([]);
    expect(users.failures.map((message) => message.reason)).toEqual(['unknown_user']);
  });

  it('reports users as items and missing users as failures while running', async () => {
    const events = await watch(listUsers, { users: ['p4ts-e2e', 'missing-user'] }, replay('users-mixed'));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'failure', 'done']);
  });

  it('rejects a non-positive limit', async () => {
    const error = await failure(listUsers, { limit: -1 }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'limit' });
  });
});

describe('listStreams', () => {
  it('lists streams with their parents and options', async () => {
    const streams = await run(listStreams, { fileSpec: '//p4ts/...', limit: 50 }, replay('streams'));
    expect(streams.messages).toEqual([]);
    expect(streams.items).toEqual([
      {
        stream: path('//p4ts/consumer'),
        name: 'consumer',
        owner: 'p4ts-e2e',
        parent: null,
        type: 'mainline',
        description: 'Import fixture',
        options: ['allsubmit', 'unlocked', 'notoparent', 'nofromparent', 'mergedown'],
        accessedAt: fixtureTime('streams', 'Access'),
        updatedAt: fixtureTime('streams', 'Update'),
      },
      expect.objectContaining({ stream: path('//p4ts/main'), name: 'main', description: 'Disposable p4-ts E2E mainline stream.' }),
    ]);
  });

  it('reads a child stream parent and falls back to the path for a missing name', async () => {
    const streams = await run(listStreams, {}, scriptedExecutor(() => ({
      stdout: '{"Stream":"//p4ts/dev","Parent":"//p4ts/main","Type":"development"}\n',
    })));
    expect(streams.items[0]).toMatchObject({ name: 'dev', parent: path('//p4ts/main'), options: [], description: null });
  });

  it('gives no streams for a path that matches none', async () => {
    const streams = await run(listStreams, { fileSpec: '//p4ts/missing' }, replay('streams-empty'));
    expect(streams.items).toEqual([]);
    expect(streams.messages.map((message) => [message.reason, message.severity])).toEqual([['unknown_stream', 'warning']]);
  });
});

describe('getStream', () => {
  it('reads a stream spec', async () => {
    const spec = await run(getStream, { stream: '//p4ts/main' }, replay('stream-spec'));
    expect(spec).toEqual({
      stream: path('//p4ts/main'),
      name: 'main',
      owner: 'p4ts-e2e',
      parent: null,
      type: 'mainline',
      description: 'Disposable p4-ts E2E mainline stream.',
      options: ['allsubmit', 'unlocked', 'notoparent', 'nofromparent', 'mergedown'],
      parentView: 'inherit',
      paths: ['share ...'],
      remapped: [],
      ignored: [],
      messages: [],
    });
  });

  it('keeps every Paths line in order', async () => {
    const spec = await run(getStream, { stream: '//p4ts/consumer' }, replay('stream-import-spec'));
    expect(spec.paths).toEqual(['share ...', 'import vendor/... //p4ts/main/src/...']);
  });

  it('fails when stream -o prints no spec', async () => {
    const error = await failure(getStream, { stream: '//p4ts/main' }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });
});
