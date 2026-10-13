import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P4Client } from '../src/public/client.js';
import { P4CommandError, P4ParseError } from '../src/public/errors.js';
import type {
  P4CommandExecutor,
  P4CommandResult,
  P4CommandStreamEvent,
  P4DepotPath,
  P4MessageCarrier,
  P4StreamingCommandExecutor,
  P4SyncProgressEvent
} from '../src/public/types.js';

/**
 * The same Perforce row must be classified the same way by every method that can receive it:
 * data, a per-file error, an informational message, or a fatal failure. Each case below sends
 * one data row followed by the row under test, and every reader must agree on where it lands.
 * docs/wire-validation-report.md mirrors these tables.
 */
type Outcome = 'data' | 'error' | 'message' | 'fatal' | 'parse';

interface Wire {
  /** Stdout lines after the data row; objects are serialized as tagged JSON. */
  readonly stdout?: readonly (Record<string, unknown> | string)[];
  readonly stderr?: string;
  readonly exitCode: number;
}

interface Case extends Wire {
  readonly name: string;
  readonly outcome: Outcome;
}

const CLOBBER = { severity: 3, generic: 34, data: "Can't clobber writable file C:\\work\\b.txt" };
const NOT_IN_VIEW = { severity: 2, generic: 17, data: '//other/b.txt - file(s) not in client view.' };
const OUTSIDE_CLIENT = { severity: 3, generic: 2, data: "//other/... - must refer to client 'ws' or a depot." };
const EXPIRED = { severity: 3, generic: 4, data: 'Your session has expired, please login again.' };
const STDERR_NOTICE = 'Notice: the server restarts tonight.';

function output(dataRow: Record<string, unknown> | null, wire: Wire): { stdout: string[]; stderr: string } {
  const rows = [...(dataRow ? [dataRow] : []), ...(wire.stdout ?? [])];
  return {
    stdout: rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)),
    stderr: wire.stderr ?? ''
  };
}

function bufferedExecutor(dataRow: Record<string, unknown> | null, wire: Wire): P4CommandExecutor {
  return async (command, args) => {
    const { stdout, stderr } = output(dataRow, wire);
    return { command, args, stdout: stdout.join('\n'), stderr, exitCode: wire.exitCode };
  };
}

function streamingExecutor(
  dataRow: Record<string, unknown> | null,
  wire: Wire,
  respond: (args: string[]) => Wire | null = () => null
): P4StreamingCommandExecutor {
  return (command, args) => {
    const { stdout, stderr } = output(dataRow, respond(args) ?? wire);
    const exitCode = (respond(args) ?? wire).exitCode;
    const result: P4CommandResult = { command, args, stdout: stdout.join('\n'), stderr, exitCode };
    const events: P4CommandStreamEvent[] = [
      { type: 'start', command, args },
      ...stdout.map((line) => ({ type: 'line' as const, source: 'stdout' as const, line })),
      ...stderr.split('\n').filter(Boolean).map((line) => ({ type: 'line' as const, source: 'stderr' as const, line })),
      { type: 'exit', exitCode }
    ];
    return {
      events: (async function* () {
        yield* events;
      })(),
      result: Promise.resolve(result)
    };
  };
}

async function settle<T>(promise: Promise<T>, read: (value: T) => Outcome): Promise<Outcome> {
  try {
    return read(await promise);
  } catch (error) {
    if (error instanceof P4ParseError) return 'parse';
    if (error instanceof P4CommandError) return 'fatal';
    throw error;
  }
}

const hasMessages = (value: P4MessageCarrier): Outcome | null => value.messages?.length ? 'message' : null;

