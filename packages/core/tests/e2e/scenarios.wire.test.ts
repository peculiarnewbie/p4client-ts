import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { P4CommandError } from '../../src/public/errors.js';
import { loadE2EConfig } from './config.js';
import { loadFixture } from './fixture.js';
import { P4E2EHarness } from './harness.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));

describe('real Perforce message and pagination regressions', () => {
  it('parses level-only sync messages and applies a cursor to the same filespec', async () => {
    const local = harness.getPath('protocol/opened.txt');
    const depot = `${config.stream}/protocol/opened.txt`;
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, 'revision one\n');
    await harness.run(['add', local]);
    await harness.run(['submit', '-d', 'Protocol revision one']);
    const baseline = (
      await harness.client.listSubmittedChangelists({
        fileSpec: depot,
        limit: 1,
      })
    ).items[0]?.change;
    if (baseline === undefined)
      throw new Error('Missing protocol baseline change.');
    await harness.run(['edit', local]);
    writeFileSync(local, 'revision two\n');
    await harness.run(['submit', '-d', 'Protocol revision two']);
    const page = await harness.client.listSubmittedChangelists({
      fileSpec: depot,
      beforeChange: baseline,
      limit: 5,
    });
    expect(page.items.map((item) => item.change)).toEqual([baseline]);
    await harness.run(['sync', `${depot}#1`]);
    await harness.run(['edit', local]);
    try {
      const preview = await harness.client.previewSync({ fileSpec: depot });
      expect(preview.totalCount).toBe(0);
      expect(preview.messages?.map((message) => message.reason)).toContain(
        'opened_unchanged',
      );
      expect(
        preview.messages?.every((message) => message.severity === null),
      ).toBe(true);
      const watched = harness.client.watchSync({ fileSpec: depot });
      const messages: string[] = [];
      for await (const event of watched.events) {
        if (event.type === 'message') messages.push(event.message.reason);
      }
      expect(messages).toContain('opened_unchanged');
      expect((await watched.result).totalCount).toBe(0);
    } finally {
      await harness.run(['revert', local]);
      await harness.run(['sync', depot]);
    }
  });
  it('turns a zero-exit unknown changelist into a typed failure', async () => {
    await expect(
      harness.client.describeChangelist(999999),
    ).rejects.toBeInstanceOf(P4CommandError);
    await expect(
      harness.client.describeChangelist(999999),
    ).rejects.toMatchObject({
      reason: 'unknown_changelist',
      result: { exitCode: 0 },
    });
  });
});
