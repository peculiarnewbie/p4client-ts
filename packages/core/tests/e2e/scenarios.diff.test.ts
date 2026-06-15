import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
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
    if (numberedChange !== null) {
      await harness.run(["shelve", "-d", "-c", String(numberedChange)], {
        allowNonZeroExit: true
      });
    }
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

  it("reviews shelved changelist content without local opens", async () => {
    numberedChange = await harness.createNumberedChangelist("p4-ts e2e shelved diff inspection");
    const localPath = harness.getPath(CONFIG_PATH);

    await harness.run(["edit", "-c", String(numberedChange), localPath]);
    writeFileSync(
      localPath,
      JSON.stringify(
        {
          name: "p4-ts-fixture",
          environment: "test",
          features: {
            shelvedDiff: true
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    await harness.run(["shelve", "-c", String(numberedChange)]);
    await harness.run(["revert", "-c", String(numberedChange), localPath]);

    const shelved = await harness.client.listShelvedChangelists({
      fileSpec: "...",
      limit: 50
    });
    const description = await harness.client.describeChangelist(numberedChange, {
      shelved: true
    });
    const summary = await harness.client.getChangelistDiffSummary(numberedChange, {
      shelved: true,
      includeLineCounts: true
    });
    const opened = await harness.client.getChangelistFiles(numberedChange);
    const editedFile = description.files.find((file) => file.action === "edit");

    expect(shelved.items.some((item) => item.change === numberedChange)).toBe(true);
    expect(description.contentSource).toBe("shelved");
    expect(description.files.map((file) => file.action)).toEqual(["edit"]);
    expect(opened).toEqual([]);
    expect(summary.files[0]).toMatchObject({
      localFile: null,
      additions: expect.any(Number),
      deletions: expect.any(Number)
    });

    if (!editedFile) {
      throw new Error("Expected an edited file in the shelved changelist description.");
    }

    const diffResult = await harness.client.diffFile({
      depotFile: editedFile.depotFile,
      action: editedFile.action,
      revision: editedFile.revision,
      changelistStatus: "shelved",
      shelvedChange: numberedChange,
      type: editedFile.type,
      allowBinary: false
    });

    expect(diffResult.source).toBe("depot");
    expect(diffResult.toRevision).toBe(`@=${numberedChange}`);
    expect(diffResult.unifiedDiff.length).toBeGreaterThan(0);
    expect(diffResult.additions + diffResult.deletions).toBeGreaterThan(0);
  });
});
