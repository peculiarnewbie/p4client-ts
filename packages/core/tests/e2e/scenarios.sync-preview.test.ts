import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { loadE2EConfig } from "./config.js";
import { loadFixture, validateFixtureMetadata } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const state = loadE2EConfig();
const syncDescribe = describe.skipIf(!state.enabled || !state.config.allowSyncPreview);

syncDescribe("p4-ts e2e sync preview", () => {
  if (!state.enabled) {
    return;
  }

  const fixture = loadFixture(state.config);
  const harness = new P4E2EHarness(state.config, fixture);

  beforeAll(async () => {
    validateFixtureMetadata(state.config, fixture);
    await harness.validateProvisionedFixture();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
  });

  it("parses pending sync items when the target workspace is behind head", async () => {
    const preview = await harness.previewSync();

    if (preview.items.length === 0) {
      throw new Error(
        "Fixture workspace is already at head; sync-preview e2e requires a behind-head workspace."
      );
    }

    expect(preview.totalCount).toBe(preview.items.length);
    expect(preview.items[0]?.depotFile ?? preview.items[0]?.localFile).toBeTruthy();
  });
});
