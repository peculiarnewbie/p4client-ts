import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import { P4CommandError } from "../src/public/errors.js";
import type { P4CommandExecutor, P4CommandResult } from "../src/public/types.js";

function ok(command: string, args: string[], lines: string[]): P4CommandResult {
  return { command, args, stdout: lines.join("\n"), stderr: "", exitCode: 0 };
}

describe("P4Client depot browsing", () => {
  it("lists top-level depots", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"name\":\"depot\",\"type\":\"local\",\"map\":\"depot/...\",\"desc\":\"Default depot\\n\"}",
          "{\"name\":\"stream\",\"type\":\"stream\",\"map\":\"stream/...\"}"
        ]);
      }
    });

    await expect(p4.listDepots()).resolves.toEqual([
      {
        name: "depot",
        depotPath: "//depot",
        type: "local",
        map: "depot/...",
        description: "Default depot"
      },
      {
        name: "stream",
        depotPath: "//stream",
        type: "stream",
        map: "stream/...",
        description: null
      }
    ]);

    expect(calls).toEqual([["-Mj", "-z", "tag", "depots"]]);
  });

  it("lists immediate subdirectories and applies a client-side bound", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"dir\":\"//depot/main/art\"}",
          "{\"dir\":\"//depot/main/code\"}",
          "{\"dir\":\"//depot/main/docs\"}"
        ]);
      }
    });

    await expect(
      p4.listDepotDirs({ depotPath: "//depot/main/", maxResults: 2 })
    ).resolves.toEqual({
      items: [
        { depotDir: "//depot/main/art", name: "art" },
        { depotDir: "//depot/main/code", name: "code" }
      ],
      hasMore: true
    });

    expect(calls).toEqual([["-Mj", "-z", "tag", "dirs", "//depot/main/*"]]);
  });

  it("treats a no-such-file warning as an empty directory listing", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ({
        command,
        args,
        stdout: "{\"data\":\"//depot/empty/* - no such file(s).\",\"generic\":17,\"severity\":2,\"code\":\"error\"}",
        stderr: "",
        exitCode: 1
      })
    });

    await expect(p4.listDepotDirs({ depotPath: "//depot/empty" })).resolves.toEqual({
      items: [],
      hasMore: false
    });
  });

  it("raises for error-level messages such as a protection failure", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ({
        command,
        args,
        stdout: "{\"data\":\"You don't have permission for this operation.\",\"severity\":3,\"code\":\"error\"}",
        stderr: "",
        exitCode: 1
      })
    });

    await expect(p4.listDepotDirs({ depotPath: "//depot/secret" })).rejects.toBeInstanceOf(P4CommandError);
  });

  it("lists immediate files at head and excludes deletes by default without a server bound", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"rev\":\"7\",\"change\":\"120\",\"action\":\"edit\",\"type\":\"text\"}",
          "{\"depotFile\":\"//depot/main/logo.png\",\"rev\":\"2\",\"change\":\"90\",\"action\":\"add\",\"type\":\"binary\"}",
          "{\"depotFile\":\"//depot/main/old.txt\",\"rev\":\"3\",\"change\":\"110\",\"action\":\"delete\",\"type\":\"text\"}"
        ]);
      }
    });

    await expect(
      p4.listDepotFiles({ depotPath: "//depot/main", maxResults: 10 })
    ).resolves.toEqual({
      items: [
        {
          depotFile: "//depot/main/foo.txt",
          name: "foo.txt",
          revision: 7,
          action: "edit",
          type: "text",
          changelist: 120,
          isDeletedAtHead: false,
          isBinary: false
        },
        {
          depotFile: "//depot/main/logo.png",
          name: "logo.png",
          revision: 2,
          action: "add",
          type: "binary",
          changelist: 90,
          isDeletedAtHead: false,
          isBinary: true
        }
      ],
      hasMore: false
    });

    // No server-side `-m`: bounding is client-side so delete filtering stays exact.
    expect(calls).toEqual([["-Mj", "-z", "tag", "files", "//depot/main/*"]]);
  });

  it("reports exact hasMore when excluding deletes, ignoring filtered rows", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, [
          "{\"depotFile\":\"//depot/main/a.txt\",\"rev\":\"1\",\"action\":\"add\",\"type\":\"text\"}",
          "{\"depotFile\":\"//depot/main/gone.txt\",\"rev\":\"2\",\"action\":\"delete\",\"type\":\"text\"}",
          "{\"depotFile\":\"//depot/main/b.txt\",\"rev\":\"1\",\"action\":\"add\",\"type\":\"text\"}",
          "{\"depotFile\":\"//depot/main/c.txt\",\"rev\":\"1\",\"action\":\"add\",\"type\":\"text\"}"
        ])
    });

    // Three live files, bound to 2 -> hasMore true; the deleted row must not
    // consume a slot or corrupt the flag.
    await expect(
      p4.listDepotFiles({ depotPath: "//depot/main", maxResults: 2 })
    ).resolves.toMatchObject({
      items: [{ name: "a.txt" }, { name: "b.txt" }],
      hasMore: true
    });
  });

  it("uses the server-side bound when including deletes and pins to a change", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/old.txt\",\"rev\":\"3\",\"change\":\"110\",\"action\":\"delete\",\"type\":\"text\"}"
        ]);
      }
    });

    await expect(
      p4.listDepotFiles({
        depotPath: "//depot/main",
        atChange: 200,
        maxResults: 5,
        deletedFiles: "include"
      })
    ).resolves.toMatchObject({
      items: [{ depotFile: "//depot/main/old.txt", isDeletedAtHead: true }],
      hasMore: false
    });

    expect(calls).toEqual([["-Mj", "-z", "tag", "files", "-m", "6", "//depot/main/*@200"]]);
  });

  it("returns only deleted files when requested", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"rev\":\"7\",\"action\":\"edit\",\"type\":\"text\"}",
          "{\"depotFile\":\"//depot/main/old.txt\",\"rev\":\"3\",\"action\":\"delete\",\"type\":\"text\"}"
        ])
    });

    await expect(
      p4.listDepotFiles({ depotPath: "//depot/main", deletedFiles: "only" })
    ).resolves.toMatchObject({
      items: [{ name: "old.txt", isDeletedAtHead: true }],
      hasMore: false
    });
  });

  it("rejects a depot path that contains a wildcard", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ok(command, args, [])
    });

    await expect(p4.listDepotFiles({ depotPath: "//depot/main/..." })).rejects.toThrow(
      "depotPath must be a depot directory"
    );
  });
});

