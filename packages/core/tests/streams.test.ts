import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import { P4CommandError } from "../src/public/errors.js";
import type { P4CommandResult } from "../src/public/types.js";

function ok(command: string, args: string[], lines: string[]): P4CommandResult {
  return { command, args, stdout: lines.join("\n"), stderr: "", exitCode: 0 };
}

describe("P4Client listStreams", () => {
  it("lists streams with parent relationships for hierarchy assembly", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"Stream\":\"//Project/main\",\"Name\":\"main\",\"Owner\":\"surya\",\"Parent\":\"none\",\"Type\":\"mainline\",\"desc\":\"Mainline\\n\"}",
          "{\"Stream\":\"//Project/dev\",\"Name\":\"dev\",\"Owner\":\"maya\",\"Parent\":\"//Project/main\",\"Type\":\"development\",\"desc\":\"Feature work\"}"
        ]);
      }
    });

    await expect(p4.listStreams({ fileSpec: "//Project/...", maxResults: 100 })).resolves.toEqual([
      {
        stream: "//Project/main",
        name: "main",
        owner: "surya",
        parent: null,
        type: "mainline",
        description: "Mainline"
      },
      {
        stream: "//Project/dev",
        name: "dev",
        owner: "maya",
        parent: "//Project/main",
        type: "development",
        description: "Feature work"
      }
    ]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "streams", "-m", "100", "//Project/..."]
    ]);
  });

  it("falls back to the trailing path segment when Name is absent", async () => {
    const p4 = new P4Client({
      executor: async (command, args) =>
        ok(command, args, ["{\"Stream\":\"//Project/release-1.0\",\"Parent\":\"//Project/main\"}"])
    });

    await expect(p4.listStreams()).resolves.toEqual([
      {
        stream: "//Project/release-1.0",
        name: "release-1.0",
        owner: null,
        parent: "//Project/main",
        type: null,
        description: null
      }
    ]);
  });
});

describe("P4Client annotateFile", () => {
  it("annotates each line with the last modifying change", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, [
          "{\"depotFile\":\"//depot/main/foo.txt\",\"rev\":\"9\"}",
          "{\"lower\":\"5\",\"upper\":\"5\",\"data\":\"first line\\n\"}",
          "{\"lower\":\"5\",\"upper\":\"7\",\"data\":\"second line\\n\"}",
          "{\"lower\":\"7\",\"upper\":\"7\",\"data\":\"\\n\"}"
        ]);
      }
    });

    await expect(p4.annotateFile({ depotFile: "//depot/main/foo.txt" })).resolves.toEqual({
      depotFile: "//depot/main/foo.txt",
      revision: "9",
      lines: [
        { line: 1, change: 5, data: "first line" },
        { line: 2, change: 7, data: "second line" },
        { line: 3, change: 7, data: "" }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "annotate", "-q", "-c", "//depot/main/foo.txt"]
    ]);
  });

  it("appends a revision and follows integrations when requested", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: async (command, args) => {
        calls.push(args);
        return ok(command, args, ["{\"upper\":\"3\",\"data\":\"line\\n\"}"]);
      }
    });

    await p4.annotateFile({ depotFile: "//depot/main/foo.txt", revision: 8, followIntegrations: true });
    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "annotate", "-q", "-c", "-I", "//depot/main/foo.txt#8"]
    ]);

    calls.length = 0;
    await p4.annotateFile({ depotFile: "//depot/main/foo.txt", revision: "@120" });
    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "annotate", "-q", "-c", "//depot/main/foo.txt@120"]
    ]);
  });

  it("returns an empty annotation for a non-existent file", async () => {
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
      p4.annotateFile({ depotFile: "//depot/main/missing.txt" })
    ).resolves.toEqual({
      depotFile: "//depot/main/missing.txt",
      revision: null,
      lines: []
    });
  });

  it("raises for an error-level annotate message", async () => {
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
      p4.annotateFile({ depotFile: "//depot/secret/foo.txt" })
    ).rejects.toBeInstanceOf(P4CommandError);
  });
});
