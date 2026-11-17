import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Predicate, Stream } from "effect";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";
import type { P4Invocation } from "../../src/index.js";
import type { P4PromiseClient } from "../../src/promise/index.js";

const config = loadE2EConfig();
const fixture = loadFixture(config);
const harness = new P4E2EHarness(config, fixture);

const ROOT = "plugin-reads";
const MANY_COUNT = 200;
const manyPath = (index: number) => `${ROOT}/many/Content_Hero_Locomotion_Sprint_${String(index).padStart(3, "0")}.txt`;
const depot = (relativePath: string) => `${config.stream}/${relativePath}`;
const ASSET = `${ROOT}/Hero_Sprint.uasset`;
const ASSET_SIZE = 8 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const SECOND_CLIENT = "p4ts_e2e_plugin_second";

/** Deterministic, poorly compressible asset content. */
const assetBytes = (): Uint8Array => {
  const bytes = new Uint8Array(ASSET_SIZE);
  let state = 0x2545f491;

  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }

  return bytes;
};

/** Long depot paths that match nothing, as a watcher's list of candidates would. */
const missing = (count: number) => Array.from({ length: count }, (_, index) =>
  depot(`Content/Characters/Hero/Animations/Locomotion/Sprint/Variants/AS_Hero_Sprint_Variant_${String(index).padStart(4, "0")}.uasset`));

/** Undo `-x - -b N`: put the file arguments back on the command line, where a short list goes. */
function onCommandLine(invocation: P4Invocation): P4Invocation {
  const at = invocation.args.indexOf("-x");

  if (at < 0 || invocation.args[at + 1] !== "-" || invocation.args[at + 2] !== "-b") return invocation;
  const files = (invocation.input ?? "").split("\n").filter((line) => line !== "");

  return { ...invocation, args: [...invocation.args.slice(0, at), ...invocation.args.slice(at + 4), ...files], input: undefined };
}

const usesStdin = (invocation: P4Invocation) => invocation.args.includes("-x");

async function seed(): Promise<void> {
  if (!(await harness.depotFileExists(depot(manyPath(MANY_COUNT - 1))))) {
    for (let index = 0; index < MANY_COUNT; index += 1) {
      const path = harness.getPath(manyPath(index));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `plugin reads ${index}\n`, "utf8");
    }

    await harness.run(["add", harness.getPath(`${ROOT}/many/...`)]);
    await harness.run(["submit", "-d", "p4-ts E2E plugin reads: many files"]);
  }

  if (!(await harness.depotFileExists(depot(ASSET)))) {
    writeFileSync(harness.getPath(ASSET), assetBytes());
    await harness.run(["add", "-t", "binary+l", harness.getPath(ASSET)]);
    await harness.run(["submit", "-d", "p4-ts E2E plugin reads: large exclusive asset"]);
  }
}

