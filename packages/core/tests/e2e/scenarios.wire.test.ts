import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { P4CommandError } from '../../src/errors.js';
import { loadE2EConfig } from './config.js';
import { loadFixture } from './fixture.js';
import { P4E2EHarness } from './harness.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));

describe('real Perforce message and pagination regressions', () => {
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
