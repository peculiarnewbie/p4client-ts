import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);
const CONFIG_DEPOT_FILE = "//p4ts/main/src/app/config.json";

describe("p4-ts e2e catalog and history", () => {
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

  it("covers real depot browsing, metadata, history, users, streams, and annotation", async () => {
    const depots = await harness.client.listDepots({});
    const directories = await harness.client.listDepotDirs({ depotPath: "//p4ts/main" });
    const files = await harness.client.listDepotFiles({ depotPath: "//p4ts/main/src/app" });
    const stats = await harness.client.statFiles({ fileSpec: CONFIG_DEPOT_FILE });
    const mappings = await harness.client.whereFiles({ fileSpec: CONFIG_DEPOT_FILE });
    const history = await harness.client.getFileHistory({
      file: CONFIG_DEPOT_FILE,
      limit: 10
    });
    const users = await harness.client.listUsers({ users: [config.user] });
    const streams = await harness.client.listStreams({ fileSpec: "//p4ts/..." });
    const annotation = await harness.client.annotateFile({ file: CONFIG_DEPOT_FILE });

    expect(depots.items.map((depot) => depot.name)).toContain("p4ts");
    expect(directories.items.map((directory) => directory.name)).toEqual(
      expect.arrayContaining(["docs", "src"])
    );
    expect(files.items.map((file) => file.name)).toEqual(
      expect.arrayContaining(["config.json", "index.txt"])
    );
    expect(stats.items).toHaveLength(1);
    expect(stats.items[0]).toMatchObject({
      depotFile: CONFIG_DEPOT_FILE,
      headRevision: expect.any(Number),
      haveRevision: expect.any(Number),
      isMapped: true
    });
    expect(mappings.items).toHaveLength(1);
    expect(mappings.items[0]?.clientFile).toMatch(/config\.json$/i);
    expect(String(history.depotFile)).toBe(CONFIG_DEPOT_FILE);
    expect(history.items.length).toBeGreaterThan(0);
    expect(users.items).toHaveLength(1);
    expect(users.items[0]).toMatchObject({ user: config.user });
    expect(streams.items.map((stream) => String(stream.stream))).toContain(config.stream);
    expect(String(annotation.depotFile)).toBe(CONFIG_DEPOT_FILE);
    expect(annotation.lines.length).toBeGreaterThan(0);
    expect(annotation.lines.some((line) => line.text.includes("p4-ts-fixture"))).toBe(true);
  });

  it("merges a real rename chain and bounds the merged total", async () => {
    let chain: { sourceDepotFile: string; targetDepotFile: string };
    try {
      chain = await harness.seedRenameChain();
    } finally {
      await harness.revertRenameChain();
    }

    const followed = await harness.client.getFileHistory({
      file: chain.targetDepotFile,
      followBranches: true
    });
    const unfollowed = await harness.client.getFileHistory({
      file: chain.targetDepotFile
    });
    const bounded = await harness.client.getFileHistory({
      file: chain.targetDepotFile,
      followBranches: true,
      limit: 2
    });

    // The rename leaves one revision on the new path and two on the old one,
    // and the head path stays the requested one rather than the ancestor.
    expect(String(followed.depotFile)).toBe(chain.targetDepotFile);
    expect(followed.items.map((revision) => String(revision.depotFile))).toEqual([
      chain.targetDepotFile,
      chain.sourceDepotFile,
      chain.sourceDepotFile
    ]);

    // Real p4 reports rename ancestry as extra rows even without `-i`, which is
    // why merging is not gated on followBranches: reading only the first row
    // dropped the pre-rename history here too.
    expect(unfollowed.items.map((revision) => String(revision.depotFile))).toContain(
      chain.sourceDepotFile
    );

    const changes = followed.items.map((revision) => revision.change);
    expect(changes.every((change) => change !== null)).toBe(true);
    expect([...changes].sort((left, right) => Number(right) - Number(left))).toEqual(changes);

    // `p4 filelog -m 2 -i` would have returned three revisions, two per path.
    expect(bounded.items).toHaveLength(2);
    expect(bounded.hasMore).toBe(true);
    expect(bounded.items).toEqual(followed.items.slice(0, 2));
  });

  it("lists exact historical revisions and materializes one through real p4", async () => {
    const historical = await harness.client.listDepotFilesAtChange({
      file: "//p4ts/main/...",
      change: config.syncBaseChange,
      limit: 50
    });
    const configFile = historical.items.find((file) => file.depotFile === CONFIG_DEPOT_FILE);

    expect(historical.hasMore).toBe(false);
    expect(configFile).toBeDefined();

    if (!configFile) {
      throw new Error(`Missing ${CONFIG_DEPOT_FILE} in baseline revision.`);
    }

    const directory = await mkdtemp(join(tmpdir(), "p4-ts-e2e-materialize-"));
    try {
      const materialized = await harness.client.materializeDepotFiles({
        directory,
        fileSpec: [configFile],
        maxFiles: 1
      });
      const content = await readFile(materialized.items[0]!.localPath, "utf8");

      expect(materialized.items.length).toBe(1);
      expect(content).toContain("p4-ts-fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
