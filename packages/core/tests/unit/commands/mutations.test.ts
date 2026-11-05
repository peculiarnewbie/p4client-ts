import { Predicate, Schema } from 'effect';
import { describe, expect, it } from 'bun:test';
import { createChange, deleteChange } from '../../../src/commands/change.js';
import { listChangelists } from '../../../src/commands/changelists.js';
import { describeChangelists } from '../../../src/commands/describe.js';
import { getEnvironment } from '../../../src/commands/environment.js';
import { statFiles } from '../../../src/commands/files.js';
import { openForAdd, openForEdit, previewOpenForAdd, previewOpenForEdit } from '../../../src/commands/open.js';
import { previewRevert, revert } from '../../../src/commands/revert.js';
import { setPersistentWorkspace } from '../../../src/node/connection.js';
import { commandArgs, recordingExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { failure, fixtures, invocations, replay, run, watch } from './support.js';
import { asAction, asDepotPath, asLocalPath } from '../../support/values.js';
import type { P4ClientOptions } from '../../../src/engine/config.js';
import { P4CommandError, P4InvalidArgumentError, P4ParseError, P4ReadOnlyError } from '../../../src/errors.js';
import { expectFailure } from '../../support/assert.js';

const TAG = ['-Mj', '-z', 'tag'];
const MUTATE: P4ClientOptions = { allowMutation: true };
const BLAME = '//p4ts/main/blame/blame.txt';
const ADDED = '<WORKSPACE>\\wire\\added.uasset';
const EXCLUSIVE = '//p4ts/main/wire/exclusive.uasset';

describe('the mutation guard', () => {
  const none = () => {
    throw new Error('p4 must not run');
  };

  it.each([
    ['createChange', () => failure(createChange, { description: 'x' }, scriptedExecutor(none))],
    ['deleteChange', () => failure(deleteChange, { change: 15 }, scriptedExecutor(none))],
    ['openForEdit', () => failure(openForEdit, { fileSpec: BLAME }, scriptedExecutor(none))],
    ['openForAdd', () => failure(openForAdd, { fileSpec: ADDED }, scriptedExecutor(none))],
    ['revert', () => failure(revert, { change: 15 }, scriptedExecutor(none))],
    ['setPersistentWorkspace', () => failure(setPersistentWorkspace, { client: 'ws' }, scriptedExecutor(none))],
  ])('refuses %s on a read-only client before running p4', async (_name, attempt) => {
    expectFailure(await attempt(), P4ReadOnlyError);
  });

  it('runs previews without allowMutation', async () => {
    expect((await run(previewOpenForEdit, { fileSpec: BLAME, change: 15 }, replay('edit-preview'))).items).toHaveLength(1);
    expect((await run(previewOpenForAdd, { fileSpec: ADDED, change: 15, type: 'binary+l' }, replay('add-preview'))).items)
      .toHaveLength(1);
    expect((await run(previewRevert, { change: 15 }, replay('revert-preview'))).items).toHaveLength(2);
  });
});

describe('createChange', () => {
  it('writes a tab-indented spec without Files and returns the new number', async () => {
    const result = await run(createChange, { description: 'Wire mutation fixture\r\nsecond line\n\n' }, replay('change-create'), MUTATE);
    expect(result).toEqual({ change: 15, messages: [] });
  });

  it('fails with the server diagnostics for a rejected spec', async () => {
    const recorder = recordingExecutor(scriptedExecutor(() => {
      const fixture = fixtures('change-create-invalid')[0]!;

      return { stderr: fixture.stderr, exitCode: fixture.exitCode };
    }));

    const error = await failure(createChange, { description: 'x' }, recorder.layer, MUTATE);
    expectFailure(error, P4CommandError);
    expect(Predicate.isTagged(error, 'P4CommandError') ? error.messages.map((message) => message.text) : [])
      .toContain("Missing required field 'Description'.");
    expect(recorder.invocations[0]?.input).toBe('Change: new\nDescription:\n\tx\n');
  });

  it('rejects a blank description before running p4', async () => {
    expectFailure(await failure(createChange, { description: ' \n\t' }, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'description' });
  });

  it('fails when p4 reports no new changelist', async () => {
    expectFailure(await failure(createChange, { description: 'x' }, scriptedExecutor(() => ({ stdout: 'Change updated.\n' })), MUTATE), P4ParseError);
  });
});

describe('deleteChange', () => {
  it('deletes an empty pending changelist', async () => {
    const result = await run(deleteChange, { change: 15 }, replay('change-delete'), MUTATE);
    expect(result.change).toBe(15);
    expect(result.messages.map((message) => message.text)).toEqual(['Change 15 deleted.']);
  });

  it('fails while files are open in it', async () => {
    expectFailure(await failure(deleteChange, { change: 15 }, replay('change-delete-not-empty'), MUTATE), P4CommandError, { reason: 'changelist_not_empty', category: 'conflict' });
  });

  it('fails for a changelist that does not exist', async () => {
    expectFailure(await failure(deleteChange, { change: 15 }, replay('change-delete-unknown'), MUTATE), P4CommandError, { reason: 'unknown_changelist' });
  });

  it('rejects a changelist that is not a positive integer', async () => {
    expectFailure(await failure(deleteChange, { change: 0 }, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'change' });
  });
});

describe('openForEdit', () => {
  it('opens files in a numbered changelist', async () => {
    const result = await run(openForEdit, { fileSpec: BLAME, change: 15 }, replay('edit-change'), MUTATE);
    expect(result).toEqual({
      items: [{
        depotFile: asDepotPath(BLAME),
        clientFile: asLocalPath('<WORKSPACE>\\blame\\blame.txt'),
        action: asAction('edit'),
        type: 'text+D',
        workRevision: 3,
      }],
      failures: [],
      messages: [],
    });
  });

  it('reports a file already open as an already_opened notice', async () => {
    const result = await run(openForEdit, { fileSpec: BLAME, change: 15 }, replay('edit-already-opened'), MUTATE);
    expect(result.items).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.messages.map((message) => message.reason)).toEqual(['already_opened']);
  });

  it('returns an exclusive file open elsewhere as a typed failure naming the holder', async () => {
    for (const name of ['edit-exclusive-opened', 'exclusive-edit-failure']) {
      const result = await run(openForEdit, { fileSpec: EXCLUSIVE }, replay(name), MUTATE);
      expect(result.items).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        spec: EXCLUSIVE,
        reason: 'exclusive_open',
        heldBy: ['p4ts-e2e@wire_second'],
      });
    }
  });

  it('previews the exclusive-open refusal without opening anything', async () => {
    const result = await run(previewOpenForEdit, { fileSpec: EXCLUSIVE }, replay('edit-preview-exclusive'));
    expect(result.failures[0]).toMatchObject({ reason: 'exclusive_open', heldBy: ['p4ts-e2e@wire_second'] });
  });

  it('reports a file the workspace does not have as a failure', async () => {
    const result = await run(openForEdit, { fileSpec: '//p4ts/main/wire/missing.txt' }, replay('edit-not-on-client'), MUTATE);
    expect(result.failures).toMatchObject([{ spec: '//p4ts/main/wire/missing.txt', reason: 'not_on_client', heldBy: [] }]);
  });

  it('fails for a changelist that does not exist', async () => {
    expectFailure(await failure(openForEdit, { fileSpec: BLAME, change: 999999 }, replay('edit-unknown-change'), MUTATE), P4CommandError, { reason: 'unknown_changelist' });
  });

  it('passes -c default and every spec', async () => {
    expect(await invocations(openForEdit, { fileSpec: ['//d/a', '//d/b'], change: 'default' }, () => ({}), MUTATE))
      .toEqual([[...TAG, 'edit', '-c', 'default', '//d/a', '//d/b']]);
  });

  it('rejects an empty file list', async () => {
    expectFailure(await failure(openForEdit, { fileSpec: [] }, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'fileSpec' });
  });
});

