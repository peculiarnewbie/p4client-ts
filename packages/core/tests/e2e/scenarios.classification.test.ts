import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P4CommandError } from '../../src/errors.js';
import { loadE2EConfig } from './config.js';
import { loadFixture } from './fixture.js';
import { P4E2EHarness } from './harness.js';
import type { P4DepotPath, P4OperationEvent, P4SyncItem, P4SyncResult } from '../../src/index.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));

describe('real Perforce rows classified alike by sibling methods', () => {
  it('rejects a missing revision in materializeDepotFiles as printFile does', async () => {
    const depotFile = `${config.stream}/README.md` as P4DepotPath;
    const directory = mkdtempSync(join(tmpdir(), 'p4-ts-e2e-materialize-'));
    try {
      await expect(harness.client.printFile({ file: depotFile, revision: 999 })).rejects.toMatchObject({
        reason: 'unknown_revision'
      });
      const materialized = harness.client.materializeDepotFiles({
        directory,
        maxFiles: 1,
        fileSpec: [{ depotFile, revision: 999 }]
      });
      await expect(materialized).rejects.toBeInstanceOf(P4CommandError);
      await expect(materialized).rejects.toMatchObject({ reason: 'unknown_revision' });
      expect(existsSync(join(directory, 'p4ts', 'main', 'README.md'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports an outside-view spec as the same item failure in run and watch', async () => {
    const fileSpec = '//other/...';
    const result = await harness.client.sync({ fileSpec });
    expect(result.failures[0]?.reason).toBe('not_in_view');

    const handle = harness.client.watch.sync({ fileSpec });
    const events: P4OperationEvent<P4SyncItem, P4SyncResult>[] = [];
    for await (const event of handle.events) events.push(event);
    expect((await handle.result).failures).toEqual(result.failures);
    expect(events.filter((event) => event._tag === 'failure').map((event) => event.failure))
      .toEqual(result.failures);
  });
});
