import { Predicate } from 'effect';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIRE_ROOT, corpus, corpusRecords } from '../tests/support/corpus.js';

/** Reasons recognized for each message in the corpus, in output order. */
export function corpusReasons(): Map<string, readonly string[]> {
  const reasons = new Map<string, readonly string[]>();

  for (const [name, fixture] of corpus) {
    const found = corpusRecords(fixture).flatMap(({ record }) =>
      Predicate.isTagged(record, 'message') ? [`${record.message.reason} (${record.message.reasonSource})`] : [],
    );

    if (found.length > 0) reasons.set(name, found);
  }

  return reasons;
}

if (import.meta.main) {
  // Review the diff of this file: every change is a classification change.
  writeFileSync(join(WIRE_ROOT, '_reasons.json'), `${JSON.stringify(Object.fromEntries(corpusReasons()), null, 2)}\n`);
  console.log('Wrote tests/fixtures/wire/_reasons.json.');
}
