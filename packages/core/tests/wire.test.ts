import { describe, expect, it } from 'bun:test';
import { Effect, Schema } from 'effect';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { P4Client } from '../src/public/client.js';
import { P4CommandError, P4ParseError } from '../src/public/errors.js';
import { parseP4JsonLines } from '../src/public/helpers.js';
import { createP4Service } from '../src/public/service.js';
import {
  P4DepotPathSchema,
  P4FileActionSchema,
} from '../src/public/schemas.js';
import type {
  P4CommandResult,
  P4CommandStreamEvent,
} from '../src/public/types.js';

const root = join(import.meta.dir, 'fixtures/wire');
const CaptureSchema = Schema.Struct({
  origin: Schema.String,
  mode: Schema.Literals(['json', 'tagged', 'marshal', 'plain']),
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.String,
});
const load = (name: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(CaptureSchema))(
    readFileSync(join(root, `${name}.json`), 'utf8'),
  );
function replay(name: string): P4Client {
  const capture = load(name);
  const result = (command: string, args: string[]): P4CommandResult => ({
    command,
    args,
    stdout: capture.stdout ?? '',
    stderr: capture.stderr,
    exitCode: capture.exitCode,
  });
  return new P4Client({
    cwd: 'C:/fixture',
    executor: (command, args) =>
      Effect.runPromise(Effect.succeed(result(command, args))),
    streamExecutor: (command, args) => ({
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<P4CommandStreamEvent> {
          for (const line of (capture.stdout ?? '')
            .trim()
            .split('\n')
            .filter(Boolean)) {
            yield { type: 'line', source: 'stdout', line };
          }
          yield { type: 'exit', exitCode: capture.exitCode };
        },
      },
      result: Effect.runPromise(Effect.succeed(result(command, args))),
    }),
  });
}
const file = '//p4ts/main/wire/text.txt';

