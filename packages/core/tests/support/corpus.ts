import { join } from 'node:path';
import { fixtureStdout, readWireFixtures } from '../../src/testing/fixture.js';
import { createMarshalDecoder } from '../../src/wire/marshal.js';
import { fromMarshalRecord, readJsonLine, toWireRecord } from '../../src/wire/record.js';
import type { P4WireFixture } from '../../src/testing/fixture.js';
import type { WireRecord } from '../../src/wire/record.js';

/** Directory of captured wire fixtures. */
export const WIRE_ROOT = join(import.meta.dir, '../fixtures/wire');

/** Every command capture in the corpus, by name. */
export const corpus: ReadonlyMap<string, P4WireFixture> = readWireFixtures(WIRE_ROOT);

/** A structured record from a fixture, with the stream it came from. */
export interface CorpusRecord {
  readonly source: 'stdout' | 'stderr';
  readonly record: WireRecord;
}

function jsonRecords(text: string, source: CorpusRecord['source']): CorpusRecord[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim().startsWith('{')) return [];
    const result = readJsonLine(line);
    return result.ok ? [{ source, record: toWireRecord(result.fields) }] : [];
  });
}

/**
 * Structured records in a fixture: `-Mj` lines on either stream, and `-G`
 * dictionaries on stdout. Plain-text lines are not included.
 */
export function corpusRecords(fixture: P4WireFixture): CorpusRecord[] {
  const stdout = fixture.mode === 'marshal'
    ? createMarshalDecoder().push(fixtureStdout(fixture))
      .map((record) => ({ source: 'stdout' as const, record: fromMarshalRecord(record) }))
    : jsonRecords(fixture.stdout ?? '', 'stdout');
  return [...stdout, ...jsonRecords(fixture.stderr, 'stderr')];
}
