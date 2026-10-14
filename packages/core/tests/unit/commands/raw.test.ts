import { describe, expect, it } from 'bun:test';
import { Layer, Schema, Stream } from 'effect';
import { runTagged } from '../../../src/commands/raw.js';
import { P4Executor } from '../../../src/exec/executor.js';
import { commandArgs, scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtures, replay, run, watch } from './support.js';

const TAG = ['-Mj', '-z', 'tag'];

const InfoRow = Schema.Struct({ userName: Schema.String, clientName: Schema.String, serverVersion: Schema.String });

describe('runTagged: argv', () => {
  argvTable([
    argvCase('runs the arguments with tagged JSON output', runTagged, { args: ['changes', '-m', '1'] }, [
      [...TAG, 'changes', '-m', '1'],
    ]),
    argvCase('refuses a mutating command on a read-only client before running p4', runTagged, { args: ['edit', '//d/a.txt'] }, []),
  ]);
});

describe('runTagged', () => {
  it('returns records as received without a schema', async () => {
    const result = await run(runTagged, { args: ['info'] }, replay('info-json'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ clientName: 'p4ts_e2e_client', caseHandling: 'insensitive' });
    expect(result).toMatchObject({ messages: [], failures: [] });
  });

  it('decodes each record with a schema, keeping its other fields', async () => {
    const result = await run(runTagged, { args: ['info'], schema: InfoRow }, replay('info-json'));
    expect(result.items[0]).toMatchObject({
      userName: 'p4ts-e2e',
      clientName: 'p4ts_e2e_client',
      serverVersion: 'P4D/NTX64/2026.1/3089746 (2026/10/07)',
    });
  });

  it('fails with P4ParseError, naming the command, for a record the schema rejects', async () => {
    const schema = Schema.Struct({ userName: Schema.Number });
    const error = await failure(runTagged, { args: ['info'], schema }, replay('info-json'));
    expect(error).toMatchObject({ _tag: 'P4ParseError', command: 'p4' });
    expect(error._tag === 'P4ParseError' ? error.args : null).toContain('info');
  });

  it('runs previews of mutating commands on a read-only client', async () => {
    const result = await run(runTagged, { args: ['resolve', '-n', '//p4ts/main/wire/text.txt'] }, replay('resolve-preview'));
    expect(result.items).toEqual([{
      clientFile: '<WORKSPACE>\\wire\\text.txt',
      contentResolveType: '3waytext',
      endFromRev: '2',
      fromFile: '//p4ts/main/wire/text.txt',
      resolveFlag: 'c',
      resolveType: 'content',
      startFromRev: '1',
    }]);
  });

  it('returns nothing for a command that prints nothing', async () => {
    const result = await run(runTagged, { args: ['property', '-l', '-n', 'fixture.setting'] }, replay('property-empty'));
    expect(result).toEqual({ items: [], messages: [], failures: [] });
  });

  it('fails with the usage reason for an invalid option', async () => {
    const error = await failure(runTagged, { args: ['status', '-n', '//p4ts/main/wire/text.txt'] }, replay('status-preview'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'usage', exitCode: 1 });
  });

  it('refuses a mutating command unless the client allows mutation', async () => {
    const args = ['edit', '//p4ts/main/wire/exclusive.uasset'];
    const error = await failure(runTagged, { args }, replay('exclusive-edit-failure'));
    expect(error._tag).toBe('P4ReadOnlyError');
    const result = await run(runTagged, { args }, replay('exclusive-edit-failure'), { allowMutation: true });
    expect(result.items).toEqual([]);
    expect(result.messages.map((message) => message.reason)).toEqual(['exclusive_open', 'locked']);
  });

  it('applies the policy to the shared classification', async () => {
    const args = ['edit', '//p4ts/main/wire/exclusive.uasset'];
    const result = await run(runTagged, { args, policy: { exclusive_open: 'item' } }, replay('exclusive-edit-failure'), {
      allowMutation: true,
    });
    expect(result.failures.map((message) => message.reason)).toEqual(['exclusive_open']);
    expect(result.messages.map((message) => message.reason)).toEqual(['locked']);
    await expect(failure(runTagged, { args, policy: { exclusive_open: 'fail' } }, replay('exclusive-edit-failure'), {
      allowMutation: true,
    })).resolves.toMatchObject({ _tag: 'P4CommandError', reason: 'exclusive_open' });
  });

  it('fails when the server cannot be reached', async () => {
    const error = await failure(runTagged, { args: ['info'] }, replay('server-unreachable'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'server_unreachable' });
  });

  it('times out a command that does not finish', async () => {
    const [timeout] = fixtures('command-timeout');
    const hanging = Layer.succeed(P4Executor, {
      run: (invocation) => {
        expect(commandArgs(invocation.args)).toEqual(commandArgs(timeout!.args));
        return Stream.never;
      },
    });
    const error = await failure(runTagged, { args: ['info'] }, hanging, { timeoutMs: 20 });
    expect(error).toMatchObject({ _tag: 'P4TimeoutError', timeoutMs: 20 });
  });

  it('streams each record and counts records', async () => {
    const events = await watch(runTagged, { args: ['info'] }, replay('info-json'));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
    const progress = events[1];
    expect(progress?._tag === 'progress' ? progress.progress : null).toMatchObject({ completed: 1, total: null, unit: 'records' });
  });

  it('rejects empty arguments', async () => {
    const error = await failure(runTagged, { args: [] }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'args' });
  });
});