describe("P4Client statFiles", () => {
  it("batches specs into one fstat call and derives out-of-date state", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          [
            "{\"depotFile\":\"//depot/main/foo.txt\",\"clientFile\":\"C:\\\\ws\\\\foo.txt\",",
            "\"isMapped\":\"\",\"headAction\":\"edit\",\"headType\":\"text\",\"headRev\":\"9\",",
            "\"headChange\":\"120\",\"headTime\":\"1742266870\",\"haveRev\":\"7\"}"
          ].join(""),
          "{\"depotFile\":\"//depot/main/bar.txt\",\"headAction\":\"delete\",\"headRev\":\"4\",\"haveRev\":\"4\"}",
          [
            "{\"depotFile\":\"//depot/main/baz.txt\",\"headAction\":\"edit\",\"headRev\":\"2\",",
            "\"haveRev\":\"2\",\"action\":\"edit\",\"change\":\"default\",",
            "\"otherOpen\":\"1\",\"otherOpen0\":\"maya@Maya_ws\",\"otherLock\":\"\"}"
          ].join("")
        ]);
      }
    });

    const stats = await p4.statFiles({
      fileSpec: ["//depot/main/foo.txt", "//depot/main/bar.txt", "//depot/main/baz.txt"]
    });

    expect(stats[0]).toMatchObject({
      depotFile: "//depot/main/foo.txt",
      localFile: "C:\\ws\\foo.txt",
      isMapped: true,
      headRevision: 9,
      headChange: 120,
      headTimeIso: "2025-03-18T03:01:10.000Z",
      haveRevision: 7,
      isDeletedAtHead: false,
      isOutOfDate: true,
      openAction: null,
      openChangelist: null,
      otherOpen: [],
      otherLocked: false
    });

    // Deleted at head while still synced is also out of date.
    expect(stats[1]).toMatchObject({
      depotFile: "//depot/main/bar.txt",
      isDeletedAtHead: true,
      isOutOfDate: true
    });

    // Concurrent open by another workspace, and open here on the default CL.
    expect(stats[2]).toMatchObject({
      depotFile: "//depot/main/baz.txt",
      isOutOfDate: false,
      openAction: "edit",
      openChangelist: "default",
      otherOpen: ["maya@Maya_ws"],
      otherLocked: true
    });

    expect(calls).toEqual([
      [
        "-Mj",
        "-z",
        "tag",
        "fstat",
        "//depot/main/foo.txt",
        "//depot/main/bar.txt",
        "//depot/main/baz.txt"
      ]
    ]);
  });

  it("passes field selection, size opt-in, and limit flags", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"headRev\":\"9\",\"fileSize\":\"2048\",\"digest\":\"ABC123\"}"
        ]);
      }
    });

    await expect(
      p4.statFiles({
        fileSpec: "//depot/main/*",
        fields: ["headRev", "fileSize", "digest"],
        includeFileSize: true,
        maxResults: 50
      })
    ).resolves.toMatchObject([
      { depotFile: "//depot/main/foo.txt", fileSize: 2048, digest: "ABC123" }
    ]);

    expect(calls).toEqual([
      [
        "-Mj",
        "-z",
        "tag",
        "fstat",
        "-m",
        "50",
        "-Ol",
        "-T",
        "headRev fileSize digest",
        "//depot/main/*"
      ]
    ]);
  });

  it("forwards an abort signal to the executor", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const p4 = new P4Client({
      executor: async (command, args, options) => {
        seenSignal = options.signal;
        return ok(command, args, ["{\"depotFile\":\"//depot/main/foo.txt\",\"headRev\":\"1\"}"]);
      }
    });

    await p4.statFiles({ fileSpec: "//depot/main/*", signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
