import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import { P4CommandError } from "../src/public/errors.js";
import type { P4CommandResult } from "../src/public/types.js";

function ok(command: string, args: string[], lines: string[]): P4CommandResult {
  return { command, args, stdout: lines.join("\n"), stderr: "", exitCode: 0 };
}

describe("P4Client whereFiles", () => {
  it("maps depot, client, and local syntax in one call", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"clientFile\":\"//ws/foo.txt\",\"path\":\"C:\\\\ws\\\\foo.txt\"}",
          "{\"depotFile\":\"//depot/main/bar.txt\",\"clientFile\":\"//ws/bar.txt\",\"path\":\"C:\\\\ws\\\\bar.txt\"}"
        ]);
      }
    });

    await expect(
      p4.whereFiles({ fileSpec: ["//depot/main/foo.txt", "//depot/main/bar.txt"] })
    ).resolves.toEqual([
      {
        depotFile: "//depot/main/foo.txt",
        clientFile: "//ws/foo.txt",
        localFile: "C:\\ws\\foo.txt",
        isExcluded: false
      },
      {
        depotFile: "//depot/main/bar.txt",
        clientFile: "//ws/bar.txt",
        localFile: "C:\\ws\\bar.txt",
        isExcluded: false
      }
    ]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "where", "//depot/main/foo.txt", "//depot/main/bar.txt"]
    ]);
  });

  it("flags exclusionary view rows and strips the leading dash", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, [
          "{\"depotFile\":\"-//depot/main/secret.txt\",\"clientFile\":\"-//ws/secret.txt\",\"path\":\"-C:\\\\ws\\\\secret.txt\",\"unmap\":\"\"}"
        ])
    });

    await expect(p4.whereFiles({ fileSpec: "//depot/main/secret.txt" })).resolves.toEqual([
      {
        depotFile: "//depot/main/secret.txt",
        clientFile: "//ws/secret.txt",
        localFile: "C:\\ws\\secret.txt",
        isExcluded: true
      }
    ]);
  });

  it("returns no rows for a spec outside the client view", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ({
        command,
        args,
        stdout: "{\"data\":\"//other/... - file(s) not in client view.\",\"severity\":2,\"code\":\"error\"}",
        stderr: "",
        exitCode: 1
      })
    });

    await expect(p4.whereFiles({ fileSpec: "//other/foo.txt" })).resolves.toEqual([]);
  });
});

/**
 * `p4 filelog -i` output for a file branched from `//depot/main`: one row per
 * depot path, revision numbers restarting at 1 on the ancestor, and the
 * ancestor truncated at the branch point.
 */
const INTEGRATION_CHAIN_ROWS = [
  JSON.stringify({
    depotFile: "//depot/research/foo.txt",
    rev0: "3",
    change0: "202",
    action0: "edit",
    time0: "1742266870",
    rev1: "2",
    change1: "201",
    action1: "edit",
    time1: "1742266000",
    rev2: "1",
    change2: "200",
    action2: "branch",
    time2: "1742265000"
  }),
  JSON.stringify({
    depotFile: "//depot/main/foo.txt",
    rev0: "2",
    change0: "150",
    action0: "edit",
    time0: "1742100000",
    desc0: "Main edit\n",
    rev1: "1",
    change1: "140",
    action1: "add",
    time1: "1742000000"
  })
];

