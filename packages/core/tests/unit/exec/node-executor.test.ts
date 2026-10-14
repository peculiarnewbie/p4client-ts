import { describe, expect, it } from 'bun:test';
import { Effect, Exit, Stream } from 'effect';
import { P4SpawnError } from '../../../src/errors.js';
import { runNodeProcess } from '../../../src/node/executor.js';
import type { P4Invocation, P4ProcessEvent } from '../../../src/exec/executor.js';

const node = (script: string, extra: Partial<P4Invocation> = {}): P4Invocation => ({
  executable: process.execPath,
  args: ['-e', script],
  cwd: undefined,
  env: {},
  input: undefined,
  ...extra,
});

const collect = (invocation: P4Invocation) =>
  Effect.runPromise(Stream.runCollect(runNodeProcess(invocation)));

const text = (events: readonly P4ProcessEvent[], tag: 'stdout' | 'stderr') =>
  Buffer.concat(events.flatMap((event) => event._tag === tag ? [event.bytes] : [])).toString('utf8');

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('NodeP4Executor', () => {
  it('streams both pipes and ends with exactly one exit event', async () => {
    const events = await collect(node("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"));
    expect(text(events, 'stdout')).toBe('out');
    expect(text(events, 'stderr')).toBe('err');
    expect(events.filter((event) => event._tag === 'exit')).toEqual([{ _tag: 'exit', code: 3 }]);
    expect(events.at(-1)).toEqual({ _tag: 'exit', code: 3 });
  });

  it('delivers large output completely', async () => {
    const events = await collect(node("for (let i = 0; i < 50000; i++) process.stdout.write('line ' + i + '\\n')"));
    const lines = text(events, 'stdout').trimEnd().split('\n');
    expect(lines.length).toBe(50_000);
    expect(lines.at(-1)).toBe('line 49999');
  });

  it('writes input to stdin', async () => {
    const events = await collect(node(
      "let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => process.stdout.write(s.toUpperCase()))",
      { input: '//depot/a.txt\n' },
    ));
    expect(text(events, 'stdout')).toBe('//DEPOT/A.TXT\n');
  });

  it('reports the exit of a process that stops before reading its input', async () => {
    const events = await collect(node('process.exit(2)', { input: 'x\n'.repeat(500_000) }));
    expect(events.at(-1)).toEqual({ _tag: 'exit', code: 2 });
  });

  it('applies environment changes and removes variables set to undefined', async () => {
    process.env.P4TS_EXECUTOR_TEST_REMOVE = 'inherited';
    try {
      const events = await collect(node(
        'process.stdout.write(JSON.stringify([process.env.P4TS_ADDED, process.env.P4TS_EXECUTOR_TEST_REMOVE ?? null]))',
        { env: { P4TS_ADDED: 'yes', P4TS_EXECUTOR_TEST_REMOVE: undefined } },
      ));
      expect(text(events, 'stdout')).toBe('["yes",null]');
    } finally {
      delete process.env.P4TS_EXECUTOR_TEST_REMOVE;
    }
  });

  it('fails with a typed spawn error for a missing executable', async () => {
    const exit = await Effect.runPromiseExit(Stream.runCollect(runNodeProcess({
      ...node(''),
      executable: 'p4-ts-nonexistent-executable',
      args: ['-P', 'secret', 'info'],
    })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons[0];
      expect(error?._tag).toBe('Fail');
      if (error?._tag === 'Fail') {
        expect(error.error).toBeInstanceOf(P4SpawnError);
        expect(error.error.code).toBe('ENOENT');
        expect(error.error.args).toEqual(['-P', '***', 'info']);
      }
    }
  });

  it('kills and joins the process when the consumer stops early', async () => {
    const events = await Effect.runPromise(
      runNodeProcess(node("process.stdout.write(String(process.pid) + '\\n'); setInterval(() => process.stdout.write('tick\\n'), 5)"))
        .pipe(Stream.take(1), Stream.runCollect),
    );
    const pid = Number(text(events, 'stdout').split('\n')[0]);
    expect(Number.isInteger(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });

  it('kills and joins the process on interruption', async () => {
    let pid = 0;
    const exit = await Effect.runPromiseExit(
      runNodeProcess(node("process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)")).pipe(
        Stream.runForEach((event) => Effect.sync(() => {
          if (event._tag === 'stdout') pid = Number(Buffer.from(event.bytes).toString('utf8'));
        })),
        Effect.timeout('300 millis'),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });
});
