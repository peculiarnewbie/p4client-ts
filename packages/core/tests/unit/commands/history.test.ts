import { describe, expect, it } from 'bun:test';
import { annotateFile } from '../../../src/commands/annotate.js';
import { followMoves, getFileHistory } from '../../../src/commands/history.js';
import { commandArgs, scriptedExecutor } from '../../../src/testing/executor.js';
import { fixtureStdout } from '../../../src/testing/fixture.js';
import { argvCase, argvTable, failure, fixtures, replay, run, watch } from './support.js';
import type { P4FileRevision } from '../../../src/commands/history.js';
import type { P4DepotPath } from '../../../src/schemas.js';

const TAG = ['-Mj', '-z', 'tag'];

/**
 * Serve a fixture's output to an invocation with different arguments: for
 * captures whose argument order or `-m` value the operation does not use.
 */
function serve(name: string, args: readonly string[]) {
  const [fixture] = fixtures(name);
  return scriptedExecutor((invocation) => {
    expect(commandArgs(invocation.args)).toEqual([...args]);
    return { stdout: fixtureStdout(fixture!), stderr: fixture!.stderr, exitCode: fixture!.exitCode };
  });
}

const rows = (...records: object[]) => records.map((record) => JSON.stringify(record)).join('\n');

/** `filelog -i` of a file branched from `//d/main/foo.txt`, its ancestor cut at the branch point. */
const BRANCHED = rows(
  {
    depotFile: '//d/dev/foo.txt',
    rev0: '3', change0: '202', action0: 'edit', time0: '1742266870',
    rev1: '2', change1: '201', action1: 'edit', time1: '1742266000',
    rev2: '1', change2: '200', action2: 'branch', time2: '1742265000',
    'how2,0': 'branch from', 'file2,0': '//d/main/foo.txt', 'srev2,0': '#none', 'erev2,0': '#2',
  },
  {
    depotFile: '//d/main/foo.txt',
    rev0: '2', change0: '150', action0: 'edit', time0: '1742100000', desc0: 'Main edit\n',
    'how0,0': 'branch into', 'file0,0': '//d/dev/foo.txt', 'srev0,0': '#none', 'erev0,0': '#1',
    rev1: '1', change1: '140', action1: 'add', time1: '1742000000',
  },
);

const path = (value: string) => value as P4DepotPath;
const ids = (revisions: readonly P4FileRevision[]) => revisions.map((revision) => `${revision.depotFile}#${revision.revision}`);

describe('history operations: argv', () => {
  argvTable([
    argvCase('history reads full descriptions', getFileHistory, { file: '//d/a.txt' }, [[...TAG, 'filelog', '-l', '//d/a.txt']]),
    argvCase('history asks each path for one revision more than the limit', getFileHistory, { file: '//d/a.txt', limit: 9 }, [
      [...TAG, 'filelog', '-l', '-m', '10', '//d/a.txt'],
    ]),
    argvCase('history follows branches with -i', getFileHistory, { file: '//d/a.txt', followBranches: true, limit: 1 }, [
      [...TAG, 'filelog', '-l', '-i', '-m', '2', '//d/a.txt'],
    ]),
    argvCase('annotate reports changelists, quietly', annotateFile, { file: '//d/a.txt' }, [
      [...TAG, 'annotate', '-q', '-c', '//d/a.txt'],
    ]),
    argvCase('annotate follows integrations with -I', annotateFile, { file: '//d/a.txt', followIntegrations: true }, [
      [...TAG, 'annotate', '-q', '-c', '-I', '//d/a.txt'],
    ]),
    argvCase('annotate treats a bare revision as #n', annotateFile, { file: '//d/a.txt', revision: 3 }, [
      [...TAG, 'annotate', '-q', '-c', '//d/a.txt#3'],
    ]),
    argvCase('annotate keeps a revision specifier', annotateFile, { file: '//d/a.txt', revision: '@12' }, [
      [...TAG, 'annotate', '-q', '-c', '//d/a.txt@12'],
    ]),
  ]);
});

