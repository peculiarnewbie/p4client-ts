import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e opened files", () => {
  let numberedChange: number | null = null;

  beforeAll(async () => {
    await harness.validateSeededWorkspace();
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    numberedChange = null;
  });

  afterEach(async () => {
    await harness.cleanupWorkspace();
    if (numberedChange !== null) {
      await harness.deleteChangelistIfEmpty(numberedChange);
    }
    await harness.assertCleanWorkspace();
  });

  it("returns default and numbered changelist data from real opened files", async () => {
    numberedChange = await harness.createNumberedChangelist("p4-ts e2e opened files");
    await harness.openOpenedFilesScenario(numberedChange);

    const openedFiles = await harness.client.listOpenedFiles({});
    const defaultFiles = await harness.client.listOpenedFiles({ change: "default" });
    const numberedFiles = await harness.client.listOpenedFiles({ change: numberedChange });
    const pending = await harness.client.listChangelists({ status: 'pending', includeDefault: true });

    expect(openedFiles.items.map((entry) => String(entry.action)).sort()).toEqual(["add", "delete", "edit"]);
    expect(defaultFiles.items.map((entry) => basename(entry.clientFile ?? ""))).toEqual(["new-feature.txt"]);
    expect(numberedFiles.items.map((entry) => entry.change)).toEqual([numberedChange, numberedChange]);
    expect(numberedFiles.items.map((entry) => String(entry.action)).sort()).toEqual(["delete", "edit"]);
    expect(
      numberedFiles.items
        .map((entry) => basename(entry.clientFile ?? ""))
        .sort()
    ).toEqual(["config.json", "getting-started.md"]);

    expect(pending.items.some((entry) => entry.change === numberedChange)).toBe(true);
    expect(pending.items.some((entry) => entry.change === "default")).toBe(true);
  });
});