describe("P4Client getFileHistory", () => {
  it("parses indexed filelog revisions newest-first", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          JSON.stringify({
            depotFile: "//depot/main/foo.txt",
            rev0: "9",
            change0: "120",
            action0: "edit",
            type0: "text",
            time0: "1742266870",
            user0: "surya",
            client0: "Project_Main",
            desc0: "Tune balance\n",
            digest0: "AAA",
            fileSize0: "2048",
            rev1: "8",
            change1: "119",
            action1: "add",
            type1: "text",
            time1: "1742260000",
            user1: "maya",
            client1: "Maya_ws",
            desc1: "Initial import"
          })
        ]);
      }
    });

    await expect(
      p4.getFileHistory({ depotFile: "//depot/main/foo.txt", maxRevisions: 50 })
    ).resolves.toEqual({
      depotFile: "//depot/main/foo.txt",
      revisions: [
        {
          depotFile: "//depot/main/foo.txt",
          revision: 9,
          change: 120,
          action: "edit",
          type: "text",
          time: "1742266870",
          timeIso: "2025-03-18T03:01:10.000Z",
          user: "surya",
          client: "Project_Main",
          description: "Tune balance",
          digest: "AAA",
          fileSize: 2048
        },
        {
          depotFile: "//depot/main/foo.txt",
          revision: 8,
          change: 119,
          action: "add",
          type: "text",
          time: "1742260000",
          timeIso: "2025-03-18T01:06:40.000Z",
          user: "maya",
          client: "Maya_ws",
          description: "Initial import",
          digest: null,
          fileSize: null
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "filelog", "-l", "-m", "50", "//depot/main/foo.txt"]
    ]);
  });

  it("follows integrations when requested", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"rev0\":\"1\",\"change0\":\"5\",\"action0\":\"branch\"}"
        ]);
      }
    });

    await p4.getFileHistory({ depotFile: "//depot/main/foo.txt", followBranches: true });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "filelog", "-l", "-i", "//depot/main/foo.txt"]
    ]);
  });

  it("merges every integrated path newest-first by changelist", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ok(command, args, INTEGRATION_CHAIN_ROWS)
    });

    const history = await p4.getFileHistory({
      depotFile: "//depot/research/foo.txt",
      followBranches: true
    });

    // The head path stays the requested one, never the ancestor.
    expect(history.depotFile).toBe("//depot/research/foo.txt");
    // Revision numbers restart on the ancestor, so changelist is the only
    // ordering key that keeps the chain in newest-first order.
    expect(history.revisions.map((revision) => [revision.depotFile, revision.revision, revision.change]))
      .toEqual([
        ["//depot/research/foo.txt", 3, 202],
        ["//depot/research/foo.txt", 2, 201],
        ["//depot/research/foo.txt", 1, 200],
        ["//depot/main/foo.txt", 2, 150],
        ["//depot/main/foo.txt", 1, 140]
      ]);
    expect(history.revisions[3]?.description).toBe("Main edit");
  });

  it("bounds maxRevisions across the merged chain, not per path", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, INTEGRATION_CHAIN_ROWS);
      }
    });

    const history = await p4.getFileHistory({
      depotFile: "//depot/research/foo.txt",
      followBranches: true,
      maxRevisions: 4
    });

    // `p4 filelog -m 4` would have returned all five rows, four per path.
    expect(history.revisions).toHaveLength(4);
    expect(history.revisions.at(-1)).toMatchObject({
      depotFile: "//depot/main/foo.txt",
      revision: 2,
      change: 150
    });
    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "filelog", "-l", "-i", "-m", "4", "//depot/research/foo.txt"]
    ]);
  });

  it("keeps input order for revisions with equal or missing changelists", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, [
          JSON.stringify({
            depotFile: "//depot/main/foo.txt",
            rev0: "7",
            change0: "90",
            rev1: "6",
            change1: "90",
            rev2: "5"
          })
        ])
    });

    const history = await p4.getFileHistory({ depotFile: "//depot/main/foo.txt" });

    expect(history.revisions.map((revision) => revision.revision)).toEqual([7, 6, 5]);
  });

  it("reports a revision of one path once when several rows repeat it", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, [
          JSON.stringify({
            depotFile: "//depot/main/foo.txt",
            rev0: "2",
            change0: "20",
            rev1: "1",
            change1: "10"
          }),
          JSON.stringify({
            depotFile: "//depot/main/foo.txt",
            rev0: "1",
            change0: "10"
          })
        ])
    });

    const history = await p4.getFileHistory({
      depotFile: "//depot/main/foo.txt",
      followBranches: true
    });

    expect(history.revisions.map((revision) => revision.revision)).toEqual([2, 1]);
  });

  it("returns a single path untouched when integrations are not followed", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          JSON.stringify({
            depotFile: "//depot/main/foo.txt",
            rev0: "2",
            change0: "20",
            action0: "edit",
            rev1: "1",
            change1: "10",
            action1: "add"
          })
        ]);
      }
    });

    const history = await p4.getFileHistory({ depotFile: "//depot/main/foo.txt" });

    expect(history.depotFile).toBe("//depot/main/foo.txt");
    expect(history.revisions.map((revision) => [revision.revision, revision.action])).toEqual([
      [2, "edit"],
      [1, "add"]
    ]);
    expect(calls).toEqual([["-Mj", "-z", "tag", "filelog", "-l", "//depot/main/foo.txt"]]);
  });

  it("merges the files a wildcard spec matched", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          JSON.stringify({ depotFile: "//depot/main/bar.txt", rev0: "1", change0: "11" }),
          JSON.stringify({ depotFile: "//depot/main/foo.txt", rev0: "1", change0: "12" })
        ]);
      }
    });

    const history = await p4.getFileHistory({ depotFile: "//depot/main/..." });

    expect(history.revisions.map((revision) => [revision.depotFile, revision.change])).toEqual([
      ["//depot/main/foo.txt", 12],
      ["//depot/main/bar.txt", 11]
    ]);
    expect(calls).toEqual([["-Mj", "-z", "tag", "filelog", "-l", "//depot/main/..."]]);
  });

  it("returns an empty history for a non-existent file", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ({
        command,
        args,
        stdout: "{\"data\":\"//depot/main/missing.txt - no such file(s).\",\"severity\":2,\"code\":\"error\"}",
        stderr: "",
        exitCode: 1
      })
    });

    await expect(
      p4.getFileHistory({ depotFile: "//depot/main/missing.txt" })
    ).resolves.toEqual({
      depotFile: "//depot/main/missing.txt",
      revisions: []
    });
  });

  it("raises for an error-level filelog message", async () => {
    const p4 = new P4Client({
      executor: async (command, args) => ({
        command,
        args,
        stdout: "{\"data\":\"You don't have permission for this operation.\",\"severity\":3,\"code\":\"error\"}",
        stderr: "",
        exitCode: 1
      })
    });

    await expect(
      p4.getFileHistory({ depotFile: "//depot/secret/foo.txt" })
    ).rejects.toBeInstanceOf(P4CommandError);
  });
});

describe("P4Client listUsers", () => {
  it("resolves specific users with full names and emails", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"User\":\"surya\",\"Email\":\"surya@example.com\",\"FullName\":\"Surya R\",\"Type\":\"standard\",\"Access\":\"1742266870\"}",
          "{\"User\":\"maya\",\"Email\":\"maya@example.com\",\"FullName\":\"Maya K\",\"Type\":\"standard\"}"
        ]);
      }
    });

    await expect(p4.listUsers({ users: ["surya", "maya"], maxResults: 10 })).resolves.toEqual([
      {
        user: "surya",
        email: "surya@example.com",
        fullName: "Surya R",
        type: "standard",
        accessedAt: "1742266870",
        accessedAtIso: "2025-03-18T03:01:10.000Z"
      },
      {
        user: "maya",
        email: "maya@example.com",
        fullName: "Maya K",
        type: "standard",
        accessedAt: null,
        accessedAtIso: null
      }
    ]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "users", "-m", "10", "surya", "maya"]
    ]);
  });

  it("lists all users when no identifiers are given", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, []);
      }
    });

    await expect(p4.listUsers()).resolves.toEqual([]);
    expect(calls).toEqual([["-Mj", "-z", "tag", "users"]]);
  });
});