describe('getFileHistory', () => {
  it('reads a revision with its full description', async () => {
    const history = await run(getFileHistory, { file: '//p4ts/main/wire/text.txt', limit: 9 }, replay('filelog'));
    expect(history).toMatchObject({ depotFile: '//p4ts/main/wire/text.txt', hasMore: false, messages: [] });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      depotFile: '//p4ts/main/wire/text.txt',
      revision: 1,
      change: 4,
      action: 'add',
      type: 'text',
      submittedAt: new Date(1791937500 * 1000).toISOString(),
      user: 'p4ts-e2e',
      client: 'p4ts_e2e_client',
      digest: '2094B601DAAC3D68F5AED51D3C20F7CD',
      fileSize: 8,
      integrations: [],
    });
    expect(history.items[0]?.description).toStartWith('Wire fixture CRLF description\r\nsecond paragraph');
  });

  it('follows branches for a file that has none', async () => {
    const history = await run(getFileHistory, {
      file: '//p4ts/main/wire/text.txt', followBranches: true, limit: 9,
    }, replay('filelog-integrations'));
    expect(ids(history.items)).toEqual(['//p4ts/main/wire/text.txt#1']);
  });

  it('decodes both sides of a move and lists the pre-rename path', async () => {
    // Captured as `filelog -i -l`; the operation puts -l first.
    const history = await run(getFileHistory, { file: '//p4ts/main/wire/renamed.txt', followBranches: true }, serve(
      'filelog-move', [...TAG, 'filelog', '-l', '-i', '//p4ts/main/wire/renamed.txt'],
    ));
    expect(history.depotFile).toBe(path('//p4ts/main/wire/renamed.txt'));
    expect(ids(history.items)).toEqual([
      '//p4ts/main/wire/renamed.txt#1', '//p4ts/main/wire/text.txt#2', '//p4ts/main/wire/text.txt#1',
    ]);
    expect(history.items.map((revision) => revision.integrations)).toEqual([
      [{ how: 'moved from', file: path('//p4ts/main/wire/text.txt'), startRevision: 0, endRevision: 2 }],
      [{ how: 'moved into', file: path('//p4ts/main/wire/renamed.txt'), startRevision: 0, endRevision: 1 }],
      [],
    ]);
  });

  it('merges the files a wildcard matched, newest first, and cuts them to the limit', async () => {
    // Captured with -m 1: one revision per file, so eight files are more than a limit of 3.
    const history = await run(getFileHistory, { file: '//p4ts/main/wire/...', limit: 3 }, serve(
      'filelog-wildcard-limit', [...TAG, 'filelog', '-l', '-m', '4', '//p4ts/main/wire/...'],
    ));
    expect(ids(history.items)).toEqual([
      '//p4ts/main/wire/deleted.txt#2', '//p4ts/main/wire/clobber.txt#1', '//p4ts/main/wire/exclusive.uasset#1',
    ]);
    expect(history.hasMore).toBe(true);
  });

  it('merges branch ancestry by changelist and bounds the merged total', async () => {
    const history = await run(getFileHistory, { file: '//d/dev/foo.txt', followBranches: true, limit: 4 }, scriptedExecutor(() => ({
      stdout: BRANCHED,
    })));
    expect(history.depotFile).toBe(path('//d/dev/foo.txt'));
    expect(ids(history.items)).toEqual(['//d/dev/foo.txt#3', '//d/dev/foo.txt#2', '//d/dev/foo.txt#1', '//d/main/foo.txt#2']);
    expect(history.items[3]?.description).toBe('Main edit');
    expect(history.hasMore).toBe(true);
  });

  it('has no more when every path fits the limit', async () => {
    const history = await run(getFileHistory, { file: '//d/dev/foo.txt', followBranches: true, limit: 5 }, scriptedExecutor(() => ({
      stdout: BRANCHED,
    })));
    expect(history.items).toHaveLength(5);
    expect(history.hasMore).toBe(false);
  });

  it('reports a revision once when several records repeat it, keeping the order of equal changelists', async () => {
    const history = await run(getFileHistory, { file: '//d/a.txt', followBranches: true }, scriptedExecutor(() => ({
      stdout: rows(
        { depotFile: '//d/a.txt', rev0: '3', change0: '20', rev1: '2', change1: '20', rev2: '1' },
        { depotFile: '//d/a.txt', rev0: '2', change0: '20' },
      ),
    })));
    expect(ids(history.items)).toEqual(['//d/a.txt#3', '//d/a.txt#2', '//d/a.txt#1']);
  });

  it('gives an empty history for a file that does not exist', async () => {
    const history = await run(getFileHistory, { file: '//p4ts/main/missing.txt' }, replay('filelog-empty'));
    expect(history).toMatchObject({ depotFile: null, items: [], hasMore: false });
    expect(history.messages.map((message) => [message.reason, message.severity])).toEqual([['no_such_file', 'warning']]);
  });

  it('reports revisions as progress while filelog runs, and items once merged', async () => {
    const events = await watch(getFileHistory, { file: '//d/dev/foo.txt', followBranches: true }, scriptedExecutor(() => ({
      stdout: BRANCHED,
    })));
    expect(events.filter((event) => event._tag === 'progress').map((event) => event.progress.completed)).toEqual([3, 5]);
    expect(events.filter((event) => event._tag === 'item')).toHaveLength(5);
    expect(events.at(-1)?._tag).toBe('done');
  });

  it('rejects a non-positive limit', async () => {
    const error = await failure(getFileHistory, { file: '//d/a.txt', limit: 0 }, scriptedExecutor(() => ({})));
    expect(error).toMatchObject({ _tag: 'P4InvalidArgumentError', option: 'limit' });
  });

  it('fails on a malformed integration revision', async () => {
    const error = await failure(getFileHistory, { file: '//d/a.txt' }, scriptedExecutor(() => ({
      stdout: rows({ depotFile: '//d/a.txt', rev0: '1', 'how0,0': 'moved from', 'file0,0': '//d/b.txt', 'srev0,0': 'x', 'erev0,0': '#1' }),
    })));
    expect(error).toMatchObject({ _tag: 'P4ParseError' });
  });
});

