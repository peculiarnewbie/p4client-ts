import { describe, expect, it } from 'bun:test';
import { Effect, Layer } from 'effect';
import { diffFile, getChangelistDiffSummary } from '../../../src/commands/diff.js';
import {
  fileAtRevision,
  isBinaryP4Type,
  parseUnifiedDiff,
  resolveDiffPlan,
  submittedDiffRevisions,
  summarizeUnifiedDiff,
} from '../../../src/commands/diff-text.js';
import { runCommand } from '../../../src/engine/command.js';
import { configLayer } from '../../../src/engine/config.js';
import { P4InvalidArgumentError } from '../../../src/errors.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { argvCase, argvTable, failure, fixtures, replay, run, watch } from './support.js';
import type { P4CommandSpec } from '../../../src/engine/command.js';

const TAG = ['-Mj', '-z', 'tag'];
const TEXT = '//p4ts/main/wire/text.txt';

const describeRow = (status: string, files: Array<[string, string, number]>) => JSON.stringify({
  change: '7', status, user: 'u', client: 'ws', desc: 'd', time: '0',
  ...Object.fromEntries(files.flatMap(([depotFile, action, rev], index) => [
    [`depotFile${index}`, depotFile], [`action${index}`, action], [`rev${index}`, String(rev)], [`type${index}`, 'text'],
  ])),
});

function collect<A>(spec: P4CommandSpec<A>, ...names: string[]) {
  return Effect.runPromise(runCommand(spec).pipe(Effect.provide(Layer.merge(replay(...names), configLayer({})))));
}

describe('diff operations: argv', () => {
  argvTable([
    argvCase('a pending file diffs the workspace with -Mj diff', diffFile, { file: '//d/a.txt' }, [
      [...TAG, 'diff', '-du', '//d/a.txt'],
    ]),
    argvCase('explicit revisions diff the depot with plain diff2', diffFile, {
      file: '//d/a.txt', fromRevision: 1, toRevision: 'head', diffFlags: ['-dw'],
    }, [['diff2', '-dw', '//d/a.txt#1', '//d/a.txt#head']]),
    argvCase('a submitted edit compares with the previous revision', diffFile, {
      file: '//d/a.txt', changelistStatus: 'submitted', action: 'edit', revision: 3,
    }, [['diff2', '-du', '//d/a.txt#2', '//d/a.txt#3']]),
    argvCase('a submitted add compares with no revision', diffFile, {
      file: '//d/a.txt', changelistStatus: 'submitted', action: 'add', revision: 1,
    }, [['diff2', '-du', '//d/a.txt#none', '//d/a.txt#1']]),
    argvCase('a shelved edit compares its base with the shelf', diffFile, {
      file: '//d/a.txt', changelistStatus: 'shelved', shelvedChange: 7, action: 'edit', revision: 1,
    }, [['diff2', '-du', '//d/a.txt#1', '//d/a.txt@=7']]),
    argvCase('a skipped binary file runs nothing', diffFile, {
      file: '//d/a.uasset', allowBinary: false, type: 'binary+F',
    }, []),
    argvCase('the default changelist summary reads one opened -c default', getChangelistDiffSummary, {
      change: 'default', client: 'ws',
    }, [[...TAG, 'opened', '-C', 'ws', '-c', 'default']]),
    argvCase('a pending summary describes the changelist, then reads its opened files', getChangelistDiffSummary, {
      change: 7,
    }, [[...TAG, 'describe', '-s', '7'], [...TAG, 'opened', '-c', '7']], () => ({
      stdout: describeRow('pending', [['//d/a.txt', 'edit', 1]]),
    })),
    argvCase('a shelved summary diffs each file against the shelf', getChangelistDiffSummary, {
      change: 7, shelved: true, includeLineCounts: true,
    }, [[...TAG, 'describe', '-S', '-s', '7'], ['diff2', '-du', '//d/a.txt#1', '//d/a.txt@=7']], (args) => ({
      stdout: args.includes('describe') ? describeRow('pending', [['//d/a.txt', 'edit', 1]]) : '',
    })),
    argvCase('a submitted summary diffs text files only', getChangelistDiffSummary, {
      change: 7, includeLineCounts: true,
    }, [[...TAG, 'describe', '-s', '7'], ['diff2', '-du', '//d/a.txt#2', '//d/a.txt#3']], (args) => ({
      stdout: args.includes('describe')
        ? describeRow('submitted', [['//d/a.txt', 'edit', 3]]).replace('}', ',"depotFile1":"//d/b.bin","action1":"add","rev1":"1","type1":"binary"}')
        : '',
    })),
  ]);
});

