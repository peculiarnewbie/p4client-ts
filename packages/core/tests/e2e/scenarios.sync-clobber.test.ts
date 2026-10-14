import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadE2EConfig } from "./config.js";
import { loadFixture } from "./fixture.js";
import { P4E2EHarness } from "./harness.js";
import type { P4OperationEvent, P4SyncItem, P4SyncResult } from '../../src/index.js';

const config = loadE2EConfig();
const harness = new P4E2EHarness(config, loadFixture(config));
const NOCLOBBER_CLIENT = "p4ts_e2e_noclobber";
const NOCLOBBER_ROOT = join(dirname(config.workspaceRoot), "noclobber-client");
const FILE_SPEC = `${config.stream}/clobber/...`;
const TARGET = "clobber/target.txt";
const OTHER = "clobber/other.txt";
const LOCAL_CONTENT = "local writable edit\n";
const workspace = harness.createWorkspaceClient(NOCLOBBER_ROOT, NOCLOBBER_CLIENT);

/** Synced files are read-only in a noallwrite workspace; make them removable first. */
function removeWorkspaceFiles(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o666);
  }
  rmSync(directory, { recursive: true, force: true });
}

describe("p4-ts e2e sync with a writable file that is not opened", () => {
  beforeAll(async () => {
    await harness.validateSeededWorkspace();
    for (const [relativePath, content] of [[TARGET, "target #1\n"], [OTHER, "other #1\n"]] as const) {
      mkdirSync(dirname(harness.getPath(relativePath)), { recursive: true });
      writeFileSync(harness.getPath(relativePath), content, "utf8");
    }
    await harness.run(["add", harness.getPath(TARGET), harness.getPath(OTHER)]);
    await harness.run(["submit", "-d", "p4-ts E2E clobber fixture"]);

    // The canonical fixture client allows clobbering; Perforce's default and this client do not.
    mkdirSync(NOCLOBBER_ROOT, { recursive: true });
    await harness.run(["client", "-i"], {
      input: [
        `Client: ${NOCLOBBER_CLIENT}`,
        `Owner: ${config.user}`,
        `Root: ${NOCLOBBER_ROOT}`,
        "Options: noallwrite noclobber nocompress unlocked nomodtime rmdir",
        "LineEnd: local",
        `Stream: ${config.stream}`,
        ""
      ].join("\n")
    });
    await workspace.sync({ fileSpec: FILE_SPEC });

    // Make the synced file writable without opening it, as Unreal does, then change it.
    const local = join(NOCLOBBER_ROOT, TARGET);
    chmodSync(local, 0o666);
    writeFileSync(local, LOCAL_CONTENT, "utf8");

    // A newer revision of both files arrives from the fixture client.
    await harness.run(["edit", harness.getPath(TARGET), harness.getPath(OTHER)]);
    writeFileSync(harness.getPath(TARGET), "target #2\n", "utf8");
    writeFileSync(harness.getPath(OTHER), "other #2\n", "utf8");
    await harness.run(["submit", "-d", "p4-ts E2E clobber head"]);
  });

  afterAll(async () => {
    await harness.run(["client", "-d", NOCLOBBER_CLIENT], { allowNonZeroExit: true });
    removeWorkspaceFiles(NOCLOBBER_ROOT);
  });

  it("previews both updates, then reports the clobber per file when syncing", async () => {
    const localTarget = join(NOCLOBBER_ROOT, TARGET);

    // Perforce checks for clobbers only when it writes a file, so a preview cannot see one.
    const preview = await workspace.previewSync({ fileSpec: FILE_SPEC });
    expect(preview.items.map((item) => [item.depotFile, item.action])).toEqual(
      expect.arrayContaining([
        [`${config.stream}/${TARGET}`, "updated"],
        [`${config.stream}/${OTHER}`, "updated"]
      ])
    );
    expect(preview.items.length).toBe(2);
    expect(preview.failures).toEqual([]);

    const result = await workspace.sync({ fileSpec: FILE_SPEC });
    expect(result.items.map((item) => String(item.depotFile))).toContain(`${config.stream}/${OTHER}`);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ spec: localTarget, reason: 'clobber' });
    // `LineEnd: local` writes CRLF on Windows.
    expect(readFileSync(join(NOCLOBBER_ROOT, OTHER), "utf8").replace(/\r\n/g, "\n")).toBe("other #2\n");
    expect(readFileSync(localTarget, "utf8")).toBe(LOCAL_CONTENT);

    // The watched form classifies the same row the same way, and streams it as it arrives.
    const handle = workspace.watch.sync({ fileSpec: FILE_SPEC });
    const events: P4OperationEvent<P4SyncItem, P4SyncResult>[] = [];
    for await (const event of handle.events) events.push(event);
    const watched = await handle.result;
    expect(watched.failures).toEqual(result.failures);
    expect(events.filter((event) => event._tag === 'failure')).toEqual(
      result.failures.map((failure) => ({ _tag: 'failure', failure }))
    );
    expect(readFileSync(localTarget, "utf8")).toBe(LOCAL_CONTENT);
  });
});
