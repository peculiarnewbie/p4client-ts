import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const CONFIG_PATH = "src/app/config.json";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

describe("p4-ts e2e diff inspection", () => {
  let numberedChange: number | null = null;

  beforeAll(async () => {
    await harness.validateSeededWorkspace();
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

  it('uses the last content revision when reviewing a submitted deletion', async () => {
    const localPath = harness.getPath('audit-deleted.txt');
    const depotFile = '//p4ts/main/audit-deleted.txt';
    writeFileSync(localPath, 'removed line\n', 'utf8');
    await harness.run(['add', localPath]);
    await harness.run(['submit', '-d', 'p4-ts deletion diff fixture add']);
    await harness.run(['delete', localPath]);
    await harness.run(['submit', '-d', 'p4-ts deletion diff fixture delete']);
    const changes = await harness.client.listChangelists({ status: 'submitted', fileSpec: depotFile, limit: 1 });
    const change = changes.items[0];
    if (!change) throw new Error('Missing submitted deletion changelist.');
    const description = await harness.client.describeChangelist({ change: change.change });
    const file = description.files[0];
    if (!file) throw new Error('Missing deleted file description.');
    expect(String(file.action)).toBe('delete');
    expect(file.revision).toBe(2);
    const diff = await harness.client.diffFile({
      depotFile,
      changelistStatus: 'submitted',
      action: file.action,
      revision: file.revision
    });
    expect(diff.fromRevision).toBe(1);
    expect(diff.toRevision).toBe('none');
    expect(diff.unifiedDiff).toContain(`${depotFile}#1`);
  });

  it("describes a numbered changelist and returns a non-empty diff after edit", async () => {
    numberedChange = await harness.createNumberedChangelist("p4-ts e2e diff inspection");
    await harness.openOpenedFilesScenario(numberedChange);

    const description = await harness.client.describeChangelist({ change: numberedChange });
    const summary = await harness.client.getChangelistDiffSummary({ change: numberedChange });
    const editedFile = description.files.find((file) => file.action === "edit");

    expect(description.change).toBe(numberedChange);
    expect(description.status).toBe("pending");
    expect(description.files.map((file) => String(file.action)).sort()).toEqual(["delete", "edit"]);
    expect(summary.files.some((file) => file.additions === null)).toBe(true);

    if (!editedFile) {
      throw new Error("Expected an edited file in the changelist description.");
    }

    const opened = await harness.client.listOpenedFiles({ change: numberedChange });
    const openedEdit = opened.items.find((file) => file.action === "edit");
    const mappings = await harness.client.whereFiles({ fileSpec: editedFile.depotFile });
    const localFile = mappings.items.find((mapping) => !mapping.isExcluded)?.localFile;
    expect(openedEdit?.depotFile).toBe(editedFile.depotFile);
    expect(localFile).toBeTruthy();
    const printResult = await harness.client.printFile({ file: editedFile.depotFile, revision: 'have' });
    const diffResult = await harness.client.diffFile({
      depotFile: editedFile.depotFile,
      localFile: localFile ?? undefined,
      type: editedFile.type
    });

    expect(printResult.isBinary).toBe(false);
    expect(printResult.content.length).toBeGreaterThan(0);
    expect(diffResult.messages).toBeArray();
    expect(diffResult.unifiedDiff.length).toBeGreaterThan(0);
    expect(diffResult.additions + diffResult.deletions).toBeGreaterThan(0);
    expect(basename(localFile ?? '')).toBe(CONFIG_PATH.split('/').pop()!);
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

    const shelved = await harness.client.listChangelists({ status: 'shelved',
      fileSpec: "...",
      limit: 50
    });
    const description = await harness.client.describeChangelist({ change: numberedChange,
      shelved: true
    });
    const summary = await harness.client.getChangelistDiffSummary({ change: numberedChange,
      shelved: true,
      includeLineCounts: true
    });
    const opened = await harness.client.listOpenedFiles({ change: numberedChange });
    const editedFile = description.files.find((file) => file.action === "edit");

    expect(shelved.items.some((item) => item.change === numberedChange)).toBe(true);
    expect(description.status).toBe("shelved");
    expect(description.files.map((file) => String(file.action))).toEqual(["edit"]);
    expect(opened.items).toEqual([]);
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
