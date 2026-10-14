import { describe, expect, it } from 'bun:test';
import { Effect, Exit, Layer, Stream } from 'effect';
import { configLayer } from '../../../src/engine/config.js';
import { runCommand, runPlainCommand, streamCommand } from '../../../src/engine/command.js';
import {
  P4CommandError,
  P4ParseError,
  P4ReadOnlyError,
  P4TimeoutError,
} from '../../../src/errors.js';
import { P4Executor } from '../../../src/exec/executor.js';
import { recordingExecutor, replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { corpus } from '../../support/corpus.js';
import type { P4ClientOptions } from '../../../src/engine/config.js';
import type { P4Error } from '../../../src/errors.js';
import type { P4CommandEvent, P4CommandSpec } from '../../../src/engine/command.js';
import type { P4ScriptedOutput } from '../../../src/testing/executor.js';

const fixtures = (...names: string[]) => names.map((name) => {
  const fixture = corpus.get(name);
  if (fixture === undefined) throw new Error(`Missing fixture ${name}`);
  return fixture;
});

const provide = <A, E>(
  effect: Effect.Effect<A, E, P4Executor | import('../../../src/engine/config.js').P4Config>,
  executor: Layer.Layer<P4Executor>,
  options: P4ClientOptions = {},
) => effect.pipe(Effect.provide(Layer.merge(executor, configLayer(options))));

const run = <A, E>(
  effect: Effect.Effect<A, E, P4Executor | import('../../../src/engine/config.js').P4Config>,
  executor: Layer.Layer<P4Executor>,
  options: P4ClientOptions = {},
) => Effect.runPromise(provide(effect, executor, options));

const failure = async <A>(
  effect: Effect.Effect<A, P4Error, P4Executor | import('../../../src/engine/config.js').P4Config>,
  executor: Layer.Layer<P4Executor>,
  options: P4ClientOptions = {},
): Promise<P4Error> => {
  const exit = await Effect.runPromiseExit(provide(effect, executor, options));
  if (Exit.isSuccess(exit)) throw new Error('Expected the command to fail.');
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== 'Fail') throw new Error(`Expected a failure, got ${String(reason?._tag)}.`);
  return reason.error;
};

const fields = (args: string[]): P4CommandSpec<Readonly<Record<string, unknown>>> => ({
  args,
  format: 'json',
  decode: (row) => row,
});

