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
