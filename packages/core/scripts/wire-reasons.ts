import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIRE_ROOT, corpus, corpusRecords } from '../tests/support/corpus.js';

/** Reasons recognized for each message in the corpus, in output order. */
export function corpusReasons(): Record<string, string[]> {
  const reasons: Record<string, string[]> = {};
  for (const [name, fixture] of corpus) {
    const found = corpusRecords(fixture).flatMap(({ record }) =>
      record._tag === 'message' ? [`${record.message.reason} (${record.message.reasonSource})`] : [],
    );
    if (found.length > 0) reasons[name] = found;
  }
  return reasons;
}

if (import.meta.main) {
  // Review the diff of this file: every change is a classification change.
  writeFileSync(join(WIRE_ROOT, '_reasons.json'), `${JSON.stringify(corpusReasons(), null, 2)}\n`);
  console.log('Wrote tests/fixtures/wire/_reasons.json.');
}