describe('structured commands', () => {
  it('separates data rows from messages', async () => {
    const output = await run(
      runCommand(fields(['files', '//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'])),
      replayExecutor(fixtures('files-mixed')),
    );
    expect(output.items.map((row) => row.depotFile)).toEqual(['//p4ts/main/wire/text.txt']);
    expect(output.messages.map((message) => message.reason)).toEqual(['no_such_file']);
    expect(output.messages[0]?.args).toEqual({ argc: '//p4ts/main/missing.txt' });
    expect(output.failures).toEqual([]);
  });

  it('fails on a session failure, carrying the reason and every message', async () => {
    const error = await failure(runCommand(fields(['changes', '-m', '1'])), replayExecutor(fixtures('changes-ticket-expired')));
    expect(error).toBeInstanceOf(P4CommandError);
    if (!(error instanceof P4CommandError)) return;
    expect(error.reason).toBe('ticket_expired');
    expect(error.category).toBe('authentication');
    expect(error.exitCode).toBe(1);
    expect(error.messages.map((message) => message.reason)).toEqual(['ticket_expired']);
    expect(error.message).toContain('Your session has expired');
  });

  it('fails on a missing named object even when p4 exits zero', async () => {
    const error = await failure(runCommand(fields(['describe', '-s', '999999'])), replayExecutor(fixtures('describe-unknown')));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'unknown_changelist', exitCode: 0 });
  });

  it('reports a policy-designated per-item failure beside the data', async () => {
    const output = await run(
      runCommand({ ...fields(['where', '//p4ts/main/wire/text.txt', '//other/main/a.txt']), policy: { not_in_view: 'item' } }),
      replayExecutor(fixtures('where-mixed')),
    );
    expect(output.items.map((row) => row.depotFile)).toEqual(['//p4ts/main/wire/text.txt']);
    expect(output.failures.map((message) => [message.reason, message.args.path])).toEqual([
      ['not_in_view', '//other/main/a.txt'],
    ]);
  });

  it('records what the policy did with each message', async () => {
    const asItem = await run(
      runCommand({ ...fields(['where', '//p4ts/main/wire/text.txt', '//other/main/a.txt']), policy: { not_in_view: 'item' } }),
      replayExecutor(fixtures('where-mixed')),
    );
    expect(asItem.failures.map((message) => message.disposition)).toEqual(['item']);
    const empty = await run(
      runCommand(fields(['files', '//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'])),
      replayExecutor(fixtures('files-mixed')),
    );
    expect(empty.messages.map((message) => message.disposition)).toEqual(['empty']);
    const error = await failure(runCommand(fields(['changes', '-m', '1'])), replayExecutor(fixtures('changes-ticket-expired')));
    expect(error instanceof P4CommandError ? error.messages.map((message) => message.disposition) : null).toEqual(['fail']);
  });

  it('classifies plain-text failures printed before reaching a server', async () => {
    const error = await failure(runCommand(fields(['info'])), replayExecutor(fixtures('server-unreachable')));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'server_unreachable', category: 'connection' });
  });

  it('fails a non-zero exit that no message explains', async () => {
    const error = await failure(runCommand(fields(['info'])), scriptedExecutor(() => ({ exitCode: 2, stderr: '' })));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'unknown', exitCode: 2 });
  });

  it('reads output split at any byte the same way', async () => {
    const args = ['files', '//p4ts/main/wire/text.txt', '//p4ts/main/missing.txt'];
    const whole = await run(runCommand(fields(args)), replayExecutor(fixtures('files-mixed')));
    for (const chunkSize of [1, 5, 13]) {
      expect(await run(runCommand(fields(args)), replayExecutor(fixtures('files-mixed'), { chunkSize }))).toEqual(whole);
    }
  });

  it('streams the same data, messages and failures it collects', async () => {
    const spec = { ...fields(['sync', '//p4ts/main/wire/clobber.txt']), policy: { clobber: 'item' as const } };
    const executor = replayExecutor(fixtures('sync-clobber'));
    const options = { allowMutation: true };
    const events = await run(Stream.runCollect(streamCommand(spec)), executor, options);
    const output = await run(runCommand(spec), executor, options);
    expect(events.flatMap((event) => event._tag === 'data' ? [event.value] : [])).toEqual(output.items);
    expect(events.flatMap((event) => event._tag === 'failure' ? [event.message] : [])).toEqual(output.failures);
    expect(output.failures.map((message) => message.reason)).toEqual(['clobber']);
  });

  it('decodes marshal output, keeping content as bytes', async () => {
    const output = await run(
      runCommand({
        args: ['print', '-k'],
        globalArgs: ['-x', '-'],
        input: '//p4ts/main/wire/text.txt\n//p4ts/main/wire/full.uasset\n//p4ts/main/missing.txt\n//p4ts/main/wire/wide.txt\n',
        format: 'marshal',
        policy: { no_such_file: 'item' },
        decode: (row) => row,
      }),
      replayExecutor(fixtures('print-marshal-batch'), { chunkSize: 9 }),
    );
    expect(output.items.filter((row) => row.code === 'stat').map((row) => row.depotFile)).toEqual([
      '//p4ts/main/wire/text.txt', '//p4ts/main/wire/full.uasset', '//p4ts/main/wire/wide.txt',
    ]);
    expect(output.items.find((row) => row.code === 'binary')?.data).toBeInstanceOf(Uint8Array);
    expect(output.failures.map((message) => message.reason)).toEqual(['no_such_file']);
  });

  it('reports malformed output with the command that produced it', async () => {
    const error = await failure(runCommand(fields(['files', '//d/...'])), scriptedExecutor(() => ({
      stdout: '{"depotFile":"//d/a.txt"}\nnot json\n',
      exitCode: 0,
    })), { connection: { port: 'ssl:p4:1666' } });
    expect(error).toBeInstanceOf(P4ParseError);
    expect(error).toMatchObject({ line: 'not json', command: 'p4' });
    if (error instanceof P4ParseError) expect(error.args).toContain('files');
  });

  it('reports a decoder rejection with command context', async () => {
    const error = await failure(runCommand({
      args: ['files', '//d/...'],
      format: 'json',
      decode: (row) => {
        throw new P4ParseError({ message: 'bad row', line: JSON.stringify(row), detail: 'nope', command: null, args: null });
      },
    }), scriptedExecutor(() => ({ stdout: '{"depotFile":"//d/a.txt"}\n' })));
    expect(error).toMatchObject({ _tag: 'P4ParseError', message: 'bad row', command: 'p4' });
  });
});

