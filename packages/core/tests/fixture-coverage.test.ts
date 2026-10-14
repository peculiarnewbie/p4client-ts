import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const testsRoot = import.meta.dir;
const wireRoot = join(testsRoot, 'fixtures/wire');

/**
 * Captures no test names yet. This list may only shrink: a new capture must be
 * asserted by a test when it is added, and an existing one leaves this list once
 * a test covers it.
 */
const UNREFERENCED = new Set([
  'changes-empty', 'changes-pending-empty', 'changes-pending', 'changes-shelved-empty',
  'client-spec', 'client-unknown', 'client-version', 'info-unknown-user', 'info-zprog',
  'modes-marshal-empty', 'modes-marshal-files', 'modes-tagged-empty', 'modes-tagged-files',
  'opened-unchanged-marshal', 'opened-unchanged-tagged', 'sync-opened-new-head-marshal',
  'sync-opened-new-head-tagged',
]);

function testSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return relative(testsRoot, path) === 'fixtures' ? [] : testSources(path);
    // This file names every allowlisted capture, so it cannot count as a reference.
    return entry.name.endsWith('.ts') && path !== import.meta.path ? [readFileSync(path, 'utf8')] : [];
  });
}

const fixtures = readdirSync(wireRoot)
  .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
  .map((name) => name.slice(0, -'.json'.length));
const sources = testSources(testsRoot).join('\n');
const isReferenced = (name: string): boolean =>
  sources.includes(`'${name}'`) || sources.includes(`"${name}"`) || sources.includes(`${name}.json`);

describe('wire fixture coverage', () => {
  it('names every capture in at least one test, apart from the shrinking allowlist', () => {
    const missing = fixtures.filter((name) => !UNREFERENCED.has(name) && !isReferenced(name));
    expect(missing.join(', ')).toBe('');
  });

  it('drops allowlist entries once a test covers them or the capture is removed', () => {
    const stale = [...UNREFERENCED].filter((name) => !fixtures.includes(name) || isReferenced(name));
    expect(stale.join(', ')).toBe('');
  });
});
