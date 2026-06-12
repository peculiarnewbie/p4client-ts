import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture, validateFixtureMetadata } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const CONFIG_PATH = "src/app/config.json";

const state = loadE2EConfig();
const diffDescribe = describe.skipIf(!state.enabled || !state.config.allowOpenedScenarios);

diffDescribe("p4-ts e2e diff inspection", () => {
  if (!state.enabled) {
    return;
  }

  const fixture = loadFixture(state.config);
  const harness = new P4E2EHarness(state.config, fixture);
  let numberedChange: number | null = null;

  beforeAll(async () => {
    validateFixtureMetadata(state.config, fixture);
    await harness.validateProvisionedFixture();
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

  it("describes a numbered changelist and returns a non-empty diff after edit", async () => {
    numberedChange = await harness.createNumberedChangelist("p4-ts e2e diff inspection");
    await harness.openOpenedFilesScenario(numberedChange);

    const description = await harness.client.describeChangelist(numberedChange);
    const summary = await harness.client.getChangelistDiffSummary(numberedChange);
    const editedFile = description.files.find((file) => file.action === "edit");

    expect(description.change).toBe(numberedChange);
    expect(description.status).toBe("pending");
    expect(description.files.map((file) => file.action).sort()).toEqual(["delete", "edit"]);
    expect(summary.files.some((file) => file.patchLoadState === "deferred")).toBe(true);

    if (!editedFile) {
      throw new Error("Expected an edited file in the changelist description.");
    }

    const opened = await harness.client.getChangelistFiles(numberedChange);
    const openedEdit = opened.find((file) => file.action === "edit");
    const printResult = await harness.client.printFile(editedFile.depotFile, { revision: "have" });
    const diffResult = await harness.client.diffFile({
      depotFile: editedFile.depotFile,
      localFile: openedEdit?.localFile ?? undefined,
      type: editedFile.type
    });

    expect(printResult.isBinary).toBe(false);
    expect(printResult.content.length).toBeGreaterThan(0);
    expect(diffResult.exitCode).toBeLessThanOrEqual(1);
    expect(diffResult.unifiedDiff.length).toBeGreaterThan(0);
    expect(diffResult.additions + diffResult.deletions).toBeGreaterThan(0);
    expect(basename(openedEdit?.localFile ?? "")).toBe(CONFIG_PATH.split("/").pop());
  });
});