describe('output cut short', () => {
  const marshal = (): P4CommandSpec<Readonly<Record<string, unknown>>> => ({
    args: ['print', '-k'],
    format: 'marshal',
    policy: { no_such_file: 'item' },
    decode: (row) => row,
  });
  const batch = fixtureStdout(fixtures('print-marshal-batch')[0]!);
  const cutJson = '{"depotFile":"//d/a.txt"}\n{"depotFile":"//d/b';
  const cutStderr = '{"data":"//d/a.txt - file(s) up-to-date.\\n","severity":2,"generic":17}\n{"data":"//d/b';

  /** Events streamed before the command failed, and its error. */
  const streamed = async (spec: P4CommandSpec<Readonly<Record<string, unknown>>>, output: P4ScriptedOutput, chunkSize?: number) => {
    const events: Array<P4CommandEvent<Readonly<Record<string, unknown>>>> = [];
    const error = await failure(
      Stream.runForEach(streamCommand(spec), (event) => Effect.sync(() => {
        events.push(event);
      })),
      scriptedExecutor(() => output, { chunkSize }),
    );
    return { events, error };
  };

  const expectSignal = (error: P4Error) => {
    expect(error).toBeInstanceOf(P4CommandError);
    expect(error).toMatchObject({ exitCode: -1, reason: 'unknown' });
    expect(error.message).toContain('(exit signal)');
  };

  it('reports a signal, not the JSON record it cut short, keeping earlier records', async () => {
    for (const chunkSize of [undefined, 1, 7]) {
      const { events, error } = await streamed(fields(['files', '//d/...']), { stdout: cutJson, exitCode: null }, chunkSize);
      expect(events).toEqual([{ _tag: 'data', value: { depotFile: '//d/a.txt' } }]);
      expectSignal(error);
      expect(error.message).toContain('p4 was terminated by a signal.');
    }
  });

  it('reports a signal, not the marshal record it cut short, keeping earlier records', async () => {
    for (const chunkSize of [undefined, 9]) {
      const { events, error } = await streamed(marshal(), { stdout: batch.subarray(0, batch.length - 3), exitCode: null }, chunkSize);
      expect(events.some((event) => event._tag === 'data' && event.value.depotFile === '//p4ts/main/wire/text.txt')).toBe(true);
      expectSignal(error);
      expect(error.message).toContain('p4 was terminated by a signal.');
    }
  });

  it('reports a signal, not the stderr diagnostic it cut short', async () => {
    const { error } = await streamed(fields(['files', '//d/...']), { stderr: cutStderr, exitCode: null });
    expectSignal(error);
    if (error instanceof P4CommandError) expect(error.stderr).toBe(cutStderr);
  });

  it('still reports a malformed final record after a normal exit', async () => {
    for (const exitCode of [0, 1]) {
      const json = await failure(runCommand(fields(['files', '//d/...'])), scriptedExecutor(() => ({ stdout: cutJson, exitCode })));
      expect(json).toBeInstanceOf(P4ParseError);
      expect(json).toMatchObject({ message: 'Unable to parse tagged Perforce JSON output.', line: '{"depotFile":"//d/b', command: 'p4' });
      const marshalled = await failure(
        runCommand(marshal()),
        scriptedExecutor(() => ({ stdout: batch.subarray(0, batch.length - 3), exitCode }), { chunkSize: 9 }),
      );
      expect(marshalled).toBeInstanceOf(P4ParseError);
      expect(marshalled).toMatchObject({ detail: 'Marshal output ended inside a record.', command: 'p4' });
      const stderr = await failure(runCommand(fields(['files', '//d/...'])), scriptedExecutor(() => ({ stderr: cutStderr, exitCode })));
      expect(stderr).toBeInstanceOf(P4ParseError);
      expect(stderr).toMatchObject({ message: 'Unable to parse Perforce diagnostics.', line: '{"data":"//d/b' });
    }
  });
});

