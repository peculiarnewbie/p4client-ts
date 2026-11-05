import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";
import { P4CommandError, P4ReadOnlyError } from "../../src/errors.js";
import { expectFailure, rejectionOf } from "../support/assert.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

const CONFIG_PATH = "src/app/config.json";
const NEW_FEATURE_PATH = "src/app/new-feature.txt";
const EXCLUSIVE_PATH = "exclusive/lock.uasset";
const EXCLUSIVE_DEPOT = `${config.stream}/${EXCLUSIVE_PATH}`;
const SECOND_CLIENT = "p4ts_e2e_exclusive";
const SECOND_ROOT = mkdtempSync(join(tmpdir(), "p4ts-e2e-exclusive-"));

describe("p4-ts e2e typed mutations", () => {
  let created: number | null = null;

  beforeAll(async () => {
    await harness.validateSeededWorkspace();

    // An exclusive (+l) asset, as in an Unreal project, held by a second workspace.
    if (!(await harness.depotFileExists(EXCLUSIVE_DEPOT))) {
      mkdirSync(harness.getPath("exclusive"), { recursive: true });
      writeFileSync(harness.getPath(EXCLUSIVE_PATH), "exclusive\0asset");
      await harness.run(["add", "-t", "binary+l", harness.getPath(EXCLUSIVE_PATH)]);
      await harness.run(["submit", "-d", "p4-ts E2E exclusive asset"]);
    }

    await harness.run(["client", "-i"], {
      input: [
        `Client: ${SECOND_CLIENT}`,
        `Owner: ${config.user}`,
        `Root: ${SECOND_ROOT}`,
        "Options: allwrite clobber nocompress unlocked nomodtime rmdir",
        "LineEnd: local",
        `Stream: ${config.stream}`,
        "",
      ].join("\n"),
    });
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    created = null;
  });

  afterEach(async () => {
    if (created !== null) {
      await harness.run(["revert", "-c", String(created), "//..."], { allowNonZeroExit: true });
      await harness.deleteChangelistIfEmpty(created);
    }

    await harness.cleanupWorkspace();
    await harness.assertCleanWorkspace();
  });

  afterAll(async () => {
    const second = harness.createWorkspaceClient(SECOND_ROOT, SECOND_CLIENT);
    await second.revert({ fileSpec: EXCLUSIVE_DEPOT });
    await harness.run(["client", "-d", SECOND_CLIENT], { allowNonZeroExit: true });
    rmSync(SECOND_ROOT, { recursive: true, force: true });
  });

  it("creates a changelist, opens files in it, reverts them and deletes it", async () => {
    const client = harness.client;
    const change = await client.createChange({ description: "p4-ts e2e typed mutations\nsecond line" });
    created = change.change;

    const edited = await client.openForEdit({ fileSpec: harness.getPath(CONFIG_PATH), change: change.change });
    expect(edited.items.map((file) => [String(file.action), basename(file.clientFile ?? "")])).toEqual([["edit", "config.json"]]);
    const again = await client.openForEdit({ fileSpec: harness.getPath(CONFIG_PATH), change: change.change });
    expect(again.messages.map((message) => message.reason)).toEqual(["already_opened"]);

    writeFileSync(harness.getPath(NEW_FEATURE_PATH), "p4-ts e2e typed add\n", "utf8");
    const preview = await client.previewOpenForAdd({ fileSpec: harness.getPath(NEW_FEATURE_PATH), change: change.change });
    expect(preview.items).toHaveLength(1);
    expect((await client.listOpenedFiles({ change: change.change })).items).toHaveLength(1);
    const added = await client.openForAdd({ fileSpec: harness.getPath(NEW_FEATURE_PATH), change: change.change, type: "text" });
    expect(added.items.map((file) => String(file.action))).toEqual(["add"]);

    const described = await client.describeChangelist({ change: change.change });
    expect(described.description).toBe("p4-ts e2e typed mutations\nsecond line");
    expect(described.files.map((file) => basename(file.depotFile)).sort()).toEqual(["config.json", "new-feature.txt"]);

    expectFailure(await rejectionOf(client.deleteChange({ change: change.change })), P4CommandError, { reason: "changelist_not_empty" });

    expect((await client.previewRevert({ change: change.change })).items).toHaveLength(2);
    expect((await client.listOpenedFiles({ change: change.change })).items).toHaveLength(2);
    const reverted = await client.revert({ change: change.change });
    expect(reverted.items.map((file) => file.action).sort()).toEqual(["abandoned", "reverted"]);

    await client.deleteChange({ change: change.change });
    created = null;
    const pending = await client.listChangelists({ status: "pending", includeDefault: false });
    expect(pending.items.some((entry) => entry.change === change.change)).toBe(false);
  });

  it("stops at an exclusive file another workspace has open, naming the holder", async () => {
    const second = harness.createWorkspaceClient(SECOND_ROOT, SECOND_CLIENT);
    await second.sync({ fileSpec: EXCLUSIVE_DEPOT });
    expect((await second.openForEdit({ fileSpec: EXCLUSIVE_DEPOT })).items).toHaveLength(1);

    const preview = await harness.client.previewOpenForEdit({ fileSpec: EXCLUSIVE_DEPOT });
    const attempt = await harness.client.openForEdit({ fileSpec: EXCLUSIVE_DEPOT });

    for (const result of [preview, attempt]) {
      expect(result.items).toEqual([]);
      expect(result.failures).toMatchObject([{
        spec: EXCLUSIVE_DEPOT,
        reason: "exclusive_open",
        heldBy: [`${config.user}@${SECOND_CLIENT}`],
      }]);
    }

    expect((await harness.client.listOpenedFiles({ fileSpec: EXCLUSIVE_DEPOT })).items).toEqual([]);
    await second.revert({ fileSpec: EXCLUSIVE_DEPOT });
  });

  it("refuses every mutation on a read-only client, creating nothing", async () => {
    const readOnly = harness.client.with({ allowMutation: false });

    try {
      const before = await readOnly.listChangelists({ status: "pending", includeDefault: false });
      expectFailure(await rejectionOf(readOnly.createChange({ description: "must not exist" })), P4ReadOnlyError);
      expectFailure(await rejectionOf(readOnly.openForEdit({ fileSpec: harness.getPath(CONFIG_PATH) })), P4ReadOnlyError);
      expectFailure(await rejectionOf(readOnly.revert({ fileSpec: harness.getPath(CONFIG_PATH) })), P4ReadOnlyError);
      const after = await readOnly.listChangelists({ status: "pending", includeDefault: false });
      expect(after.items).toEqual(before.items);
      expect((await readOnly.previewOpenForEdit({ fileSpec: harness.getPath(CONFIG_PATH) })).items).toHaveLength(1);
    } finally {
      await readOnly.dispose();
    }
  });

  it("describes several changelists past one that does not exist", async () => {
    const submitted = await harness.client.listChangelists({ status: "submitted", limit: 2 });
    const [newer, older] = submitted.items.map((entry) => entry.change);
    const described = await harness.client.describeChangelists({ changes: [older!, 999_999, newer!] });
    expect(described.items.map((entry) => entry.change)).toEqual([older!, newer!]);
    expect(described.failures).toMatchObject([{ spec: "999999", reason: "unknown_changelist" }]);
  });

  it("materializes binary revisions from a batch byte-identically to per-file prints", async () => {
    const files = await harness.client.listFiles({ fileSpec: [EXCLUSIVE_DEPOT, `${config.stream}/${CONFIG_PATH}`] });
    const fileSpec = files.items.map((file) => ({ depotFile: file.depotFile, revision: file.revision ?? 1 }));
    const batched = mkdtempSync(join(tmpdir(), "p4ts-e2e-batch-"));
    const each = mkdtempSync(join(tmpdir(), "p4ts-e2e-each-"));

    try {
      const fromBatch = await harness.client.materializeDepotFiles({ fileSpec, directory: batched, maxFiles: 2, batch: true });
      const perFile = await harness.client.materializeDepotFiles({ fileSpec, directory: each, maxFiles: 2 });
      expect(fromBatch.items.map((item) => [basename(item.localPath), item.method])).toEqual([
        ["lock.uasset", "batch"],
        ["config.json", "print"],
      ]);

      for (const [index, item] of fromBatch.items.entries()) {
        expect(readFileSync(item.localPath)).toEqual(readFileSync(perFile.items[index]!.localPath));
      }
    } finally {
      rmSync(batched, { recursive: true, force: true });
      rmSync(each, { recursive: true, force: true });
    }
  });
});
