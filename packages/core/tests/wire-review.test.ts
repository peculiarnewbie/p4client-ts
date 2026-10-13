import { describe, expect, it } from 'bun:test';
import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchCommand } from '../src/internal/command.js';
import { P4Client } from '../src/public/client.js';
import {
  P4CommandError,
  P4ParseError,
  isP4ConnectionError,
} from '../src/public/errors.js';
import { parseP4JsonLines } from '../src/public/helpers.js';
import type {
  P4CommandResult,
  P4CommandStreamEvent,
} from '../src/public/types.js';

const Capture = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
});
const load = (name: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Capture))(
    readFileSync(
      join(import.meta.dir, 'fixtures/wire', `${name}.json`),
      'utf8',
    ),
  );
function replay(name: string, errorsOnStderr = false): P4Client {
  const capture = { ...load(name) };
  if (errorsOnStderr) {
    const lines = capture.stdout.split('\n').filter(Boolean);
    capture.stderr = lines
      .filter((line) => line.includes('"severity"'))
      .join('\n');
    capture.stdout = lines
      .filter((line) => !line.includes('"severity"'))
      .join('\n');
  }
  const result = (command: string, args: string[]): P4CommandResult => ({
    command,
    args,
    ...capture,
  });
  return new P4Client({
    executor: (command, args) =>
      Effect.runPromise(Effect.succeed(result(command, args))),
    streamExecutor: (command, args) => ({
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<P4CommandStreamEvent> {
          yield { type: 'start', command, args };
          for (const source of ['stdout', 'stderr'] as const) {
            for (const line of capture[source].split('\n').filter(Boolean)) {
              yield { type: 'line', source, line };
            }
          }
          yield { type: 'exit', exitCode: capture.exitCode };
        },
      },
      result: Effect.runPromise(Effect.succeed(result(command, args))),
    }),
  });
}

