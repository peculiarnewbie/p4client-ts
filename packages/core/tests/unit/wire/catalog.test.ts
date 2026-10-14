import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { corpusReasons } from '../../../scripts/wire-reasons.js';
import { MESSAGE_CATALOG, decodeMessageCode, messageKey } from '../../../src/wire/catalog.js';
import { matchTemplate } from '../../../src/wire/template.js';
import { WIRE_ROOT, corpus, corpusRecords } from '../../support/corpus.js';

/** Codes seen in the corpus that deliberately rely on their generic code. None yet. */
const KNOWN_GENERIC_ONLY = new Set<string>([]);

const messages = [...corpus].flatMap(([name, fixture]) =>
  corpusRecords(fixture).flatMap(({ record }) =>
    record._tag === 'message' ? [{ name, message: record.message }] : [],
  ),
);
const coded = messages.filter(({ message }) => message.code !== null);

describe('message catalog against the wire corpus', () => {
  it('finds coded messages in the corpus', () => {
    expect(coded.length).toBeGreaterThan(30);
  });

  it('unpacks code0 consistently with the severity and generic fields sent beside it', () => {
    for (const { name, message } of coded) {
      expect({ name, severity: message.code?.severity, generic: message.code?.generic })
        .toEqual({ name, severity: Number(message.raw.severity), generic: Number(message.raw.generic) });
    }
  });

  it('catalogs every message code the corpus contains', () => {
    const uncataloged = coded
      .map(({ name, message }) => ({ name, key: messageKey(message.code!) }))
      .filter(({ key }) => !MESSAGE_CATALOG.has(key) && !KNOWN_GENERIC_ONLY.has(key));
    expect(uncataloged).toEqual([]);
  });

  it('recovers template arguments from every templated message', () => {
    // Multi-part messages print the primary part last.
    const primary = (text: string) => text.split('\n').at(-1) ?? '';
    const unmatched = messages
      .filter(({ message }) => message.template !== null && matchTemplate(message.template, primary(message.text)) === null)
      .map(({ name, message }) => ({ name, template: message.template, text: message.text }));
    expect(unmatched).toEqual([]);
  });

  it('classifies every corpus message as recorded in _reasons.json', () => {
    const golden: unknown = JSON.parse(readFileSync(join(WIRE_ROOT, '_reasons.json'), 'utf8'));
    expect(corpusReasons()).toEqual(golden as Record<string, string[]>);
  });

  it('uses the exact message code layout', () => {
    expect(decodeMessageCode(824320004)).toEqual({
      severity: 3, argc: 1, generic: 34, subsystem: 8, subcode: 4,
    });
  });
});

describe('text classification stays confined', () => {
  it('keeps English message patterns in wire/fallback.ts only', () => {
    const source = join(import.meta.dir, '../../../src');
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          // The pre-0.13 modules are deleted at cutover.
          if (!['public', 'internal'].includes(entry.name)) walk(path);
        } else if (path.endsWith('.ts') && !path.endsWith(join('wire', 'fallback.ts'))) {
          // Comments may quote the templates they document; code may not match on them.
          const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
          if (/such file|up-to-date|session has expired|must refer to client|not opened on/i.test(code)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(source);
    expect(offenders).toEqual([]);
  });
});
