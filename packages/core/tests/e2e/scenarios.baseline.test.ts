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
    const environment = await harness.client.getEnvironment({ refresh: true });

    expect(environment.p4Client).toBe(config.client);
    expect(environment.hostName.length).toBeGreaterThan(0);
    expect(environment.p4User).toBe(config.user);
    expect(environment.p4Port).toBe(config.p4Port);
  });

  it("lists the configured workspace as current", async () => {
    const workspaces = await harness.client.listWorkspaces({ refresh: true });
    const workspace = workspaces.find((entry) => entry.client === config.client);

    expect(workspace).toBeDefined();
    expect(workspace?.isCurrentClient).toBe(true);
    expect(workspace?.stream).toBe(config.stream);
    expect(workspace?.root).toBe(config.workspaceRoot);
  });

  it("has no reconcile candidates or opened files after cleanup", async () => {
    const reconcilePreview = await harness.client.previewReconcile({ fileSpec: "..." });
    const openedFiles = await harness.client.getOpenedFiles();

    expect(reconcilePreview).toEqual({
      added: [],
      edited: [],
      deleted: []
    });
    expect(openedFiles).toEqual([]);
  });

  it("returns either no pending changelists or only default", async () => {
    const pending = await harness.client.listPendingChangelists({ includeDefault: true });

    expect(pending.every((entry) => entry.isDefault)).toBe(true);
  });

  it("has no pending sync items after syncing to head", async () => {
    const preview = await harness.previewSync();

    expect(preview.items).toEqual([]);
    expect(preview.totalCount).toBe(0);
  });
});