describe('recorded Perforce wire regressions', () => {
  it('validates every committed capture envelope and JSON row', () => {
    for (const name of readdirSync(root).filter(
      (name) =>
        name.endsWith('.json') &&
        !name.startsWith('_') &&
        !name.startsWith('gap-') &&
        !name.startsWith('synthetic-malformed'),
    )) {
      const capture = load(name.replace(/\.json$/, ''));
      expect(capture.origin).toMatch(/disposable|synthetic/);
      if (capture.mode === 'json')
        expect(() => parseP4JsonLines(capture.stdout ?? '')).not.toThrow();
    }
  });
  it('upstreams the level-only OutputInfo fix and preserves both informational rows', async () => {
    const preview = await replay('sync-opened-new-head-preview').previewSync({
      fileSpec: file,
    });
    expect(preview.items).toEqual([]);
    expect(preview.totalCount).toBe(0);
    expect(preview.messages).toMatchObject([
      { kind: 'info', severity: null, level: 0, reason: 'opened_unchanged' },
      { kind: 'info', severity: null, level: 1, reason: 'resolve_required' },
    ]);
  });
  it('gives buffered and watched sync the same messages without counting them as files', async () => {
    const p4 = replay('sync-opened-new-head');
    const buffered = await p4.sync({ fileSpec: file });
    const watched = p4.watchSync({ fileSpec: file });
    const types: string[] = [];
    for await (const event of watched.events) types.push(event.type);
    expect((await watched.result).messages).toEqual(buffered.messages);
    expect(types).toEqual(['start', 'message', 'message', 'complete']);
  });
  it('retains up-to-date warnings and their numeric message code', async () => {
    const result = await replay('sync-up-to-date').previewSync({
      fileSpec: file,
    });
    expect(result.totalCount).toBe(0);
    expect(result.messages?.[0]).toMatchObject({
      kind: 'warning',
      reason: 'up_to_date',
      severity: 2,
      generic: 17,
    });
    expect(result.messages?.[0]?.raw.code0).toBeNumber();
  });
  it('retains tagged diagnostics on stderr alongside stdout data', async () => {
    const result = await replay('synthetic-stderr').listDepotFiles({
      depotPath: '//depot/main',
    });
    expect(result.items).toHaveLength(1);
    expect(result.messages?.[0]).toMatchObject({
      kind: 'warning',
      reason: 'up_to_date',
    });
    expect(result.messages?.[1]).toMatchObject({
      kind: 'warning',
      reason: 'empty',
    });
  });
  it('filters warning rows before a caller-supplied data schema', async () => {
    const result = await replay('files-empty').runTaggedJson(['files', file], {
      schema: Schema.Struct({ depotFile: P4DepotPathSchema }),
    });
    expect(result).toEqual([]);
    expect(result.messages?.[0]?.reason).toBe('empty');
  });
  for (const [name, operation] of [
    [
      'files-empty',
      (p4: P4Client) => p4.listDepotFiles({ depotPath: '//p4ts/main/missing' }),
    ],
    ['fstat-empty', (p4: P4Client) => p4.statFiles({ fileSpec: file })],
    ['filelog-empty', (p4: P4Client) => p4.getFileHistory({ depotFile: file })],
    ['annotate-empty', (p4: P4Client) => p4.annotateFile({ depotFile: file })],
    [
      'reconcile-empty',
      (p4: P4Client) => p4.previewReconcile({ fileSpec: file }),
    ],
  ] as const) {
    it(`returns empty data with retained messages for ${name}`, async () => {
      const result = await operation(replay(name));
      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0]?.kind).toBe('warning');
    });
  }
  it('accepts an empty dirs response without inventing a message', async () => {
    const result = await replay('dirs-empty').listDepotDirs({
      depotPath: '//p4ts/main/missing',
    });
    expect(result).toEqual({ items: [], hasMore: false });
  });
  for (const [name, reason, category, operation] of [
    [
      'describe-unknown',
      'unknown_changelist',
      'changelist',
      (p4: P4Client) => p4.describeChangelist(999999),
    ],
    [
      'files-bad-revision',
      'unknown_revision',
      'revision',
      (p4: P4Client) => p4.runTaggedJson(['files', `${file}#invalid`]),
    ],
    [
      'files-missing-revision',
      'unknown_revision',
      'revision',
      (p4: P4Client) => p4.printFile(file, { revision: 999999 }),
    ],
    [
      'users-unknown',
      'unknown_user',
      'user',
      (p4: P4Client) => p4.listUsers({ users: ['missing-user'] }),
    ],
    [
      'sync-unknown-client',
      'unknown_client',
      'client',
      (p4: P4Client) => p4.previewSync({ fileSpec: file }),
    ],
    [
      'sync-not-in-view',
      'not_in_view',
      'not_in_view',
      (p4: P4Client) => p4.previewSync({ fileSpec: file }),
    ],
    [
      'where-not-in-view',
      'not_in_view',
      'not_in_view',
      (p4: P4Client) => p4.whereFiles({ fileSpec: file }),
    ],
    [
      'print-permission',
      'permission_denied',
      'permission',
      (p4: P4Client) => p4.runTaggedJson(['print', file]),
    ],
    [
      'changes-not-logged-in',
      'not_logged_in',
      'authentication',
      (p4: P4Client) => p4.listChangelists({ status: 'submitted' }),
    ],
    [
      'changes-ticket-expired',
      'ticket_expired',
      'authentication',
      (p4: P4Client) => p4.listChangelists({ status: 'submitted' }),
    ],
    [
      'server-unreachable',
      'server_unreachable',
      'connection',
      (p4: P4Client) => p4.previewSync({ fileSpec: file }),
    ],
  ] as const) {
    it(`classifies ${name} even when the CLI exits zero`, async () => {
      try {
        await operation(replay(name));
        throw new Error('Expected a typed failure');
      } catch (error) {
        expect(error).toBeInstanceOf(P4CommandError);
        if (error instanceof P4CommandError) {
          expect(error.reason).toBe(reason);
          expect(error.category).toBe(category);
          expect(error.result.exitCode).toBe(load(name).exitCode);
        }
      }
    });
  }
  it('keeps authentication errors fatal in buffered and watched sync', async () => {
    await expect(
      replay('changes-ticket-expired').sync(),
    ).rejects.toBeInstanceOf(P4CommandError);
    const handle = replay('changes-ticket-expired').watchSync();
    await expect(
      (async () => {
        for await (const event of handle.events) {
          if (event.type === 'message')
            expect(event.message.reason).toBe('ticket_expired');
        }
      })(),
    ).rejects.toBeInstanceOf(P4CommandError);
    await expect(handle.result).rejects.toBeInstanceOf(P4CommandError);
  });
  it('returns mixed successful file rows and per-file clobber errors', async () => {
    const result = await replay('sync-clobber').sync();
    expect(result.items).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.clientFile).toMatch(/clobber\.txt$/);
    expect(result.messages?.[0]).toMatchObject({
      kind: 'error',
      reason: 'clobber',
    });
  });
  it('does not accept an exit-one plain diff error as a successful empty diff', async () => {
    const capture = load('diff2-bad-revision');
    const p4 = new P4Client({
      executor: (command, args) =>
        Effect.runPromise(
          Effect.succeed({
            command,
            args,
            stdout: '',
            stderr: Schema.decodeUnknownSync(Schema.String)(
              parseP4JsonLines(capture.stdout ?? '')[0]?.data,
            ),
            exitCode: 1,
          }),
        ),
    });
    await expect(
      p4.diffFile({ depotFile: file, fromRevision: 'invalid', toRevision: 1 }),
    ).rejects.toBeInstanceOf(P4CommandError);
  });
  it('retains plain diff warnings and reports missing print metadata as a command error', async () => {
    const diff = await replay('diff-not-opened-plain').diffFile({
      depotFile: file,
    });
    expect(diff.unifiedDiff).toBe('');
    expect(diff.messages?.[0]?.reason).toBe('not_opened');
    await expect(replay('files-empty').printFile(file, {
      revision: 'head',
    })).rejects.toBeInstanceOf(P4CommandError);
  });
  it('does not report a missing materialized revision as a downloaded file', async () => {
    const missing = replay('print-empty-plain');
    const directory = mkdtempSync(join(tmpdir(), 'p4-wire-materialize-'));
    try {
      await expect(
        missing.materializeDepotFiles({
          directory,
          maxFiles: 1,
          files: [
            {
              depotFile: Schema.decodeUnknownSync(P4DepotPathSchema)(file),
              revision: 1,
              changelist: 4,
              action: Schema.decodeUnknownSync(P4FileActionSchema)('add'),
              type: 'text',
            },
          ],
        }),
      ).rejects.toBeInstanceOf(P4CommandError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('applies pagination cursors to the filespec instead of adding an independent query', async () => {
    const separated = parseP4JsonLines(
      load('changes-cursor-separated').stdout ?? '',
    );
    expect(separated.some((row) => Number(row.change) > 4)).toBe(true);
    let requested: string[] = [];
    const capture = load('changes-cursor-scoped');
    const p4 = new P4Client({
      executor: (command, args) => {
        requested = args;
        return Effect.runPromise(
          Effect.succeed({
            command,
            args,
            stdout: capture.stdout ?? '',
            stderr: '',
            exitCode: 0,
          }),
        );
      },
    });
    const page = await p4.listSubmittedChangelists({
      fileSpec: '//p4ts/main/wire/...',
      beforeChange: 4,
      limit: 5,
    });
    expect(page.items.map((item) => item.change)).toEqual([4]);
    expect(requested.at(-1)).toBe('//p4ts/main/wire/...@4');
    expect(requested).not.toContain('@4');
  });
  it('merges and deduplicates multi-filespec change groups before slicing a page', async () => {
    const page = await replay(
      'changes-cursor-separated',
    ).listSubmittedChangelists({
      fileSpec: ['//p4ts/main/wire/...', '@4'],
      limit: 50,
    });
    const changes = page.items.map((item) => item.change);
    expect(changes.filter((change) => change === 4)).toHaveLength(1);
    expect(changes).toEqual([...changes].sort((left, right) => right - left));
  });
  it('parses annotate content rows containing data without mistaking them for messages', async () => {
    const result = await replay('annotate').annotateFile({ depotFile: file });
    expect(result.lines.map((line) => line.data)).toEqual(['one', 'two']);
    expect(result.messages).toBeUndefined();
  });
  it('parses 1001 indexed describe files and preserves full multiline descriptions', async () => {
    const large = await replay('describe-large').describeChangelist(10);
    expect(large.files).toHaveLength(1001);
    const changes = await replay('changes-submitted').listChangelists({
      status: 'submitted',
      limit: 5,
    });
    const description = changes.items.find(
      (change) => (change.description?.length ?? 0) > 10000,
    )?.description;
    expect(description).toContain('second paragraph');
    expect(description?.length).toBeGreaterThan(10000);
  });
  it('accepts shelves, move actions, deleted heads, exclusive locks and full binary file types', async () => {
    const shelf = await replay('describe-shelved').describeChangelist(6, {
      shelved: true,
    });
    expect(shelf.contentSource).toBe('shelved');
    const moved = await replay('describe-move').describeChangelist(8);
    expect(moved.files.map((file) => String(file.action))).toContain(
      'move/add',
    );
    expect(moved.files.map((file) => String(file.action))).toContain(
      'move/delete',
    );
    const stats = await replay('fstat-exclusive-other').statFiles({
      fileSpec: file,
    });
    expect(stats[0]?.otherLocked).toBe(true);
    expect(stats[0]?.otherOpen).toEqual(['p4ts-e2e@wire_second']);
    const files = await replay('files').listDepotFiles({
      depotPath: '//p4ts/main/wire',
      deletedFiles: 'include',
    });
    expect(files.items.some((file) => file.isDeletedAtHead)).toBe(true);
    expect(
      files.items.some((file) => file.type === 'binary+F' && file.isBinary),
    ).toBe(true);
  });
  it('retains escaped reserved characters and synthetic Unicode paths', async () => {
    const files = await replay('synthetic-paths').listDepotFiles({
      depotPath: '//depot/main',
    });
    expect(files.items.map((file) => String(file.depotFile))).toEqual([
      '//depot/main/café_日本 space.txt',
      '//depot/main/literal%40%23%25%2A.txt',
    ]);
  });
  it('decodes client-syntax escapes only when deriving a local opened-file path', async () => {
    const opened = await replay('opened-reserved').getOpenedFiles();
    expect(String(opened[0]?.depotFile)).toBe(
      '//p4ts/main/wire/literal%40%23%25.txt',
    );
    expect(String(opened[0]?.clientFile)).toContain('literal%40%23%25.txt');
    expect(String(opened[0]?.localFile)).toMatch(
      /[\\/]wire[\\/]literal@#%\.txt$/,
    );
  });
  it('accepts empty shelves without inventing a file or a message', async () => {
    const empty = await replay('describe-shelved-empty').describeChangelist(7, {
      shelved: true,
    });
    expect(empty.files).toEqual([]);
    expect(empty.contentSource).toBe('shelved');
  });
  it('classifies a mismatched Unicode client as a charset error', async () => {
    await expect(
      replay('unicode-charset-required').runTaggedJson(['files', file]),
    ).rejects.toMatchObject({ category: 'charset', reason: 'charset' });
  });
  it('always requests depotFile when narrowing fstat fields', async () => {
    let requested: string[] = [];
    const capture = load('fstat-fields');
    const p4 = new P4Client({
      executor: (command, args) => {
        requested = args;
        return Effect.runPromise(
          Effect.succeed({
            command,
            args,
            stdout: capture.stdout ?? '',
            stderr: '',
            exitCode: 0,
          }),
        );
      },
    });
    expect(
      (
        await p4.statFiles({ fileSpec: file, fields: ['headType', 'headRev'] })
      )[0]?.headRevision,
    ).toBe(1);
    expect(requested[requested.indexOf('-T') + 1]).toBe(
      'depotFile headType headRev',
    );
    expect(
      parseP4JsonLines(load('fstat-fields-without-path').stdout ?? '')[0]
        ?.depotFile,
    ).toBeUndefined();
  });
  it('keeps offending rows, command and arguments on truly malformed output', async () => {
    const malformed = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(readFileSync(join(root, 'synthetic-malformed.json'), 'utf8'));
    for (const key of ['sync', 'describe', 'message', 'reconcile', 'history', 'opened']) {
      const p4 = new P4Client({
        client: 'fixture-client',
        executor: (command, args) =>
          Effect.runPromise(
            Effect.succeed({
              command,
              args,
              stdout: JSON.stringify(malformed[key]),
              stderr: '',
              exitCode: 0,
            }),
          ),
      });
      try {
        if (key === 'describe') await p4.describeChangelist(100);
        else if (key === 'reconcile') await p4.previewReconcile();
        else if (key === 'history') await p4.getFileHistory({ depotFile: file });
        else if (key === 'opened') await p4.getOpenedFiles();
        else await p4.previewSync();
        throw new Error('Expected a schema failure');
      } catch (error) {
        expect(error).toBeInstanceOf(P4ParseError);
        if (error instanceof P4ParseError) {
          expect(error.line).toBe(JSON.stringify(malformed[key]));
          expect(error.command).toBe('p4');
          expect(error.args?.slice(0, 2)).toEqual(['-c', 'fixture-client']);
        }
      }
    }
  });
  it('preserves recognized failures through the Effect service error channel', async () => {
    const capture = load('describe-unknown');
    const service = createP4Service({
      executor: (command, args) =>
        Effect.runPromise(
          Effect.succeed({
            command,
            args,
            stdout: capture.stdout ?? '',
            stderr: '',
            exitCode: 0,
          }),
        ),
    });
    await expect(
      Effect.runPromise(service.describeChangelist(999999)),
    ).rejects.toBeInstanceOf(P4CommandError);
  });
});