describe('followMoves', () => {
  it('follows a rename back to the path the file was moved from', async () => {
    const history = await run(getFileHistory, { file: '//p4ts/main/wire/renamed.txt', followBranches: true }, serve(
      'filelog-move', [...TAG, 'filelog', '-l', '-i', '//p4ts/main/wire/renamed.txt'],
    ));
    const lineage = followMoves(history);
    expect(lineage.paths).toEqual([path('//p4ts/main/wire/renamed.txt'), path('//p4ts/main/wire/text.txt')]);
    expect(ids(lineage.items)).toEqual([
      '//p4ts/main/wire/renamed.txt#1', '//p4ts/main/wire/text.txt#2', '//p4ts/main/wire/text.txt#1',
    ]);
  });

  it('does not follow branches', async () => {
    const history = await run(getFileHistory, { file: '//d/dev/foo.txt', followBranches: true }, scriptedExecutor(() => ({
      stdout: BRANCHED,
    })));
    const lineage = followMoves(history);
    expect(lineage.paths).toEqual([path('//d/dev/foo.txt')]);
    expect(ids(lineage.items)).toEqual(['//d/dev/foo.txt#3', '//d/dev/foo.txt#2', '//d/dev/foo.txt#1']);
  });

  it('stops at the move into a reused path and only takes the source up to the move', async () => {
    const history = await run(getFileHistory, { file: '//d/b.txt' }, scriptedExecutor(() => ({
      stdout: rows(
        {
          depotFile: '//d/b.txt',
          rev0: '3', change0: '30', action0: 'edit',
          rev1: '2', change1: '25', action1: 'move/add',
          'how1,0': 'moved from', 'file1,0': '//d/a.txt', 'srev1,0': '#none', 'erev1,0': '#2',
          rev2: '1', change2: '5', action2: 'add',
        },
        { depotFile: '//d/a.txt', rev0: '3', change0: '25', action0: 'move/delete', rev1: '2', change1: '20', action1: 'edit', rev2: '1', change2: '10', action2: 'add' },
      ),
    })));
    const lineage = followMoves(history);
    expect(lineage.paths).toEqual([path('//d/b.txt'), path('//d/a.txt')]);
    expect(ids(lineage.items)).toEqual(['//d/b.txt#3', '//d/b.txt#2', '//d/a.txt#2', '//d/a.txt#1']);
  });

  it('is empty for an empty history', () => {
    expect(followMoves({ depotFile: null, items: [] })).toEqual({ paths: [], items: [] });
  });
});

describe('annotateFile', () => {
  it('annotates each line with the changelist that last changed it', async () => {
    const annotation = await run(annotateFile, { file: '//p4ts/main/wire/text.txt' }, replay('annotate'));
    expect(annotation).toEqual({
      depotFile: path('//p4ts/main/wire/text.txt'),
      revision: 1,
      change: 4,
      action: 'add' as never,
      type: 'text',
      lines: [
        { line: 1, change: 4, text: 'one', depotFile: null },
        { line: 2, change: 4, text: 'two', depotFile: null },
      ],
      messages: [],
    });
  });

  it('names the file each line came from when following integrations', async () => {
    const annotation = await run(annotateFile, { file: '//p4ts/main/wire/text.txt', followIntegrations: true }, replay('annotate-integrations'));
    expect(annotation.lines.map((line) => [line.line, line.change, line.depotFile])).toEqual([
      [1, 4, path('//p4ts/main/wire/text.txt')],
      [2, 4, path('//p4ts/main/wire/text.txt')],
    ]);
  });

  it('attributes a line to the change that introduced it, not the newest it survived', async () => {
    const annotation = await run(annotateFile, { file: '//d/a.txt' }, scriptedExecutor(() => ({
      stdout: rows(
        { depotFile: '//d/a.txt', rev: '2', change: '9', action: 'edit', type: 'text' },
        { data: 'kept\n', lower: '4', upper: '9' },
        { data: 'new\n', lower: '9', upper: '9' },
      ),
    })));
    expect(annotation.lines.map((line) => [line.text, line.change])).toEqual([['kept', 4], ['new', 9]]);
  });

  it('reports lines as items', async () => {
    const events = await watch(annotateFile, { file: '//p4ts/main/wire/text.txt' }, replay('annotate'));
    expect(events.flatMap((event) => (event._tag === 'item' ? [event.item.text] : []))).toEqual(['one', 'two']);
  });

  it('gives no lines for a file that does not exist', async () => {
    const annotation = await run(annotateFile, { file: '//p4ts/main/missing.txt' }, replay('annotate-empty'));
    expect(annotation).toMatchObject({ depotFile: null, revision: null, lines: [] });
    expect(annotation.messages.map((message) => message.reason)).toEqual(['no_such_file']);
  });
});