describe('openForAdd', () => {
  it('opens a new file with a type in a numbered changelist', async () => {
    const result = await run(openForAdd, { fileSpec: ADDED, change: 15, type: 'binary+l' }, replay('add-change'), MUTATE);
    expect(result.items).toEqual([{
      depotFile: asDepotPath('//p4ts/main/wire/added.uasset'),
      clientFile: asLocalPath(ADDED),
      action: asAction('add'),
      type: 'binary+l',
      workRevision: 1,
    }]);
  });

  it('reports a file the depot already has as exists_in_depot', async () => {
    const spaced = '<WORKSPACE>\\wire\\space name.txt';
    const result = await run(openForAdd, { fileSpec: spaced, change: 15 }, replay('add-existing'), MUTATE);
    expect(result.items).toEqual([]);
    expect(result.failures).toMatchObject([{ spec: '//p4ts/main/wire/space name.txt', reason: 'exists_in_depot' }]);
  });

  it('rejects a malformed file type', async () => {
    expectFailure(await failure(openForAdd, { fileSpec: ADDED, type: 'binary -x' }, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'type' });
  });
});

describe('revert', () => {
  it('reverts everything open in a changelist', async () => {
    const result = await run(revert, { change: 15 }, replay('revert-change'), MUTATE);
    expect(result.items).toEqual([
      {
        depotFile: asDepotPath('//p4ts/main/wire/added.uasset'),
        clientFile: asLocalPath(ADDED),
        action: 'abandoned',
        previousAction: asAction('add'),
        haveRevision: null,
      },
      {
        depotFile: asDepotPath(BLAME),
        clientFile: asLocalPath('<WORKSPACE>\\blame\\blame.txt'),
        action: 'reverted',
        previousAction: asAction('edit'),
        haveRevision: 3,
      },
    ]);
  });

  it('treats nothing open as a not_opened notice', async () => {
    const result = await run(revert, { change: 15 }, replay('revert-not-opened'), MUTATE);
    expect(result.items).toEqual([]);
    expect(result.messages.map((message) => message.reason)).toEqual(['not_opened']);
  });

  it('never reverts everything implicitly', async () => {
    expectFailure(await failure(revert, {}, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'fileSpec' });
  });

  it('limits specs to a changelist when both are given', async () => {
    expect(await invocations(revert, { fileSpec: '//d/a', change: 'default' }, () => ({}), MUTATE))
      .toEqual([[...TAG, 'revert', '-c', 'default', '//d/a']]);
  });
});