describe('wire review regressions', () => {
  it('keeps filesystem permission errors per-file while server protection errors remain fatal', async () => {
    const client = replay('synthetic-review-sync-permission');
    expect((await client.sync()).errors).toHaveLength(2);
    const operation = client.watchSync();
    const errors = [];
    for await (const event of operation.events) {
      if (event.type === 'error-row') errors.push(event.error);
    }
    expect(errors).toHaveLength(2);
    expect((await operation.result).totalCount).toBe(1);
    await expect(replay('print-permission').sync()).rejects.toMatchObject({
      category: 'permission',
    });
  });
  it('retains tagged per-file errors on stderr and emits watched error rows', async () => {
    const client = replay('synthetic-review-sync-rename', true);
    expect((await client.sync()).errors).toHaveLength(1);
    const operation = client.watchSync();
    const events = [];
    for await (const event of operation.events) events.push(event);
    expect(events.filter((event) => event.type === 'error-row')).toHaveLength(
      1,
    );
    expect((await operation.result).errors).toHaveLength(1);
  });
  it('preserves successful sync files and a Windows rename error in buffered and watched results', async () => {
    const client = replay('synthetic-review-sync-rename');
    const buffered = await client.sync();
    expect(buffered.totalCount).toBe(2);
    expect(buffered.errors).toHaveLength(1);
    expect(buffered.errors?.[0]?.message).toContain('Access is denied');
    const watched = client.watchSync();
    const events = [];
    for await (const event of watched.events) events.push(event);
    expect(events.filter((event) => event.type === 'error-row')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'message')).toHaveLength(0);
    expect(await watched.result).toMatchObject({
      items: buffered.items,
      errors: buffered.errors,
      totalCount: 2,
    });
  });
  it('retains a valid stat beside a warning about another nonexistent revision', async () => {
    const result = await replay('fstat-mixed-revision').statFiles({
      fileSpec: [
        '//p4ts/main/src/app/config.json#999999',
        '//p4ts/main/docs/guide/getting-started.md',
      ],
    });
    expect(result).toHaveLength(1);
    expect(String(result[0]?.depotFile)).toContain('getting-started.md');
    expect(result.messages?.[0]).toMatchObject({
      kind: 'warning',
      reason: 'unknown_revision',
    });
  });
  for (const name of [
    'files-empty',
    'files-unsynced-have',
    'files-missing-revision',
  ]) {
    it(`reports unavailable print metadata from ${name} as a command error`, async () => {
      await expect(
        replay(name).printFile('//depot/main/a.txt'),
      ).rejects.toBeInstanceOf(P4CommandError);
    });
  }
  it('rejects a disappeared print payload but accepts an actual empty text file', async () => {
    const meta = load('modes-json-files');
    const missing = load('print-empty-plain');
    const make = (payload: typeof missing) =>
      new P4Client({
        executor: (command, args) =>
          Effect.runPromise(
            Effect.succeed({
              command,
              args,
              ...(args.includes('files') ? meta : payload),
            }),
          ),
      });
    await expect(
      make(missing).printFile('//depot/main/a.txt'),
    ).rejects.toBeInstanceOf(P4CommandError);
    expect(
      (
        await make({ stdout: '', stderr: '', exitCode: 0 }).printFile(
          '//depot/main/a.txt',
        )
      ).content,
    ).toBe('');
  });
  it('classifies only diagnostics, excluding descriptions, command text and plain print content', async () => {
    try {
      await replay('synthetic-review-error-data').listSubmittedChangelists();
      throw new Error('Expected a diagnostic failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(P4CommandError);
      if (error instanceof P4CommandError) {
        expect(error.category).toBe('revision');
        expect(error.reason).toBe('unknown_revision');
        expect(isP4ConnectionError(error)).toBe(false);
        expect(error.result.stdout).toContain('not logged in');
      }
    }
    const error = new P4CommandError('p4 -c "not logged in" print failed', {
      command: 'p4',
      args: ['print', '-q', '//depot/main/a.txt'],
      stdout: 'not logged in\nconnection refused\n',
      stderr: 'An unrecognized failure.',
      exitCode: 1,
    });
    expect(error.category).toBe('command');
    expect(isP4ConnectionError(error)).toBe(false);
  });
  it('retains harmless stderr notices without failing a zero-exit diff', async () => {
    const result = await replay('synthetic-review-plain-warnings').diffFile({
      depotFile: '//depot/main/a.txt',
    });
    expect(result.messages?.map((message) => message.reason)).toEqual([
      'resolve_required',
      'opened_unchanged',
      'command',
    ]);
  });
  it('keeps reconcile progress out of diagnostics while retaining an actual stderr warning', async () => {
    const operation = replay(
      'synthetic-review-reconcile-progress',
    ).watchPreviewReconcile();
    const progress: string[] = [];
    for await (const event of operation.events) {
      if (event.type === 'progress') progress.push(event.rawLine);
    }
    const result = await operation.result;
    expect(result.edited).toHaveLength(1);
    expect(progress).toEqual([
      'Scanning workspace: 1/4 (25%)',
      'Hashing files: 4/4 (100%)',
    ]);
    expect(result.messages?.map((message) => message.reason)).toEqual([
      'empty',
    ]);
  });
  it('does not add diagnostic wire rows to serialized object or array results', async () => {
    const object = await replay('sync-up-to-date').previewSync();
    expect(object.messages).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(object))).toEqual({
      items: [],
      totalCount: 0,
    });
    expect(Object.keys(object)).not.toContain('messages');
    const array = await replay('fstat-mixed-revision').statFiles({
      fileSpec: '//depot/main/...',
    });
    expect(array.messages).toHaveLength(1);
    expect(Object.keys(array)).not.toContain('messages');
    expect(JSON.stringify(array)).not.toContain('severityformat');
  });
  it('retains the same parsed wire objects for watched messages and the final result', async () => {
    const operation = replay('sync-opened-new-head-preview').watchSync();
    const raw: Record<string, unknown>[] = [];
    for await (const event of operation.events) {
      if (event.type === 'message') raw.push(event.message.raw);
    }
    expect(raw).toHaveLength(2);
    const result = await operation.result;
    expect(result.messages?.[0]?.raw).toBe(raw[0]);
    expect(result.messages?.[1]?.raw).toBe(raw[1]);
  });
  for (const name of [
    'changes-not-logged-in',
    'changes-ticket-expired',
    'unicode-charset-required',
  ]) {
    for (const source of ['stdout', 'stderr'] as const) {
      it(`keeps ${name} fatal as a warning on ${source}`, async () => {
        const row = parseP4JsonLines(load(name).stdout)[0];
        const text = JSON.stringify({ ...row, severity: 2 });
        const client = new P4Client({
          executor: (command, args) =>
            Effect.runPromise(
              Effect.succeed({
                command,
                args,
                stdout: source === 'stdout' ? text : '',
                stderr: source === 'stderr' ? text : '',
                exitCode: 0,
              }),
            ),
        });
        await expect(client.runTaggedJson(['info'])).rejects.toBeInstanceOf(
          P4CommandError,
        );
      });
    }
  }
  it('records the actual executed describe command when metadata is absent', async () => {
    const actual = [
      '-p',
      'localhost:19999',
      '-u',
      'user1',
      '-c',
      'client1',
      '-Mj',
      '-z',
      'tag',
      'describe',
      '-S',
      '-s',
      '100',
    ];
    const client = new P4Client({
      executable: 'fixture-p4',
      executor: (command) =>
        Effect.runPromise(
          Effect.succeed({
            command,
            args: actual,
            stdout: '',
            stderr: '',
            exitCode: 0,
          }),
        ),
    });
    await expect(
      client.describeChangelist(100, { shelved: true }),
    ).rejects.toMatchObject({ command: 'fixture-p4', args: actual });
  });
  it('uses opened command context for a malformed default changelist and accepts an empty default', async () => {
    const malformed = new P4Client({
      client: 'client1',
      executor: (command, args) =>
        Effect.runPromise(
          Effect.succeed({
            command,
            args,
            stdout:
              '{"depotFile":"//depot/main/a.txt","action":"edit","change":"invalid"}',
            stderr: '',
            exitCode: 0,
          }),
        ),
    });
    await expect(malformed.describeChangelist('default')).rejects.toMatchObject(
      {
        args: ['-c', 'client1', '-Mj', '-z', 'tag', 'opened', '-c', 'default'],
      },
    );
    expect(
      (await replay('opened-empty').describeChangelist('default')).files,
    ).toEqual([]);
  });
  it('joins a real child before surfacing unexpected plain sync output', async () => {
    let pid: number | undefined;
    const caller = new AbortController();
    const client = new P4Client({
      streamExecutor: (_command, _args, options) =>
        watchCommand(
          process.execPath,
          [
            '-e',
            "console.log(JSON.stringify({depotFile:'//depot/main/a.txt',action:'updated',fileSize:process.pid})); console.log('unexpected plain output'); setInterval(() => {}, 1000);",
          ],
          options,
        ),
    });
    const operation = client.watchSync({ signal: caller.signal });
    try {
      await expect(
        (async () => {
          for await (const event of operation.events) {
            if (event.type === 'progress')
              pid = event.item.fileSize ?? undefined;
          }
        })(),
      ).rejects.toBeInstanceOf(P4ParseError);
      await expect(operation.result).rejects.toBeInstanceOf(P4ParseError);
      expect(pid).toBeGreaterThan(0);
      const childPid = pid;
      if (childPid !== undefined)
        expect(() => process.kill(childPid, 0)).toThrow();
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort();
      await operation.result.catch(() => undefined);
    }
  });
  it('keeps executed global options on a plain sync parse error', async () => {
    let actual: string[] = [];
    const client = new P4Client({
      client: 'client1',
      streamExecutor: (command, args) => {
        actual = ['-p', 'localhost:19999', '-u', 'user1', ...args];
        return {
          events: {
            async *[Symbol.asyncIterator](): AsyncGenerator<P4CommandStreamEvent> {
              yield { type: 'start', command, args: actual };
              yield {
                type: 'line',
                source: 'stdout',
                line: 'unexpected plain output',
              };
            },
          },
          result: Effect.runPromise(
            Effect.succeed({
              command,
              args: actual,
              stdout: 'unexpected plain output',
              stderr: '',
              exitCode: 0,
            }),
          ),
        };
      },
    });
    const operation = client.watchSync();
    await expect(operation.result).rejects.toMatchObject({
      command: 'p4',
      args: actual,
    });
  });
});