describe('diffFile', () => {
  it('reads a workspace diff from -Mj data rows', async () => {
    const diff = await run(diffFile, { file: TEXT }, replay('diff-opened-json'));
    expect(diff).toEqual({
      depotFile: TEXT,
      localFile: '<WORKSPACE>\\wire\\text.txt',
      source: 'workspace',
      fromRevision: null,
      toRevision: null,
      unifiedDiff: '@@ -1,2 +1,2 @@\n-one\n-two\n+one\n+changed line\n',
      isBinary: false,
      additions: 2,
      deletions: 2,
      messages: [],
    } as never);
    // Plain `diff` adds ---/+++ headers with local paths but counts the same lines.
    expect(summarizeUnifiedDiff(fixtures('diff-opened')[0]!.stdout ?? '')).toEqual({ additions: 2, deletions: 2 });
  });

  it('keeps a caller-supplied local path', async () => {
    const diff = await run(diffFile, { file: TEXT, localFile: 'C:\\ws\\text.txt' }, replay('diff-opened-json'));
    expect(diff.localFile).toBe('C:\\ws\\text.txt' as never);
  });

  it('returns an empty diff for a file that is not opened', async () => {
    const diff = await run(diffFile, { file: TEXT }, replay('diff-not-opened'));
    expect(diff).toMatchObject({ unifiedDiff: '', additions: 0, deletions: 0, localFile: null });
    expect(diff.messages.map((message) => message.reason)).toEqual(['not_opened']);
  });

  it('diffs two depot revisions with plain diff2', async () => {
    const diff = await run(diffFile, { file: TEXT, fromRevision: 1, toRevision: 2 }, replay('diff2-normal'));
    expect(diff).toMatchObject({ source: 'depot', fromRevision: 1, toRevision: 2, additions: 1, deletions: 2 });
    expect(diff.unifiedDiff).toStartWith('==== //p4ts/main/wire/text.txt#1 (text)');
  });

  it('diffs a shelved file against its base revision', async () => {
    const diff = await run(diffFile, {
      file: TEXT, changelistStatus: 'shelved', shelvedChange: 7, action: 'edit', revision: 1,
    }, replay('diff2-shelved'));
    expect(diff).toMatchObject({ fromRevision: 1, toRevision: '@=7', additions: 1, deletions: 1 });
    expect(parseUnifiedDiff(diff.unifiedDiff)).toEqual([{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+changed line', ''],
    }]);
  });

  it('fails on an invalid revision', async () => {
    const error = await failure(diffFile, {
      file: TEXT, fromRevision: 'invalid', toRevision: 1,
    }, replay('diff2-bad-revision-plain'));
    expect(error).toMatchObject({ _tag: 'P4CommandError', reason: 'invalid_revision' });
  });

  it('accepts exit 1 from an external diff tool only with hunks', async () => {
    const options = { file: '//d/a.txt', fromRevision: 1, toRevision: 2 } as const;
    const differs = await run(diffFile, options, scriptedExecutor(() => ({ stdout: '@@ -1 +1 @@\n-a\n+b\n', exitCode: 1 })));
    expect(differs).toMatchObject({ additions: 1, deletions: 1 });
    expect(await failure(diffFile, options, scriptedExecutor(() => ({ exitCode: 1 })))).toMatchObject({ _tag: 'P4CommandError' });
  });

  it('returns an empty binary diff without running p4', async () => {
    const diff = await run(diffFile, { file: '//d/a.uasset', allowBinary: false, type: 'binary+F' }, scriptedExecutor(() => {
      throw new Error('p4 must not run');
    }));
    expect(diff).toMatchObject({ isBinary: true, unifiedDiff: '', source: 'workspace', messages: [] });
  });

  it('rejects incomplete or impossible revisions', async () => {
    const none = scriptedExecutor(() => ({}));
    expect(await failure(diffFile, { file: TEXT, fromRevision: 1 }, none))
      .toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'toRevision' });
    expect(await failure(diffFile, { file: TEXT, changelistStatus: 'shelved' }, none))
      .toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'shelvedChange' });
    expect(await failure(diffFile, { file: TEXT, changelistStatus: 'submitted', action: 'edit', revision: 1 }, none))
      .toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'revision' });
    expect(await failure(diffFile, { file: 'wire/text.txt' }, none))
      .toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'file' });
  });
});

