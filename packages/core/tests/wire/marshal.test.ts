import { describe, expect, it } from 'bun:test';
import { fixtureStdout } from '../../src/testing/fixture.js';
import { createMarshalDecoder } from '../../src/wire/marshal.js';
import { fromMarshalRecord } from '../../src/wire/record.js';
import { corpus } from '../support/corpus.js';

const decodeAll = (bytes: Uint8Array, chunkSize: number) => {
  const decoder = createMarshalDecoder();
  const records = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    records.push(...decoder.push(bytes.subarray(offset, offset + chunkSize)));
  }
  decoder.end();
  return records.map(fromMarshalRecord);
};

const fixture = (name: string) => {
  const found = corpus.get(name);
  if (found === undefined) throw new Error(`Missing fixture ${name}`);
  return fixtureStdout(found);
};

describe('marshal decoder', () => {
  it('decodes every marshal capture identically however its output is split', () => {
    for (const [name, capture] of corpus) {
      if (capture.mode !== 'marshal') continue;
      const bytes = fixtureStdout(capture);
      const whole = decodeAll(bytes, bytes.length || 1);
      for (const size of [1, 3, 7, 64]) expect({ name, records: decodeAll(bytes, size) }).toEqual({ name, records: whole });
    }
  });

  it('keeps printed content as exact bytes', () => {
    const records = decodeAll(fixture('print-marshal-binary'), 4096);
    const content = records.flatMap((record) => record._tag === 'data' && record.fields.code === 'binary' ? [record.fields.data] : []);
    expect(content[0]).toEqual(new TextEncoder().encode('full binary\0data'));
  });

  it('decodes text fields and classifies messages', () => {
    const records = decodeAll(fixture('print-marshal-batch'), 4096);
    const stats = records.flatMap((record) => record._tag === 'data' && record.fields.code === 'stat' ? [record.fields.depotFile] : []);
    expect(stats).toEqual(['//p4ts/main/wire/text.txt', '//p4ts/main/wire/full.uasset', '//p4ts/main/wire/wide.txt']);
    const messages = records.flatMap((record) => record._tag === 'message' ? [record.message.reason] : []);
    expect(messages).toEqual(['no_such_file']);
  });

  it('rejects output that is not marshal data, and output ending inside a record', () => {
    expect(() => createMarshalDecoder().push(new TextEncoder().encode('{"json":1}'))).toThrow();
    const decoder = createMarshalDecoder();
    decoder.push(fixture('print-marshal-text').subarray(0, 10));
    expect(() => decoder.end()).toThrow();
  });
});