describe('setPersistentWorkspace', () => {
  it('runs p4 set without the configured connection or isolation', async () => {
    const recorder = recordingExecutor(scriptedExecutor(() => ({})));

    const result = await run(setPersistentWorkspace, { client: 'ws_main' }, recorder.layer, {
      ...MUTATE,
      connection: { port: 'ssl:p4:1666', user: 'u', client: 'other', isolated: true },
    });

    expect(result).toEqual({ client: 'ws_main', messages: [] });
    const [invocation] = recorder.invocations;
    expect(commandArgs(invocation!.args)).toEqual(['set', 'P4CLIENT=ws_main']);
    expect(invocation!.args).not.toContain('-c');
    expect(invocation!.args).not.toContain('-p');
    expect(invocation!.env.P4ENVIRO).toBeUndefined();
  });

  it.each(['', ' ws', 'a b', 'ws=x', '-ws', 'ws...', 'a@b'])('rejects %j as a workspace name', async (client) => {
    expectFailure(await failure(setPersistentWorkspace, { client }, scriptedExecutor(() => ({})), MUTATE), P4InvalidArgumentError, { option: 'client' });
  });
});

describe('describeChangelists', () => {
  it('describes past a changelist that does not exist, which describe stops at', async () => {
    const [many] = fixtures('describe-many');
    const [moved] = fixtures('describe-move');

    const movedRow = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ change: Schema.String })))(
      moved!.stdout!.split('\n')[0]!,
    );

    const responses = new Map([
      [JSON.stringify([...TAG, 'describe', '-s', '6', '999999', movedRow.change]), fixtureStdout(many!)],
      [JSON.stringify([...TAG, 'describe', '-s', movedRow.change]), fixtureStdout(moved!)],
    ]);

    const recorder = recordingExecutor(scriptedExecutor((invocation) => {
      const stdout = responses.get(JSON.stringify(commandArgs(invocation.args)));

      if (stdout === undefined) throw new Error(`Unexpected ${commandArgs(invocation.args).join(' ')}`);

      return { stdout };
    }));

    const result = await run(describeChangelists, { changes: [6, 999999, Number(movedRow.change)] }, recorder.layer);
    expect(result.items.map((item) => item.change)).toEqual([6, Number(movedRow.change)]);
    expect(result.failures).toMatchObject([{ spec: '999999', reason: 'unknown_changelist' }]);
    expect(recorder.invocations).toHaveLength(2);
  });

  it('runs nothing for no changes and rejects invalid ones', async () => {
    expect(await run(describeChangelists, { changes: [] }, scriptedExecutor(() => {
      throw new Error('p4 must not run');
    }))).toEqual({ items: [], failures: [], messages: [] });
    expectFailure(await failure(describeChangelists, { changes: [1, -2] }, scriptedExecutor(() => ({}))), P4InvalidArgumentError, { option: 'changes' });
  });

  it('reports each changelist and progress in changes', async () => {
    const events = await watch(describeChangelists, { changes: [6] }, scriptedExecutor(() => ({
      stdout: `${fixtures('describe-many')[0]!.stdout!.split('\n')[0]!}\n`,
    })));

    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
    expect(events[1]).toMatchObject({ progress: { completed: 1, total: 1, unit: 'changes' } });
  });
});

