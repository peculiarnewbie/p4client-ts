import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e sync preview", () => {
  beforeAll(async () => {
    await harness.validateSeededWorkspace();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    await harness.prepareBehindHeadWorkspace();
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