describe('row classification across sync readers', () => {
  const dataRow = { depotFile: '//depot/main/a.txt', clientFile: 'C:\\work\\a.txt', rev: '2', action: 'updated' };
  const cases: Case[] = [
    { name: 'writable clobber', stdout: [CLOBBER], exitCode: 1, outcome: 'error' },
    {
      name: 'filesystem failure',
      stdout: [{ severity: 3, generic: 33, data: 'open for write: C:\\work\\b.txt: Access is denied.' }],
      exitCode: 1,
      outcome: 'error'
    },
    { name: 'per-file failure on stderr', stderr: JSON.stringify(CLOBBER), exitCode: 1, outcome: 'error' },
    {
      name: 'opened-file notice',
      stdout: [{ level: 0, data: "//depot/main/b.txt#1 - is opened for add and can't be replaced" }],
      exitCode: 0,
      outcome: 'message'
    },
    {
      name: 'up-to-date warning',
      stdout: [{ severity: 2, generic: 17, data: '//depot/main/c.txt - file(s) up-to-date.' }],
      exitCode: 0,
      outcome: 'message'
    },
    { name: 'plain stderr notice', stderr: STDERR_NOTICE, exitCode: 0, outcome: 'message' },
    { name: 'not in client view', stdout: [NOT_IN_VIEW], exitCode: 0, outcome: 'fatal' },
    { name: 'outside the client', stdout: [OUTSIDE_CLIENT], exitCode: 1, outcome: 'fatal' },
    { name: 'expired ticket', stdout: [EXPIRED], exitCode: 1, outcome: 'fatal' },
    { name: 'unparseable stdout', stdout: ['not json'], exitCode: 0, outcome: 'parse' }
  ];
  const readSync = (result: { errors?: unknown[] } & P4MessageCarrier): Outcome =>
    result.errors?.length ? 'error' : hasMessages(result) ?? 'data';

  for (const testCase of cases) {
    it(`${testCase.name}: previewSync, sync and watchSync agree`, async () => {
      const buffered = new P4Client({ executor: bufferedExecutor(dataRow, testCase) });
      const watched = new P4Client({ streamExecutor: streamingExecutor(dataRow, testCase) });
      const handle = watched.watchSync();
      const events: P4SyncProgressEvent[] = [];
      const watchOutcome = settle((async () => {
        for await (const event of handle.events) events.push(event);
        return handle.result;
      })(), readSync);

      expect({
        previewSync: await settle(buffered.previewSync(), readSync),
        sync: await settle(buffered.sync(), readSync),
        watchSync: await watchOutcome
      }).toEqual({ previewSync: testCase.outcome, sync: testCase.outcome, watchSync: testCase.outcome });

      // Events announce exactly what the result holds: fatal rows are not notices.
      const result = await handle.result.catch(() => null);
      expect(events.filter((event) => event.type === 'error-row')).toHaveLength(result?.errors.length ?? 0);
      // `messages` also lists the per-file errors, which arrive as error-row events instead.
      expect(events.filter((event) => event.type === 'message'))
        .toHaveLength((result?.messages?.length ?? 0) - (result?.errors.length ?? 0));
    });
  }
});

describe('row classification across reconcile previews', () => {
  const dataRow = { depotFile: '//depot/main/a.txt', clientFile: 'C:\\work\\a.txt', action: 'edit' };
  const cases: Case[] = [
    {
      name: 'per-file failure',
      stdout: [{ severity: 3, generic: 33, data: 'open for read: C:\\work\\b.txt: Access is denied.' }],
      exitCode: 1,
      outcome: 'fatal'
    },
    {
      name: 'nothing to reconcile',
      stdout: [{ severity: 2, generic: 17, data: '//depot/main/c.txt - no file(s) to reconcile.' }],
      exitCode: 0,
      outcome: 'message'
    },
    { name: 'informational notice', stdout: [{ level: 0, data: 'Scanned 2 files.' }], exitCode: 0, outcome: 'message' },
    { name: 'plain stderr notice', stderr: STDERR_NOTICE, exitCode: 0, outcome: 'message' },
    { name: 'not in client view', stdout: [NOT_IN_VIEW], exitCode: 0, outcome: 'fatal' },
    { name: 'expired ticket', stdout: [EXPIRED], exitCode: 1, outcome: 'fatal' },
    { name: 'unparseable stdout', stdout: ['not json'], exitCode: 0, outcome: 'parse' }
  ];
  const readPreview = (result: P4MessageCarrier): Outcome => hasMessages(result) ?? 'data';
  // Servers without -I progress get the same command previewReconcile runs.
  const unsupportedProgress = (args: string[]): Wire | null =>
    args.includes('-I') ? { stderr: 'Invalid option: -I.', exitCode: 1 } : null;

  for (const testCase of cases) {
    it(`${testCase.name}: previewReconcile and watchPreviewReconcile agree`, async () => {
      const buffered = new P4Client({ executor: bufferedExecutor(dataRow, testCase) });
      const fallback = new P4Client({ streamExecutor: streamingExecutor(dataRow, testCase, unsupportedProgress) });
      const outcomes: Record<string, Outcome> = {
        previewReconcile: await settle(buffered.previewReconcile(), readPreview),
        'watchPreviewReconcile without -I': await settle(fallback.watchPreviewReconcile().result, readPreview)
      };
      const expected: Record<string, Outcome> = {
        previewReconcile: testCase.outcome,
        'watchPreviewReconcile without -I': testCase.outcome
      };
      // With -I, a non-JSON stdout line is a progress hint, so that one case is not comparable.
      if (testCase.outcome !== 'parse') {
        const progress = new P4Client({ streamExecutor: streamingExecutor(dataRow, testCase) });
        outcomes['watchPreviewReconcile with -I'] = await settle(progress.watchPreviewReconcile().result, readPreview);
        expected['watchPreviewReconcile with -I'] = testCase.outcome;
      }
      expect(outcomes).toEqual(expected);
    });
  }
});