describe('server-scoped reads', () => {
  it('lists a whole range without -l or -m', async () => {
    const [fixture] = fixtures('changes-range-short');
    const spec = fixture!.args.at(-1)!;

    const result = await run(listChangelists, {
      status: 'submitted', fileSpec: spec, limit: 'all', fullDescriptions: false,
    }, replay('changes-range-short'));

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((item) => item.change)).toEqual([10, 9, 8]);
    expect(result.items[1]?.description).toBe('Wire move fixture');
    expect(await invocations(listChangelists, { status: 'submitted', fileSpec: '//d/...', limit: 'all' }))
      .toEqual([[...TAG, 'changes', '-s', 'submitted', '-l', '//d/...']]);
  });

  it('stats a server-side inventory with -Os', async () => {
    const result = await run(statFiles, {
      fileSpec: '//p4ts/main/wire/...',
      atChange: 9,
      includeFileSize: true,
      excludeWorkspaceData: true,
      fields: ['headRev', 'headChange', 'headAction', 'headType', 'digest', 'fileSize'],
    }, replay('fstat-server-only'));

    expect(result.items[0]).toMatchObject({
      depotFile: '//p4ts/main/wire/clobber.txt',
      headRevision: 2,
      headChange: 8,
      headType: 'text',
      digest: 'F9C2B572C9797A49E6F89D921ACC95CA',
      fileSize: 13,
      localFile: null,
    });
    expect(result.items.find((item) => item.depotFile === '//p4ts/main/wire/deleted.txt')).toMatchObject({
      headAction: 'delete', isDeletedAtHead: true, digest: null, fileSize: null,
    });
  });

  it('reads the server ID', async () => {
    expect((await run(getEnvironment, {}, replay('info-server-id'))).serverId).toBe('wire-fixture');
  });
});
