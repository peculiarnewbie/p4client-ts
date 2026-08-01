import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e sync", () => {
  beforeAll(async () => {
    await harness.validateSeededWorkspace();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    await harness.prepareBehindHeadWorkspace();
  });

  it("supports preview-first sync workflows against a behind-head workspace", async () => {
    const previewBefore = await harness.previewSync();

    if (previewBefore.items.length === 0) {
      throw new Error(
        "Fixture workspace is already at head; sync e2e requires a behind-head workspace."
      );
    }

    const result = await harness.sync();

    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.items[0]?.depotFile ?? result.items[0]?.localFile).toBeTruthy();

    const previewAfter = await harness.previewSync();
    expect(previewAfter.items).toEqual([]);
    expect(previewAfter.totalCount).toBe(0);
  });
});
