import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { P4CommandError } from '../../src/errors.js';
import { loadE2EConfig } from './config.js';
import { loadFixture } from './fixture.js';
import { P4E2EHarness } from './harness.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));

describe('real Perforce message and pagination regressions', () => {
  it('retains valid files beside missing paths in files, fstat and print', async () => {
    const file = `${config.stream}/src/app/config.json`;
    const missing = `${config.stream}/protocol/__missing__.txt`;
    for (const result of [
      await harness.client.listFiles({ fileSpec: [file, missing] }),
      await harness.client.statFiles({ fileSpec: [file, missing] }),
      await harness.client.printBatch({ fileSpec: [file, missing] }),
    ]) {
      expect(result.items).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ spec: missing, reason: 'no_such_file' });
    }
  });
  it('materializes real files and rejects deleted revisions without replacing old output', async () => {
    const local = harness.getPath('protocol/materialized.txt');
    const depot = `${config.stream}/protocol/materialized.txt`;
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, 'materialize bytes\n');
    await harness.run(['add', local]);
    await harness.run(['submit', '-d', 'Materialize trial fixture']);
    const directory = harness.getPath('materialize-output');
    mkdirSync(directory, { recursive: true });
    const options = { directory, maxFiles: 1 };
    const printed = await harness.client.materializeDepotFiles({
      ...options, fileSpec: [{ depotFile: depot, revision: 1, change: 42 }],
    });
    const output = printed.items[0]!;
    expect(existsSync(output.localPath)).toBe(true);
    expect(readFileSync(output.localPath, 'utf8').replaceAll('\r\n', '\n')).toBe('materialize bytes\n');
    expect(output.file.change).toBe(42);
    await harness.run(['delete', local]);
    await harness.run(['submit', '-d', 'Delete materialize trial fixture']);
    await expect(harness.client.materializeDepotFiles({
      ...options, fileSpec: [{ depotFile: depot, revision: 2 }],
    })).rejects.toMatchObject({ _tag: 'P4MaterializationError', reason: 'missing_output' });
    expect(readFileSync(output.localPath, 'utf8').replaceAll('\r\n', '\n')).toBe('materialize bytes\n');
    const fresh = join(directory, 'fresh');
    mkdirSync(fresh);
    await expect(harness.client.materializeDepotFiles({
      directory: fresh, maxFiles: 1, fileSpec: [{ depotFile: depot, revision: 2 }],
    })).rejects.toMatchObject({ _tag: 'P4MaterializationError', reason: 'missing_output' });
  });
  it('retains valid stats beside a missing-revision warning', async () => {
    const result = await harness.client.statFiles({
      fileSpec: [
        `${config.stream}/src/app/config.json#999999`,
        `${config.stream}/docs/guide/getting-started.md`,
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      reason: 'unknown_revision',
    });
  });
  it('distinguishes an unsynced have revision from an empty text file', async () => {
    const local = harness.getPath('protocol/empty.txt');
    const depot = `${config.stream}/protocol/empty.txt`;
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, '');
    await harness.run(['add', local]);
    await harness.run(['submit', '-d', 'Protocol empty text fixture']);
    expect((await harness.client.printFile({ file: depot })).content).toHaveLength(0);
    await harness.run(['sync', `${depot}#none`]);
    try {
      await expect(harness.client.printFile({ file: depot, revision: 'have' })).rejects.toBeInstanceOf(
        P4CommandError,
      );
      expect(
        (await harness.client.printFile({ file: depot, revision: 'head' })).content,
      ).toHaveLength(0);
    } finally {
      await harness.run(['sync', depot]);
    }
  });
  it('parses level-only sync messages and applies a cursor to the same filespec', async () => {
    const local = harness.getPath('protocol/opened.txt');
    const depot = `${config.stream}/protocol/opened.txt`;
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, 'revision one\n');
    await harness.run(['add', local]);
    await harness.run(['submit', '-d', 'Protocol revision one']);
    const baseline = (
      await harness.client.listChangelists({ status: 'submitted',
        fileSpec: depot,
        limit: 1,
      })
    ).items[0]?.change;
    if (baseline === undefined)
      throw new Error('Missing protocol baseline change.');
    await harness.run(['edit', local]);
    writeFileSync(local, 'revision two\n');
    await harness.run(['submit', '-d', 'Protocol revision two']);
    const page = await harness.client.listChangelists({ status: 'submitted',
      fileSpec: depot,
      cursor: Number(baseline),
      limit: 5,
    });
    expect(page.items.map((item) => item.change)).toEqual([baseline]);
    await harness.run(['sync', `${depot}#1`]);
    await harness.run(['edit', local]);
    try {
      const preview = await harness.client.previewSync({ fileSpec: depot });
      expect(preview.items.length).toBe(0);
      expect(preview.messages?.map((message) => message.reason)).toContain(
        'opened_unchanged',
      );
      expect(
        preview.messages?.every((message) => message.severity === 'info'),
      ).toBe(true);
      const watched = harness.client.watch.sync({ fileSpec: depot });
      const messages: string[] = [];
      for await (const event of watched.events) {
        if (event._tag === 'message') messages.push(event.message.reason);
      }
      expect(messages).toContain('opened_unchanged');
      expect((await watched.result).items.length).toBe(0);
    } finally {
      await harness.run(['revert', local]);
      await harness.run(['sync', depot]);
    }
  });
  it('turns a zero-exit unknown changelist into a typed failure', async () => {
    await expect(
      harness.client.describeChangelist({ change: 999999 }),
    ).rejects.toBeInstanceOf(P4CommandError);
    await expect(
      harness.client.describeChangelist({ change: 999999 }),
    ).rejects.toMatchObject({
      reason: 'unknown_changelist',
      exitCode: 0,
    });
  });
});
