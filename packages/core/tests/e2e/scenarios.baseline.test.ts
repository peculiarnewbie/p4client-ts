import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e baseline", () => {
  beforeAll(async () => {
    await harness.validateSeededWorkspace();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    await harness.assertCleanWorkspace();
  });

  it("resolves the configured p4 environment", async () => {
    const environment = await harness.client.getEnvironment({});

    expect(environment.client).toBe(config.client);
    expect(environment.clientHost!.length).toBeGreaterThan(0);
    expect(environment.user).toBe(config.user);
    expect(environment.port).toBe(config.p4Port);
  });

  it("lists the configured workspace as current", async () => {
    const workspaces = await harness.client.listWorkspaces({});
    const workspace = workspaces.items.find((entry) => entry.client === config.client);

    expect(workspace).toBeDefined();
    expect(workspace?.owner).toBe(config.user);
    expect(String(workspace?.stream)).toBe(config.stream);
    expect(workspace?.root).toBe(config.workspaceRoot);
  });

  it("has no reconcile candidates or opened files after cleanup", async () => {
    const reconcilePreview = await harness.client.previewReconcile({ fileSpec: "..." });
    const openedFiles = await harness.client.listOpenedFiles({});

    expect(reconcilePreview).toMatchObject({
      added: [],
      edited: [],
      deleted: []
    });
    expect(reconcilePreview.messages[0]?.reason).toBe('nothing_to_reconcile');
    expect(openedFiles.items).toEqual([]);
  });

  it("returns either no pending changelists or only default", async () => {
    const pending = await harness.client.listChangelists({ status: 'pending', includeDefault: true });

    expect(pending.items.every((entry) => entry.isDefault)).toBe(true);
  });

  it("has no pending sync items after syncing to head", async () => {
    const preview = await harness.previewSync();

    expect(preview.items).toEqual([]);
    expect(preview.items.length).toBe(0);
  });

  it('rejects a derived connection outside the isolated port before spawning', async () => {
    const redirected = harness.client.with({ connection: { port: '127.0.0.1:1' } });
    try {
      await expect(redirected.getEnvironment({})).rejects.toThrow(
        'Refusing command outside the disposable localhost server.',
      );
    } finally {
      await redirected.dispose();
    }
  });

  it('allows stdin print batches and keeps valid bytes beside an item miss', async () => {
    const printed = await harness.client.printBatch({ files: [
      `${config.stream}/src/app/config.json`,
      `${config.stream}/src/app/config.json#999999`,
    ] });
    expect(printed.items).toHaveLength(1);
    expect(printed.items[0]?.content.length).toBeGreaterThan(0);
    expect(printed.failures).toHaveLength(1);
    expect(printed.failures[0]?.reason).toBe('unknown_revision');
    expect(structuredClone(printed)).toEqual(printed);
  });
});
