import { describe, expect, it } from 'bun:test';
import { Effect, Schema } from 'effect';
import {
  P4Client, P4ClientPathSchema, P4DepotPathSchema, P4LocalPathSchema,
  P4NonNegativeIntegerSchema, P4PositiveIntegerSchema, P4ParseError,
  P4JsonWorkspaceSchema, createP4Service, normalizeP4Change, parseP4JsonLines
} from '../src/public/index.js';
import type { P4ClientOptions } from '../src/public/index.js';

function optionsForRow(row: unknown): P4ClientOptions {
  return {
    env: { P4USER: 'tester' },
    executor: (command, args) => Effect.runPromise(Effect.succeed({
      command, args, exitCode: 0, stderr: '',
      stdout: args[0] === 'info' ? 'User name: tester\n' : JSON.stringify(row)
    }))
  };
}

describe('schema-driven JSON parsing', () => {
  const Row = Schema.Struct({ rev: P4PositiveIntegerSchema });

  it('infers and applies transformations, retaining unknown fields only in raw mode', () => {
    const output = '{"rev":"7","futureTag":true}\r\n\r\n{"rev":8}';
    expect(parseP4JsonLines(output, Row)).toEqual([{ rev: 7 }, { rev: 8 }]);
    expect(parseP4JsonLines(output)[0]).toEqual({ rev: '7', futureTag: true });
  });

  it('includes the exact failing line and schema cause', () => {
    const line = '  {"rev":"bad"}  ';
    try {
      parseP4JsonLines('{"rev":1}\n' + line, Row);
      throw new Error('Expected a schema failure');
    } catch (error) {
      expect(error).toBeInstanceOf(P4ParseError);
      if (!(error instanceof P4ParseError)) throw error;
      expect(error.line).toBe(line);
      expect(error.cause).toBeDefined();
    }
  });

  it('validates required keys and object shape', () => {
    for (const output of ['{}', '{"rev":null}', '{"rev":[]}', '[]', 'null', '3']) {
      expect(() => parseP4JsonLines(output, Row)).toThrow(P4ParseError);
    }
    expect(() => parseP4JsonLines('{"client":"test"}', P4JsonWorkspaceSchema))
      .toThrow(P4ParseError);
  });

  it('supports schemas in runTaggedJson with execution options', async () => {
    const client = new P4Client(optionsForRow({ rev: '7' }));
    await expect(client.runTaggedJson(['files'], { schema: Row, timeoutMs: 1000 }))
      .resolves.toEqual([{ rev: 7 }]);
    const invalid = new P4Client(optionsForRow({ rev: 'wrong' }));
    await expect(invalid.runTaggedJson(['files'], { schema: Row })).rejects.toBeInstanceOf(P4ParseError);
  });
});

describe('validated scalar types', () => {
  it('accepts safe decimal integers without accepting lossy or coercible values', () => {
    const decode = Schema.decodeUnknownSync(P4NonNegativeIntegerSchema);
    for (const value of [0, '0', 7, '007', Number.MAX_SAFE_INTEGER]) {
      expect(decode(value)).toBe(Number(value));
    }
    for (const value of [-1, '1.2', 1.2, '1e3', '0x10', '', ' ', true, null, Infinity,
      Number.MAX_SAFE_INTEGER + 1, '9007199254740993']) {
      expect(() => decode(value)).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(P4PositiveIntegerSchema)(0)).toThrow();
    expect(normalizeP4Change(123)).toBe(123);
    expect(normalizeP4Change('default')).toBe('default');
    expect(normalizeP4Change('1.9')).toBeNull();
    expect(normalizeP4Change('9007199254740993')).toBeNull();
  });

  it('establishes depot/client brands only for Perforce syntax', () => {
    for (const schema of [P4DepotPathSchema, P4ClientPathSchema]) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode('//depot/file with spaces')).toBe('//depot/file with spaces');
      for (const value of ['', ' ', '//', '///file', 'relative.txt', 'C:\\file.txt', '//depot/a\0b']) {
        expect(() => decode(value)).toThrow();
      }
    }
    expect(Schema.decodeUnknownSync(P4LocalPathSchema)('C:\\file.txt')).toBe('C:\\file.txt');
    expect(() => Schema.decodeUnknownSync(P4LocalPathSchema)(' ')).toThrow();
  });
});

