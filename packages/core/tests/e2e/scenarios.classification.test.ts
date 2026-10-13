import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P4CommandError } from '../../src/public/errors.js';
import { loadE2EConfig } from './config.js';
import { loadFixture } from './fixture.js';
import { P4E2EHarness } from './harness.js';
import type { P4DepotPath, P4SyncProgressEvent } from '../../src/public/types.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));

describe('real Perforce rows classified alike by sibling methods', () => {
  it('rejects a missing revision in materializeDepotFiles as printFile does', async () => {
    const depotFile = `${config.stream}/README.md` as P4DepotPath;
    const directory = mkdtempSync(join(tmpdir(), 'p4-ts-e2e-materialize-'));
    try {
      await expect(harness.client.printFile(depotFile, { revision: 999 })).rejects.toMatchObject({
        reason: 'unknown_revision'
      });
      const materialized = harness.client.materializeDepotFiles({
        directory,
        maxFiles: 1,
        files: [{ depotFile, revision: 999 }]
      });
      await expect(materialized).rejects.toBeInstanceOf(P4CommandError);
      await expect(materialized).rejects.toMatchObject({ reason: 'unknown_revision' });
      expect(existsSync(join(directory, 'p4ts', 'main', 'README.md'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails a watched sync outside the client without announcing the failure as a notice', async () => {
    const fileSpec = '//other/...';
    await expect(harness.client.sync({ fileSpec })).rejects.toMatchObject({ reason: 'not_in_view' });

    const handle = harness.client.watchSync({ fileSpec });
    const events: P4SyncProgressEvent[] = [];
    // The event stream fails with the same error; collect events until then.
    const consumed = (async () => {
      for await (const event of handle.events) events.push(event);
    })().catch(() => undefined);
    await expect(handle.result).rejects.toMatchObject({ reason: 'not_in_view' });
    await consumed;
    expect(events.filter((event) => event.type === 'message')).toEqual([]);
  });
});