describe("p4-ts e2e plugin reads", () => {
  let stdinCalls: P4Invocation[] = [];
  let argvCalls: P4Invocation[] = [];
  let viaStdin: P4PromiseClient;
  let viaArgv: P4PromiseClient;

  beforeAll(async () => {
    await harness.validateSeededWorkspace();
    await seed();

    viaStdin = harness.createWorkspaceClient(config.workspaceRoot, undefined, (run) => (invocation) => {
      stdinCalls.push(invocation);

      return run(invocation);
    });

    viaArgv = harness.createWorkspaceClient(config.workspaceRoot, undefined, (run) => (invocation) => {
      argvCalls.push(invocation);

      return run(onCommandLine(invocation));
    });
  });

  beforeEach(async () => {
    await harness.cleanupWorkspace();
    stdinCalls = [];
    argvCalls = [];
  });

  afterAll(async () => {
    await harness.cleanupWorkspace();
  });

  it("reads 500 long file specs, past the Windows command-line limit", async () => {
    const present = [0, 1, 2, 3, 4].map((index) => depot(manyPath(index)));
    const specs = [...present, ...missing(495)];
    expect(specs.reduce((length, spec) => length + spec.length + 3, 0)).toBeGreaterThan(32_767);

    const stats = await harness.client.statFiles({ fileSpec: specs });
    expect(stats.items.map((item) => String(item.depotFile))).toEqual(present);
    expect(stats.failures).toHaveLength(495);
    expect(new Set(stats.failures.map((failure) => failure.reason))).toEqual(new Set(["no_such_file"]));

    const files = await harness.client.listFiles({ fileSpec: specs });
    expect(files.items.map((item) => String(item.depotFile))).toEqual(present);
    expect(files.failures).toHaveLength(495);

    const mapped = await harness.client.whereFiles({ fileSpec: specs });
    expect(mapped.items).toHaveLength(500);

    const have = await harness.client.listHaveFiles({ fileSpec: specs });
    expect(have.items.map((item) => String(item.depotFile))).toEqual(present);
    expect(have.failures).toHaveLength(495);

    const opened = await harness.client.listOpenedFiles({ fileSpec: specs });
    expect(opened.items).toEqual([]);

    const preview = await harness.client.previewSync({ fileSpec: specs });
    expect(preview.items).toEqual([]);
    expect(preview.failures).toEqual([]);

    const changes = await harness.client.listChangelists({ status: "submitted", fileSpec: specs, limit: "all" });
    expect(changes.items.map((change) => change.description)).toContain("p4-ts E2E plugin reads: many files");
  });

  it("reads the same items, failures and messages from stdin as from the command line", async () => {
    // Over the command-line budget, so it goes on stdin, yet short enough for Windows to run as arguments.
    const specs = [...Array.from({ length: 100 }, (_, index) => depot(manyPath(index))), ...missing(40)];
    const length = specs.reduce((total, spec) => total + spec.length + 3, 0);
    expect(length).toBeGreaterThan(8_000);
    expect(length).toBeLessThan(28_000);

    const same = async <R>(name: string, read: (client: P4PromiseClient) => Promise<R>) => {
      stdinCalls = [];
      argvCalls = [];
      const fromStdin = await read(viaStdin);
      const fromArgv = await read(viaArgv);

      expect(stdinCalls.length, name).toBeGreaterThan(0);
      expect(stdinCalls.every(usesStdin), name).toBe(true);
      expect(argvCalls.map(onCommandLine).some(usesStdin), name).toBe(false);
      expect(fromStdin, name).toEqual(fromArgv);
    };

    await same("statFiles", (client) => client.statFiles({ fileSpec: specs }));
    await same("listFiles", (client) => client.listFiles({ fileSpec: specs, limit: 120 }));
    await same("whereFiles", (client) => client.whereFiles({ fileSpec: specs }));
    await same("listHaveFiles", (client) => client.listHaveFiles({ fileSpec: specs }));
    await same("listOpenedFiles", (client) => client.listOpenedFiles({ fileSpec: specs }));
    await same("previewSync", (client) => client.previewSync({ fileSpec: specs }));
    await same("listChangelists", (client) => client.listChangelists({ status: "submitted", fileSpec: specs, limit: "all" }));
  });

  it("syncs a long list from stdin with one set of totals, as the command line does", async () => {
    const specs = Array.from({ length: MANY_COUNT }, (_, index) => depot(manyPath(index)));
    const length = specs.reduce((total, spec) => total + spec.length + 3, 0);
    expect(length).toBeGreaterThan(8_000);
    expect(length).toBeLessThan(28_000);
    await harness.run(["sync", `${harness.getPath(`${ROOT}/many`)}/...#0`]);

    const fromStdin = await viaStdin.previewSync({ fileSpec: specs });
    const fromArgv = await viaArgv.previewSync({ fileSpec: specs });
    expect(stdinCalls.every(usesStdin)).toBe(true);
    expect(fromStdin).toEqual(fromArgv);
    // With p4's default batches of 128 these totals would arrive twice, each for part of the list.
    expect(fromStdin.totalFileCount).toBe(MANY_COUNT);
    expect(fromStdin.items).toHaveLength(MANY_COUNT);

    const synced = await viaStdin.sync({ fileSpec: specs });
    expect(synced.items).toHaveLength(MANY_COUNT);
    expect(synced.totalFileCount).toBe(MANY_COUNT);
    expect(synced.totalFileSize).toBe(fromStdin.totalFileSize);
    expect((await harness.client.previewSync({ fileSpec: specs })).items).toEqual([]);
  });

  it("names the same file with a non-ASCII spec in a short list as in a long one", async () => {
    // This server is not in Unicode mode, so it keeps the bytes each client sent. Added from this
    // workspace, zz_café goes in the client's code page (cp1252 on Western Windows). On such a
    // client the cp1252 name zz_æ—¥æœ¬ is the UTF-8 bytes of zz_日本, as a UTF-8 client adds it.
    const folder = `${ROOT}/unicode-${Date.now()}`;
    mkdirSync(harness.getPath(folder), { recursive: true });
    writeFileSync(harness.getPath(`${folder}/zz_café.uasset`), "western");
    writeFileSync(harness.getPath(`${folder}/zz_æ—¥æœ¬.uasset`), "outside the code page");
    await harness.run(["add", "-t", "binary", harness.getPath(`${folder}/...`)]);
    await harness.run(["submit", "-d", "plugin reads: non-ASCII names"]);

    const names = [depot(`${folder}/zz_café.uasset`), depot(`${folder}/zz_日本.uasset`)];
    const long = [...names, ...missing(80)];
    expect(long.reduce((total, spec) => total + spec.length + 3, 0)).toBeGreaterThan(8_000);

    const shortStats = await viaStdin.statFiles({ fileSpec: names });
    stdinCalls = [];
    const longStats = await viaStdin.statFiles({ fileSpec: long });
    const longStatCalls = stdinCalls.length;
    expect(shortStats.items.map((item) => String(item.depotFile))).toEqual([expect.stringContaining("zz_caf")]);
    expect(longStats.items).toEqual(shortStats.items);
    expect(longStats.failures.slice(0, shortStats.failures.length)).toEqual(shortStats.failures);
    expect(longStats.failures).toHaveLength(shortStats.failures.length + 80);
    // The long list ran as several commands of arguments, not on stdin.
    expect(longStatCalls).toBeGreaterThan(1);

    const shortFiles = await viaStdin.listFiles({ fileSpec: names });
    const longFiles = await viaStdin.listFiles({ fileSpec: long });
    expect(longFiles.items).toEqual(shortFiles.items);
    expect(longFiles.failures.slice(0, shortFiles.failures.length)).toEqual(shortFiles.failures);

    // printBatch, which used stdin for every list, now agrees with printFile.
    const shortPrint = await viaStdin.printBatch({ fileSpec: names });
    const longPrint = await viaStdin.printBatch({ fileSpec: long });
    expect(longPrint.items).toEqual(shortPrint.items);
    expect(longPrint.failures.slice(0, shortPrint.failures.length)).toEqual(shortPrint.failures);

    for (const name of names) {
      const single = await viaStdin.printFile({ file: name }).catch(() => null);
      const batched = shortPrint.items.find((item) => item.file.depotFile === single?.depotFile);
      expect(batched?.content ?? null, name).toEqual(single?.content ?? null);
    }

    expect(stdinCalls.some(usesStdin)).toBe(false);
  });

  it("prints only the first bytes of a large revision and stops reading", async () => {
    let stdoutBytes = 0;
    let sawExit = false;

    const watched = harness.createWorkspaceClient(config.workspaceRoot, undefined, (run) => (invocation) =>
      run(invocation).pipe(Stream.tap((event) => Effect.sync(() => {
        if (Predicate.isTagged(event, "stdout")) stdoutBytes += event.bytes.length;
        else if (Predicate.isTagged(event, "exit")) sawExit = true;
      }))));

    const expected = assetBytes();
    const head = await watched.printFile({ file: depot(ASSET), maxBytes: HEAD_BYTES });
    expect(head).toMatchObject({ depotFile: depot(ASSET), type: "binary+l", fileSize: ASSET_SIZE, isTruncated: true });
    expect(head.content).toEqual(expected.subarray(0, HEAD_BYTES));
    // p4 sends 64 KiB records; reading stopped within one of the cut, never reaching p4's exit.
    expect(stdoutBytes).toBeLessThan(HEAD_BYTES + 256 * 1024);
    expect(sawExit).toBe(false);

    stdoutBytes = 0;
    const whole = await watched.printFile({ file: depot(ASSET), maxBytes: ASSET_SIZE });
    expect(whole).toMatchObject({ fileSize: ASSET_SIZE, isTruncated: false });
    expect(whole.content).toEqual(expected);
    expect(sawExit).toBe(true);
  });

  it("reports the workspace options", async () => {
    const workspaces = await harness.client.listWorkspaces({});
    const workspace = workspaces.items.find((entry) => entry.client === config.client);

    // The fixture client: allwrite clobber nocompress unlocked nomodtime rmdir.
    expect(workspace?.options).toEqual({
      allwrite: true, clobber: true, compress: false, locked: false, modtime: false, rmdir: true, altsync: false,
    });
  });

  it("lists submitted changes and files since a change, or a date, through the workspace view", async () => {
    const [latest] = (await harness.client.listChangelists({ status: "submitted", limit: 1 })).items;
    const since = latest!.change + 1;
    const range = `${ROOT}/range-${Date.now()}`;
    const walk = harness.getPath(`${range}/A_Walk.uasset`);
    const sprint = harness.getPath(`${range}/B_Run.uasset`);
    mkdirSync(dirname(walk), { recursive: true });
    writeFileSync(walk, "walk 1");
    writeFileSync(sprint, "run 1");
    await harness.run(["add", "-t", "binary", walk, sprint]);
    await harness.run(["submit", "-d", "plugin reads: add"]);
    await harness.run(["edit", walk]);
    writeFileSync(walk, "walk 2");
    await harness.run(["submit", "-d", "plugin reads: edit"]);
    await harness.run(["delete", sprint]);
    await harness.run(["submit", "-d", "plugin reads: delete"]);

    const view = `//${config.client}`;

    const changes = await harness.client.listChangelists({
      status: "submitted", fileSpec: `${view}/...@${since},@now`, limit: "all",
    });

    expect(changes.items.map((change) => [change.change, change.description, change.client])).toEqual([
      [since + 2, "plugin reads: delete", config.client],
      [since + 1, "plugin reads: edit", config.client],
      [since, "plugin reads: add", config.client],
    ]);

    const files = await harness.client.listFiles({ fileSpec: `${view}/....uasset@${since},@now` });
    expect(files.failures).toEqual([]);
    expect(files.items.map((file) => [file.name, file.revision, file.change, file.action, file.type, file.isDeletedAtHead])).toEqual([
      ["A_Walk.uasset", 2, since + 1, "edit", "binary", false],
      ["B_Run.uasset", 2, since + 2, "delete", "binary", true],
    ]);
    expect(files.items.every((file) => file.submittedAt !== null && !Number.isNaN(Date.parse(file.submittedAt)))).toBe(true);

    const nothingNew = await harness.client.listFiles({ fileSpec: `${view}/....uasset@${since + 3},@now` });
    expect(nothingNew.items).toEqual([]);
    expect(nothingNew.failures.map((failure) => failure.reason)).toEqual(["no_such_file"]);
    expect((await harness.client.listChangelists({ status: "submitted", fileSpec: `${view}/...@${since + 3},@now`, limit: "all" })).items)
      .toEqual([]);

    // First use: a date range. A week back covers this run; a future date matches no revision.
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const date = `${weekAgo.getFullYear()}/${String(weekAgo.getMonth() + 1).padStart(2, "0")}/${String(weekAgo.getDate()).padStart(2, "0")}`;
    const byDate = await harness.client.listFiles({ fileSpec: `${view}/${range}/....uasset@${date},@now` });
    expect(byDate.items.map((file) => file.name)).toEqual(["A_Walk.uasset", "B_Run.uasset"]);
    const changesByDate = await harness.client.listChangelists({ status: "submitted", fileSpec: `${view}/${range}/...@${date},@now`, limit: "all" });
    expect(changesByDate.items.map((change) => change.change)).toEqual([since + 2, since + 1, since]);

    const future = await harness.client.listFiles({ fileSpec: `${view}/${range}/....uasset@2099/01/01,@now` });
    expect(future.items).toEqual([]);
    expect([...future.failures.map((failure) => failure.message), ...future.messages].map((message) => message.text)).toEqual([
      expect.stringContaining("no revision(s) after that date"),
    ]);
  });

  it("names the user and workspace of each other open, and flags the exclusive head type", async () => {
    const secondRoot = join(dirname(config.workspaceRoot), "plugin-reads-second");
    mkdirSync(secondRoot, { recursive: true });

    await harness.run(["client", "-i"], {
      input: [
        `Client: ${SECOND_CLIENT}`,
        `Owner: ${config.user}`,
        `Root: ${secondRoot}`,
        "Options: noallwrite noclobber nocompress unlocked nomodtime normdir",
        `Stream: ${config.stream}`,
        "",
      ].join("\n"),
    });

    try {
      await harness.run(["sync", depot(ASSET)], { client: SECOND_CLIENT, cwd: secondRoot });
      await harness.run(["edit", depot(ASSET)], { client: SECOND_CLIENT, cwd: secondRoot });

      const [stat] = (await harness.client.statFiles({ fileSpec: depot(ASSET) })).items;
      expect(stat).toMatchObject({
        headType: "binary+l",
        isExclusive: true,
        otherOpen: [`${config.user}@${SECOND_CLIENT}`],
        otherOpenedBy: [{ user: config.user, client: SECOND_CLIENT }],
        openAction: null,
      });

      // With fields, the indexed otherOpenN carry the opens; `otherOpen` alone is only their count.
      const [selected] = (await harness.client.statFiles({ fileSpec: depot(ASSET), fields: ["headType", "otherOpen0"] })).items;
      expect(selected).toMatchObject({ isExclusive: true, otherOpenedBy: [{ user: config.user, client: SECOND_CLIENT }] });

      const [plain] = (await harness.client.statFiles({ fileSpec: depot(manyPath(0)) })).items;
      expect(plain).toMatchObject({ isExclusive: false, otherOpen: [], otherOpenedBy: [] });
    } finally {
      await harness.run(["revert", depot(ASSET)], { client: SECOND_CLIENT, cwd: secondRoot, allowNonZeroExit: true });
      await harness.run(["client", "-d", SECOND_CLIENT], { allowNonZeroExit: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