describe('command output schemas', () => {
  const cases: Array<{
    name: string;
    row: Record<string, unknown>;
    run: (client: P4Client) => Promise<unknown>;
  }> = [
    { name: 'workspace required fields', row: { client: 'test', Root: '/work' }, run: (p4) => p4.listWorkspaces() },
    { name: 'depot name', row: { name: 17 }, run: (p4) => p4.listDepots() },
    { name: 'missing depot identity', row: {}, run: (p4) => p4.listDepots() },
    { name: 'directory path', row: { dir: 'local/path' }, run: (p4) => p4.listDepotDirs({ depotPath: '//depot' }) },
    { name: 'file revision', row: { depotFile: '//depot/file', rev: '1.5' }, run: (p4) => p4.listDepotFiles({ depotPath: '//depot' }) },
    { name: 'optional metadata', row: { depotFile: '//depot/file', headRev: {} }, run: (p4) => p4.statFiles({ fileSpec: '//depot/file' }) },
    { name: 'where identity', row: { depotFile: '' }, run: (p4) => p4.whereFiles({ fileSpec: '//depot/file' }) },
    { name: 'indexed history', row: { depotFile: '//depot/file', rev0: 'bad' }, run: (p4) => p4.getFileHistory({ depotFile: '//depot/file' }) },
    { name: 'user identity', row: { User: null }, run: (p4) => p4.listUsers() },
    { name: 'stream parent', row: { Stream: '//depot/main', Parent: 'bogus' }, run: (p4) => p4.listStreams() },
    { name: 'annotation content', row: { upper: '7', data: 123 }, run: (p4) => p4.annotateFile({ depotFile: '//depot/file' }) },
    { name: 'opened action', row: { action: 123 }, run: (p4) => p4.getOpenedFiles() },
    { name: 'sync revision', row: { depotFile: '//depot/file', rev: -1 }, run: (p4) => p4.sync() },
    { name: 'missing sync identity', row: {}, run: (p4) => p4.sync() },
    { name: 'reconcile action', row: { action: 'integrate' }, run: (p4) => p4.previewReconcile() },
    { name: 'numbered changelist', row: { change: 'not-a-change' }, run: (p4) => p4.listSubmittedChangelists() },
    { name: 'print metadata', row: { depotFile: '//depot/file', type: [] }, run: (p4) => p4.printFile('//depot/file') }
  ];

  for (const { name, row, run } of cases) {
    it(`rejects malformed ${name} with a typed parse failure`, async () => {
      await expect(run(new P4Client(optionsForRow(row)))).rejects.toBeInstanceOf(P4ParseError);
    });
  }

  it('keeps schema failures in the Effect service error channel', async () => {
    const service = createP4Service(optionsForRow({ User: [] }));
    const error = await Effect.runPromise(service.listUsers().pipe(Effect.flip));
    expect(error).toBeInstanceOf(P4ParseError);
    if (!(error instanceof P4ParseError)) throw error;
    expect(error.line).toBe('{"User":[]}');
  });

  it('validates sync rows before emitting progress events', async () => {
    const row = '{"depotFile":"//depot/file","rev":"1.5"}';
    const client = new P4Client({
      streamExecutor: (command, args) => ({
        events: (async function* () {
          yield { type: 'line' as const, source: 'stdout' as const, line: row };
        })(),
        result: Effect.runPromise(Effect.succeed({ command, args, stdout: row, stderr: '', exitCode: 0 }))
      })
    });
    const handle = client.watchSync();
    const consume = async () => {
      for await (const event of handle.events) {
        expect(event.type).not.toBe('progress');
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(P4ParseError);
    await expect(handle.result).rejects.toBeInstanceOf(P4ParseError);
  });

  it('preserves optional fields, zero revisions, and additional server tags', async () => {
    const client = new P4Client(optionsForRow({
      depotFile: '//depot/file', haveRev: '0', headRev: 2, otherOpen0: 'user@client', future: {}
    }));
    const [file] = await client.statFiles({ fileSpec: '//depot/file' });
    expect(file).toMatchObject({ haveRevision: 0, headRevision: 2, otherOpen: ['user@client'], headType: null });
  });
});
