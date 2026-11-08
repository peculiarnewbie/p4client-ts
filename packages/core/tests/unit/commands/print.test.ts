import { describe, expect, it } from 'vite-plus/test';
import { Effect, Layer, Predicate } from 'effect';
import { printBatch, printedText, printFile } from '../../../src/commands/print.js';
import { runCommand } from '../../../src/engine/command.js';
import { configLayer } from '../../../src/engine/config.js';
import { recordingExecutor, replayExecutor, scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtureTime, fixtures, replay, run, watch } from './support.js';
import { asAction, asDepotPath } from '../../support/values.js';
import type { P4WireFields } from '../../../src/wire/value.js';
import type { P4CommandSpec } from '../../../src/engine/command.js';
import { P4CommandError, P4InvalidArgumentError, P4ParseError } from '../../../src/errors.js';
import { expectFailure } from '../../support/assert.js';

const MARSHAL = ['-G'];
const BATCH_INPUT = '//p4ts/main/wire/text.txt\n//p4ts/main/wire/full.uasset\n//p4ts/main/missing.txt\n//p4ts/main/wire/wide.txt\n';
const encoder = new TextEncoder();

function marshalRecord(fields: Record<string, string>): Buffer {
  const string = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length);

    return Buffer.concat([Buffer.from('s'), length, bytes]);
  };

  return Buffer.concat([
    Buffer.from('{'),
    ...Object.entries(fields).flatMap(([key, value]) => [string(key), string(value)]),
    Buffer.from('0'),
  ]);
}

describe('print content size', () => {
  const stat = (fileSize: string, type = 'binary') => marshalRecord({
    code: 'stat', depotFile: '//d/a.bin', rev: '1', type, fileSize,
  });

  const chunk = (data: string) => marshalRecord({ code: 'binary', data });

  const boundaries = [
    ['EOF', Buffer.alloc(0)],
    ['next stat', stat('0')],
    ['missing spec', marshalRecord({ code: 'error', data: '//d/missing - no such file(s).\n', generic: '17', severity: '2' })],
  ] as const;

  for (const size of ['1', '4']) {
    for (const [boundary, end] of boundaries) {
      it(`rejects binary size ${size} with two bytes at ${boundary} before publishing`, async () => {
        const executor = scriptedExecutor(() => ({ stdout: Buffer.concat([stat(size), chunk('a'), chunk('b'), end]) }), { chunkSize: 3 });

        if (boundary !== 'missing spec') {
          expectFailure(await failure(printFile, { file: '//d/a.bin' }, executor), P4ParseError);
        }

        const published: unknown[] = [];

        const error = await Effect.runPromise(printBatch.program({ fileSpec: ['//d/a.bin', '//d/missing'] }, {
          item: (item) => Effect.sync(() => { published.push(item); }),
          message: () => Effect.void,
          failure: () => Effect.void,
          progress: () => Effect.void,
        }).pipe(Effect.provide(Layer.merge(executor, configLayer({}))), Effect.flip));

        expectFailure(error, P4ParseError);
        expect(published).toEqual([]);
      });
    }
  }

  // A +k binary's fileSize is its keyword-expanded size, so a raw print is shorter (seen on Helix
  // Core 2024.2: 26 raw bytes against fileSize 66).
  for (const type of ['binary+k', 'binary+ko', 'binary+Fk', 'binary+kC', 'ubinary+kSn']) {
    it(`accepts a raw ${type} print shorter than its expanded fileSize`, async () => {
      const executor = scriptedExecutor(() => ({ stdout: Buffer.concat([stat('66', type), chunk('$Id$')]) }));
      const file = await run(printFile, { file: '//d/a.bin' }, executor);
      expect(file.content.length).toBe(4);
    });
  }

  it('accepts exact and zero binary sizes including split content', async () => {
    for (const [size, chunks] of [['2', [chunk('a'), chunk('b')]], ['0', []]] as const) {
      const executor = scriptedExecutor(() => ({ stdout: Buffer.concat([stat(size), ...chunks]) }), { chunkSize: 1 });
      const file = await run(printFile, { file: '//d/a.bin' }, executor);
      expect(file.content.length).toBe(Number(size));
      const batch = await run(printBatch, { fileSpec: ['//d/a.bin'] }, executor);
      expect(batch.printed).toHaveLength(1);
      expect(batch.items[0]?.content).toEqual(file.content);
    }
  });

  it('allows expanded text keywords to differ from stored size', async () => {
    const file = await run(printFile, { file: '//d/a.bin', keywords: 'expand' }, scriptedExecutor(() => ({
      stdout: Buffer.concat([stat('4', 'text+k'), marshalRecord({ code: 'text', data: '$Id: expanded $' })]),
    })));

    expect(printedText(file)).toBe('$Id: expanded $');
  });
});

function collect<A>(spec: P4CommandSpec<A>, ...names: string[]) {
  return Effect.runPromise(runCommand(spec).pipe(Effect.provide(Layer.merge(replay(...names), configLayer({})))));
}