describe('row classification across file readers', () => {
  const cases: Case[] = [
    {
      name: 'no such file',
      stdout: [{ severity: 2, generic: 17, data: '//depot/main/a.txt - no such file(s).' }],
      exitCode: 0,
      outcome: 'message'
    },
    {
      name: 'missing revision',
      stdout: [{ severity: 2, generic: 17, data: '//depot/main/a.txt#9 - no file(s) at that revision.' }],
      exitCode: 0,
      outcome: 'message'
    },
    { name: 'informational notice', stdout: [{ level: 0, data: 'Server notice.' }], exitCode: 0, outcome: 'message' },
    { name: 'plain stderr notice', stderr: STDERR_NOTICE, exitCode: 0, outcome: 'message' },
    { name: 'not in client view', stdout: [NOT_IN_VIEW], exitCode: 0, outcome: 'fatal' },
    {
      name: 'per-file error',
      stdout: [{ severity: 3, generic: 1, data: '//depot/main/a.txt - librarian checkout failed.' }],
      exitCode: 1,
      outcome: 'fatal'
    },
    { name: 'expired ticket', stdout: [EXPIRED], exitCode: 1, outcome: 'fatal' },
    { name: 'unparseable stdout', stdout: ['not json'], exitCode: 0, outcome: 'parse' }
  ];
  const spec = '//depot/main/a.txt';
  const readers: Record<string, (client: P4Client) => Promise<P4MessageCarrier>> = {
    getOpenedFiles: (client) => client.getOpenedFiles({ fileSpec: spec }),
    listSubmittedChangelists: (client) => client.listSubmittedChangelists({ fileSpec: spec }),
    statFiles: (client) => client.statFiles({ fileSpec: spec }),
    whereFiles: (client) => client.whereFiles({ fileSpec: spec }),
    getFileHistory: (client) => client.getFileHistory({ depotFile: spec }),
    listDepotFiles: (client) => client.listDepotFiles({ depotPath: '//depot/main' }),
    annotateFile: (client) => client.annotateFile({ depotFile: spec })
  };

  for (const testCase of cases) {
    it(`${testCase.name}: every tagged file reader agrees`, async () => {
      const client = new P4Client({ executor: bufferedExecutor(null, testCase) });
      const outcomes: Record<string, Outcome> = {};
      for (const [name, read] of Object.entries(readers)) {
        outcomes[name] = await settle(read(client), (result) => hasMessages(result) ?? 'data');
      }
      expect(outcomes).toEqual(Object.fromEntries(Object.keys(readers).map((name) => [name, testCase.outcome])));
    });
  }
});

describe('unavailable print content', () => {
  const fileRow = { depotFile: '//depot/main/a.txt', rev: '9', type: 'text', action: 'edit' };
  for (const warning of [
    '//depot/main/a.txt#9 - no file(s) at that revision.',
    '//depot/main/a.txt#9 - no such file(s).'
  ]) {
    it(`printFile and materializeDepotFiles both reject "${warning}"`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'p4-ts-classification-'));
      try {
        const client = new P4Client({
          executor: async (command, args) => ({
            command,
            args,
            stdout: args.includes('files') ? JSON.stringify(fileRow) : '',
            stderr: args.includes('print') ? warning : '',
            exitCode: 0
          })
        });
        await expect(client.printFile('//depot/main/a.txt', { revision: 9 })).rejects.toBeInstanceOf(P4CommandError);
        await expect(client.materializeDepotFiles({
          directory,
          maxFiles: 1,
          files: [{ depotFile: '//depot/main/a.txt' as P4DepotPath, revision: 9 }]
        })).rejects.toBeInstanceOf(P4CommandError);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