describe('diff2 output formats', () => {
  // Why depot diffs stay plain: -Mj and -G diff2 report only which files differ.
  it('-Mj and -G diff2 send a header without hunks', async () => {
    const args = ['diff2', '-du', `${TEXT}#1`, `${TEXT}#2`];
    const decode = (row: Readonly<Record<string, unknown>>) => row;
    const json = await collect({ args, format: 'json', decode }, 'diff2-normal-json');
    const marshal = await collect({ args, format: 'marshal', decode }, 'diff2-normal-marshal');
    for (const output of [json, marshal]) {
      expect(output.items).toHaveLength(1);
      expect(output.items[0]).toMatchObject({ status: 'content', rev: '1', rev2: '2' });
      expect(Object.values(output.items[0]!).some((value) => String(value).includes('@@'))).toBe(false);
    }
  });

  it('-Mj diff2 of a missing file is an empty-result warning', async () => {
    const output = await collect({
      args: ['diff2', '-du', '//p4ts/main/missing.txt#1', '//p4ts/main/missing.txt#2'], format: 'json', decode: (row) => row,
    }, 'diff2-empty');
    expect([output.items, output.messages.map((message) => message.reason)]).toEqual([[], ['no_such_file']]);
  });
});

describe('getChangelistDiffSummary', () => {
  it('summarizes the default changelist from one opened -c default, with line counts', async () => {
    const summary = await run(getChangelistDiffSummary, {
      change: 'default', includeLineCounts: true,
    }, replay('opened-default', 'diff-opened-json'));
    expect(summary.changelist).toMatchObject({ change: 'default', status: 'pending', user: 'p4ts-e2e' });
    expect(summary.files).toEqual([{
      depotFile: TEXT,
      localFile: '<WORKSPACE>\\wire\\text.txt',
      action: 'edit',
      type: 'text',
      revision: 1,
      isBinary: false,
      additions: 2,
      deletions: 2,
    }] as never);
  });

  it('summarizes shelved files against the shelf', async () => {
    const summary = await run(getChangelistDiffSummary, {
      change: 7, shelved: true, includeLineCounts: true,
    }, replay('describe-shelved', 'diff2-shelved'));
    expect(summary.changelist.status).toBe('shelved');
    expect(summary.files.map((file) => [String(file.depotFile), file.additions, file.deletions, file.localFile])).toEqual([
      [TEXT, 1, 1, null],
    ]);
  });

  it('defers line counts unless asked, reporting each file and progress', async () => {
    const events = await watch(getChangelistDiffSummary, { change: 6 }, replay('describe-submitted'));
    expect(events.map((event) => event._tag)).toEqual(['item', 'progress', 'done']);
    const done = events.at(-1);
    if (done?._tag !== 'done') throw new Error('expected done');
    expect(done.result.files).toEqual([{
      depotFile: '//p4ts/main/wire/deleted.txt',
      localFile: null,
      action: 'delete',
      type: 'text',
      revision: 2,
      isBinary: false,
      additions: null,
      deletions: null,
    }] as never);
    const progress = events.find((event) => event._tag === 'progress');
    expect(progress).toMatchObject({ progress: { completed: 1, total: 1, unit: 'files' } });
  });

  it('rejects shelved files of the default changelist', async () => {
    expect(await failure(getChangelistDiffSummary, { change: 'default', shelved: true }, scriptedExecutor(() => ({}))))
      .toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'shelved' });
  });
});

describe('diff text helpers', () => {
  it('recognizes binary file types', () => {
    expect(['binary+F', 'apple', 'resource', 'xbinary', 'ubinary'].map(isBinaryP4Type)).toEqual([true, true, true, true, true]);
    expect(['text', 'utf16', 'text+k', null, undefined].map(isBinaryP4Type)).toEqual([false, false, false, false, false]);
  });

  it('builds file specs at revisions', () => {
    expect([fileAtRevision('//d/a', 3), fileAtRevision('//d/a', 'NONE'), fileAtRevision('//d/a', '@=7')])
      .toEqual(['//d/a#3', '//d/a#none', '//d/a@=7']);
  });

  it('infers submitted revisions by action', () => {
    expect(submittedDiffRevisions({ action: 'move/delete', revision: 3 })).toEqual({ fromRevision: 2, toRevision: 'none' });
    expect(submittedDiffRevisions({ action: 'branch', revision: null })).toEqual({ fromRevision: 'none', toRevision: 'have' });
    expect(submittedDiffRevisions({ action: 'purge', revision: 3 })).toBeNull();
  });

  it('throws P4InvalidArgumentError for an unusable plan', () => {
    expect(() => resolveDiffPlan({ file: '//d/a', changelistStatus: 'shelved', shelvedChange: 1, action: 'archive' }))
      .toThrow(P4InvalidArgumentError);
  });
});