describe('print operations: argv', () => {
  argvTable([
    argvCase('printFile prints raw content with -K by default', printFile, { file: '//d/a.txt' }, [
      [...MARSHAL, 'print', '-k', '//d/a.txt'],
    ]),
    argvCase('printFile appends a revision number', printFile, { file: '//d/a.txt', revision: 3 }, [
      [...MARSHAL, 'print', '-k', '//d/a.txt#3'],
    ]),
    argvCase('printFile appends a shelf or label specifier as given', printFile, {
      file: '//d/a.txt', revision: '@=7', keywords: 'expand',
    }, [[...MARSHAL, 'print', '//d/a.txt@=7']]),
    argvCase('printFile reads #have when asked', printFile, { file: '//d/a.txt', revision: 'have' }, [
      [...MARSHAL, 'print', '-k', '//d/a.txt#have'],
    ]),
    argvCase('printBatch passes the specs on stdin', printBatch, { fileSpec: ['//d/a.txt', '//d/b.bin#2'] }, [
      [...MARSHAL, '-x', '-', 'print', '-k'],
    ]),
  ]);

  it('printBatch writes one spec per line with a trailing line break', async () => {
    const recorder = recordingExecutor(scriptedExecutor(() => ({})));
    await Effect.runPromise(Effect.provide(
      Effect.exit(printBatch.program({ fileSpec: ['//d/a.txt', '//d/b.bin#2'] }, {
        item: () => Effect.void, message: () => Effect.void, failure: () => Effect.void, progress: () => Effect.void,
      })),
      Layer.merge(recorder.layer, configLayer({})),
    ));
    expect(recorder.invocations.map((invocation) => invocation.input)).toEqual(['//d/a.txt\n//d/b.bin#2\n']);
  });
});

describe('printFile', () => {
  it('returns text content as bytes with the revision metadata', async () => {
    const printed = await run(printFile, { file: '//p4ts/main/wire/text.txt' }, replay('print-marshal-text'));
    expect(printed).toEqual({
      depotFile: asDepotPath('//p4ts/main/wire/text.txt'),
      revision: 1,
      change: 4,
      action: asAction('add'),
      type: 'text',
      // The JSON capture of the same revision carries the same submit time.
      time: fixtureTime('print-json', 'time'),
      fileSize: 8,
      content: encoder.encode('one\ntwo\n'),
      isBinary: false,
      messages: [],
    });
    expect(printedText(printed)).toBe('one\ntwo\n');
  });

  it('keeps binary content byte for byte', async () => {
    const printed = await run(printFile, { file: '//p4ts/main/wire/full.uasset' }, replay('print-marshal-binary'));
    expect(printed).toMatchObject({ type: 'binary+F', isBinary: true, fileSize: 16 });
    expect([...printed.content]).toEqual([...encoder.encode('full binary\u0000data')]);
  });

  it('decodes utf16 files, which -G sends in the client charset', async () => {
    const printed = await run(printFile, { file: '//p4ts/main/wire/wide.txt' }, replay('print-marshal-utf16'));
    expect(printed).toMatchObject({ type: 'utf16', isBinary: false });
    expect(printedText(printed)).toBe('wide text\n');
    // Plain `print -q` writes the same text with the workspace's line endings.
    expect(fixtures('print-utf16')[0]!.stdout!.replace(/\r\n/g, '\n')).toBe(printedText(printed));
  });

  it('fails when the file does not exist', async () => {
    const error = await failure(printFile, { file: '//p4ts/main/missing.txt' }, replay('print-marshal-missing'));
    expectFailure(error, P4CommandError, { reason: 'no_such_file', category: 'not_found' });
  });

  it('rejects a spec that matches several files', async () => {
    // The batch capture up to its missing-file message: two complete files.
    const batch = Buffer.from(fixtures('print-marshal-batch')[0]!.stdoutBase64!, 'base64');
    const stdout = batch.subarray(0, batch.indexOf(encoder.encode('{s\u0004\u0000\u0000\u0000codes\u0005')));
    const error = await failure(printFile, { file: '//p4ts/main/...' }, scriptedExecutor(() => ({ stdout })));
    expectFailure(error, P4InvalidArgumentError, { option: 'file' });
  });

  it('decodes text that starts with a UTF-16 byte-order mark', () => {
    expect(printedText({ content: new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]) })).toBe('hi');
    expect(printedText({ content: new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]) })).toBe('hi');
    expect(printedText({ content: new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]) })).toBe('hi');
  });

  it('returns plain data that survives structuredClone', async () => {
    const printed = await run(printFile, { file: '//p4ts/main/wire/full.uasset' }, replay('print-marshal-binary'));
    expect(structuredClone(printed)).toEqual(printed);
  });
});