describe('command invocation', () => {
  it('passes the connection as global options and isolates P4CONFIG and P4ENVIRO', async () => {
    const recorder = recordingExecutor(scriptedExecutor(() => ({ stdout: '' })));
    await run(runCommand(fields(['info'])), recorder.layer, {
      executable: 'C:/p4/p4.exe',
      connection: { port: 'ssl:p4:1666', user: 'arif', client: 'ws', charset: 'utf8', isolated: true },
      cwd: 'C:/ws',
      env: { P4CLIENT: undefined, P4CONFIG: '.p4config', P4ENVIRO: 'inherited.enviro' },
    });
    const [invocation] = recorder.invocations;
    expect(invocation?.executable).toBe('C:/p4/p4.exe');
    expect(invocation?.args).toEqual([
      '-p', 'ssl:p4:1666', '-u', 'arif', '-c', 'ws', '-C', 'utf8',
      '-zprog=p4client-ts', '-zversion=0.13.0', '-Mj', '-z', 'tag', 'info',
    ]);
    expect(invocation?.cwd).toBe('C:/ws');
    expect(invocation?.env).toEqual({ P4CLIENT: undefined, P4CONFIG: 'p4client-ts.isolated-no-config', P4ENVIRO: 'p4client-ts.isolated-no-enviro' });
  });

  it('refuses a mutating command without running it unless mutation is allowed', async () => {
    const recorder = recordingExecutor(scriptedExecutor(() => ({ stdout: '' })));
    const error = await failure(runCommand(fields(['sync', '//d/...'])), recorder.layer);
    expect(error).toBeInstanceOf(P4ReadOnlyError);
    expect(recorder.invocations).toEqual([]);
    await run(runCommand(fields(['sync', '//d/...'])), recorder.layer, { allowMutation: true });
    expect(recorder.invocations.length).toBe(1);
  });

  it('kills a command that exceeds its timeout and keeps its partial output', async () => {
    let interrupted = false;
    const hanging = Layer.succeed(P4Executor, {
      run: () => Stream.concat(
        Stream.make({ _tag: 'stdout' as const, bytes: new TextEncoder().encode('{"depotFile":"//d/a.txt"}\n') }),
        Stream.never,
      ).pipe(Stream.onExit(() => Effect.sync(() => {
        interrupted = true;
      }))),
    });
    const error = await failure(runCommand(fields(['files', '//d/...'])), hanging, { timeoutMs: 50 });
    expect(error).toBeInstanceOf(P4TimeoutError);
    expect(error).toMatchObject({ timeoutMs: 50, stdout: '{"depotFile":"//d/a.txt"}\n' });
    expect(interrupted).toBe(true);
  });
});

describe('plain commands', () => {
  it('returns stdout as bytes', async () => {
    const output = await run(
      runPlainCommand({ args: ['diff2', '-du', '//p4ts/main/wire/text.txt#1', '//p4ts/main/wire/text.txt#2'] }),
      replayExecutor(fixtures('diff2-normal')),
    );
    expect(new TextDecoder().decode(output.stdout)).toContain('@@');
    expect(output.exitCode).toBe(0);
  });

  it('classifies plain stderr diagnostics', async () => {
    const error = await failure(
      runPlainCommand({ args: ['diff2', '-du', '//p4ts/main/wire/text.txt#invalid', '//p4ts/main/wire/text.txt#1'] }),
      replayExecutor(fixtures('diff2-bad-revision-plain')),
    );
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'invalid_revision', category: 'usage' });
  });

  it('accepts an exit code the spec explains', async () => {
    const output = await run(
      runPlainCommand({ args: ['diff2', 'a', 'b'], acceptExit: (code) => code === 1 }),
      scriptedExecutor(() => ({ stdout: '@@ -1 +1 @@\n', exitCode: 1 })),
    );
    expect(output.exitCode).toBe(1);
  });
});
