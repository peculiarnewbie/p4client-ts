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
  'annotate-integrations', 'changes-empty', 'changes-multi-scope', 'changes-pending-empty',
  'changes-pending-long', 'changes-pending', 'changes-shelved-empty', 'changes-shelved',
  'client-spec', 'client-unknown', 'client-version', 'command-timeout', 'describe-pending',
  'describe-submitted-shelved-flag', 'describe-submitted', 'diff-not-opened', 'diff-opened-json',
  'diff-opened', 'diff2-bad-revision-plain', 'diff2-empty',
  'diff2-normal-json', 'diff2-normal-marshal', 'diff2-normal', 'diff2-shelved',
  'exclusive-edit-failure', 'filelog-integrations', 'filelog-move', 'filelog-wildcard-limit',
  'files-at-unknown-change', 'files-existing', 'files-mixed', 'files-permission', 'files-symlink',
  'fstat-mixed-missing', 'fstat-reserved', 'fstat-size', 'fstat-unresolved', 'have-not-on-client',
  'info-json', 'info-short-json', 'info-unknown-user', 'info-zprog', 'modes-json-empty',
  'modes-marshal-empty', 'modes-marshal-files', 'modes-tagged-empty', 'modes-tagged-files',
  'opened-default', 'opened-move', 'opened-other-client', 'opened-unchanged-json',
  'opened-unchanged-marshal', 'opened-unchanged-tagged', 'print-empty', 'print-json-binary',
  'print-json', 'print-marshal-missing',
  'print-marshal-utf16', 'print-materialize', 'print-utf16',
  'property-empty', 'reconcile-data', 'reconcile-modtime', 'reconcile-progress-large',
  'reconcile-progress', 'reconcile-writable', 'resolve-preview', 'settings', 'status-preview',
  'stream-import-spec', 'stream-spec', 'streams-empty', 'sync-force-preview', 'sync-keep-preview',
  'sync-opened-new-head-marshal', 'sync-opened-new-head-tagged', 'sync-os-error-preview',
  'sync-os-error', 'sync-outside-stream', 'users-mixed', 'where-mixed', 'where-reserved',
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
    expect(missing).toEqual([]);
  });

  it('drops allowlist entries once a test covers them or the capture is removed', () => {
    const stale = [...UNREFERENCED].filter((name) => !fixtures.includes(name) || isReferenced(name));
    expect(stale).toEqual([]);
  });
});
