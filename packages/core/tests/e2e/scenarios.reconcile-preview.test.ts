import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e reconcile preview", () => {
  beforeAll(async () => {
    await harness.validateSeededWorkspace();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
  });

  afterEach(async () => {
    await harness.cleanupWorkspace();
    await harness.assertCleanWorkspace();
  });

  it("detects added, edited, and deleted files from local mutations", async () => {
    harness.createReconcilePreviewScenario();

    const preview = await harness.client.previewReconcile({ fileSpec: "..." });

    expect(preview.edited.map((entry) => basename(entry.localFile ?? ""))).toContain("config.json");
    expect(preview.deleted.map((entry) => basename(entry.localFile ?? ""))).toContain("getting-started.md");
    expect(preview.added.map((entry) => basename(entry.localFile ?? ""))).toContain("new-feature.txt");
  });
});