describe('printBatch', () => {
  const files = BATCH_INPUT.trim().split('\n');

  it('prints each file and reports missing ones as failures', async () => {
    const result = await run(printBatch, { fileSpec: files }, replay('print-marshal-batch'));
    expect(result.items.map((item) => [item.file.depotFile, item.file.type, printedText(item)])).toEqual([
      ['//p4ts/main/wire/text.txt', 'text', 'one\ntwo\n'],
      ['//p4ts/main/wire/full.uasset', 'binary+F', 'full binary\u0000data'],
      ['//p4ts/main/wire/wide.txt', 'utf16', 'wide text\n'],
    ]);
    expect(result.failures.map((message) => message.reason)).toEqual(['no_such_file']);
    expect(result.messages).toEqual([]);
    expect(structuredClone(result)).toEqual(result);
  });

  it('streams files as they complete, in output order, with file and byte progress', async () => {
    const events = await watch(printBatch, { fileSpec: files }, replayExecutor(fixtures('print-marshal-batch'), {
      chunkSize: 7,
    }));

    expect(events.filter((event) => !Predicate.isTagged(event, 'progress')).map((event) => Predicate.isTagged(event, 'item')
      ? String(event.item.file.depotFile)
      : event._tag)).toEqual([
      '//p4ts/main/wire/text.txt', '//p4ts/main/wire/full.uasset', 'failure', '//p4ts/main/wire/wide.txt', 'done',
    ]);
    const done = events.at(-1);

    if (!Predicate.isTagged(done, 'done')) throw new Error('Expected done.');
    expect(events.flatMap((event) => Predicate.isTagged(event, 'failure') ? [event.failure] : []))
      .toEqual(done.result.failures);
    const progress = events.flatMap((event) => Predicate.isTagged(event, 'progress') ? [event.progress] : []);
    expect(progress.map((update) => [update.completed, update.total, update.bytesCompleted])).toEqual([
      [1, 4, 8], [2, 4, 24], [3, 4, 24], [4, 4, 34],
    ]);
    expect(progress.every((update) => update.unit === 'files')).toBe(true);
  });

  it('leaves content to the events when asked not to keep it', async () => {
    const events = await watch(printBatch, { fileSpec: files, keepContent: false }, replay('print-marshal-batch'));
    const done = events.at(-1);

    if (!Predicate.isTagged(done, 'done')) throw new Error('Expected a result.');
    expect(done.result.items).toEqual([]);
    expect(done.result.printed.map((file) => file.depotFile)).toEqual([
      asDepotPath('//p4ts/main/wire/text.txt'), asDepotPath('//p4ts/main/wire/full.uasset'), asDepotPath('//p4ts/main/wire/wide.txt'),
    ]);
    const streamed = events.flatMap((event) => Predicate.isTagged(event, 'item') ? [printedText(event.item)] : []);
    expect(streamed).toEqual(['one\ntwo\n', 'full binary\u0000data', 'wide text\n']);
  });

  it('rejects an empty list and multi-line specs without running p4', async () => {
    const none = scriptedExecutor(() => {
      throw new Error('p4 must not run');
    });

    expectFailure(await failure(printBatch, { fileSpec: [] }, none), P4InvalidArgumentError, { option: 'fileSpec' });
    expectFailure(await failure(printBatch, { fileSpec: ['//d/a\n-o'] }, none), P4InvalidArgumentError);
  });
});

describe('print output formats', () => {
  // Why print uses -G: -Mj print carries content in JSON strings, decoded as text.
  it('-Mj print sends content as JSON text rather than bytes', async () => {
    const decode = (row: P4WireFields) => row;
    const text = await collect({ args: ['print', '-q', '//p4ts/main/wire/text.txt'], format: 'json', decode }, 'print-json');
    expect(text.items.map((row) => row.data)).toEqual([undefined, 'one\ntwo\n', '']);
    const binary = await collect({ args: ['print', '-q', '//p4ts/main/wire/full.uasset'], format: 'json', decode }, 'print-json-binary');
    expect(binary.items[1]?.data).toBeTypeOf('string');
  });

  it('a missing file is only an empty-result warning by default, which printFile overrides', async () => {
    const output = await collect({ args: ['print', '-q', '//p4ts/main/missing.txt'], format: 'json', decode: (row) => row }, 'print-empty');
    expect([output.messages.map((message) => message.reason), output.failures]).toEqual([['no_such_file'], []]);
  });
});

it('associates code-less marshal missing-file warnings with the requested spec', async () => {
  const file = '//p4ts/main/wire/text.txt';
  const missing = '//p4ts/main/__missing__.txt#3';

  const marshalString = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8');
    const prefix = Buffer.alloc(5);
    prefix[0] = 's'.charCodeAt(0);
    prefix.writeInt32LE(bytes.length, 1);

    return Buffer.concat([prefix, bytes]);
  };

  const message = Buffer.concat([
    Buffer.from('{'),
    ...Object.entries({ code: 'error', data: `${missing} - no such file(s).\n`, generic: '17', severity: '2' })
      .flatMap(([key, value]) => [marshalString(key), marshalString(value)]),
    Buffer.from('0'),
  ]);

  const valid = Buffer.from(fixtures('print-marshal-text')[0]!.stdoutBase64!, 'base64');

  const result = await run(printBatch, { fileSpec: [file, missing] }, scriptedExecutor(() => ({
    stdout: Buffer.concat([valid, message]),
  }), { chunkSize: 3 }));

  expect(result.items).toHaveLength(1);
  expect(result.failures[0]).toMatchObject({ spec: missing, reason: 'no_such_file' });
  expect(result.messages).toEqual([]);
});
