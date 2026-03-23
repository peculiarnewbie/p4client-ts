import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import { P4CommandError } from "../src/public/errors.js";
import type { P4CommandExecutor } from "../src/public/types.js";

function createExecutor(resolver: P4CommandExecutor): P4CommandExecutor {
  return resolver;
}

describe("P4Client", () => {
  it("reads environment details from p4 info output", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: [
          "User name: surya",
          "Client name: Project_Main",
          "Client host: DESKTOP-WORK-ARIF",
          "Server address: ssl:perforce.example.com:1666"
        ].join("\n"),
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.getEnvironment()).resolves.toEqual({
      hostName: "DESKTOP-WORK-ARIF",
      p4Port: "ssl:perforce.example.com:1666",
      p4User: "surya",
      p4Client: "Project_Main"
    });
  });

  it("lists only workspaces whose host matches the current machine", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args[0] === "info") {
          return {
            command,
            args,
            stdout: [
              "User name: surya",
              "Client name: Project_Main",
              "Client host: DESKTOP-WORK-ARIF",
              "Server address: ssl:perforce.example.com:1666"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        return {
          command,
          args,
          stdout: [
            "{\"client\":\"Project_Main\",\"Owner\":\"surya\",\"Host\":\"DESKTOP-WORK-ARIF\",\"Root\":\"C:\\\\work\\\\Project_Main\",\"Stream\":\"//Project/main\",\"Access\":\"1742266870\"}",
            "{\"client\":\"Project_Render\",\"Owner\":\"surya\",\"Host\":\"RENDER-NODE\",\"Root\":\"D:\\\\render\\\\Project\",\"Update\":\"1742000000\"}",
            "{\"client\":\"Project_Tools\",\"Owner\":\"surya\",\"Root\":\"E:\\\\tools\\\\Project\",\"Update\":\"1742100000\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.listWorkspaces()).resolves.toEqual([
      {
        client: "Project_Main",
        stream: "//Project/main",
        root: "C:\\work\\Project_Main",
        host: "DESKTOP-WORK-ARIF",
        owner: "surya",
        accessedAt: "1742266870",
        accessedAtIso: "2025-03-18T03:01:10.000Z",
        isCurrentClient: true
      }
    ]);

    expect(calls).toEqual([
      ["info"],
      ["-Mj", "-z", "tag", "clients", "-u", "surya"]
    ]);
  });

  it("throws a typed error on non-zero exit by default", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "",
        stderr: "Perforce client error",
        exitCode: 1
      }))
    });

    await expect(p4.run(["info"])).rejects.toBeInstanceOf(P4CommandError);
  });

  it("can allow non-zero exits for caller-managed handling", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "",
        stderr: "Perforce client error",
        exitCode: 1
      }))
    });

    await expect(p4.run(["changes"], { allowNonZeroExit: true })).resolves.toMatchObject({
      exitCode: 1
    });
  });

  it("lists pending changelists and synthesizes the default changelist when needed", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args.includes("changes")) {
          return {
            command,
            args,
            stdout: [
              "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Fix build break\\nAdd missing asset\",\"status\":\"pending\"}",
              "{\"change\":\"12346\",\"client\":\"Project_Tools\",\"user\":\"surya\",\"time\":\"1742267000\",\"desc\":\"Tooling cleanup\",\"status\":\"pending\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        return {
          command,
          args,
          stdout: [
            "{\"depotFile\":\"//Project/main/fileA.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\fileA.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\fileA.txt\",\"action\":\"edit\",\"type\":\"text\",\"change\":\"default\",\"user\":\"surya\",\"client\":\"Project_Main\",\"rev\":\"7\",\"desc\":\"Default changelist\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.listPendingChangelists()).resolves.toEqual([
      {
        change: "default",
        client: "Project_Main",
        user: "surya",
        status: "pending",
        description: "Default changelist",
        createdAt: null,
        createdAtIso: null,
        isDefault: true
      },
      {
        change: 12345,
        client: "Project_Main",
        user: "surya",
        status: "pending",
        description: "Fix build break\nAdd missing asset",
        createdAt: "1742266870",
        createdAtIso: "2025-03-18T03:01:10.000Z",
        isDefault: false
      },
      {
        change: 12346,
        client: "Project_Tools",
        user: "surya",
        status: "pending",
        description: "Tooling cleanup",
        createdAt: "1742267000",
        createdAtIso: "2025-03-18T03:03:20.000Z",
        isDefault: false
      }
    ]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "changes", "-s", "pending"],
      ["-Mj", "-z", "tag", "opened", "-c", "default"]
    ]);
  });

  it("passes client filters when listing pending changelists", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.listPendingChangelists({ client: "Project_Main", includeDefault: false })).resolves.toEqual([]);
    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "changes", "-s", "pending", "-c", "Project_Main"]
    ]);
  });

  it("returns opened files as a flat typed list", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: [
          "{\"depotFile\":\"//Project/main/foo.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"change\":\"12345\",\"desc\":\"Feature work\",\"user\":\"surya\",\"client\":\"Project_Main\",\"rev\":\"7\"}",
          "{\"depotFile\":\"//Project/main/bar.txt\",\"action\":\"add\",\"change\":\"default\",\"user\":\"surya\",\"client\":\"Project_Main\"}"
        ].join("\n"),
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.getOpenedFiles()).resolves.toEqual([
      {
        depotFile: "//Project/main/foo.txt",
        clientFile: "C:\\work\\Project_Main\\foo.txt",
        localFile: "C:\\work\\Project_Main\\foo.txt",
        action: "edit",
        type: "text",
        changelist: 12345,
        changelistDescription: "Feature work",
        user: "surya",
        client: "Project_Main",
        revision: 7,
        isDefaultChangelist: false
      },
      {
        depotFile: "//Project/main/bar.txt",
        clientFile: null,
        localFile: null,
        action: "add",
        type: null,
        changelist: "default",
        changelistDescription: null,
        user: "surya",
        client: "Project_Main",
        revision: null,
        isDefaultChangelist: true
      }
    ]);
  });

  it("passes changelist and fileSpec filters to opened", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(
      p4.getOpenedFiles({
        change: "default",
        fileSpec: ["//Project/main/...", "C:/work/Project_Main/..."]
      })
    ).resolves.toEqual([]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "opened", "-c", "default", "//Project/main/...", "C:/work/Project_Main/..."]
    ]);
  });

  it("delegates getChangelistFiles through getOpenedFiles", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.getChangelistFiles(12345, { client: "Project_Main" })).resolves.toEqual([]);
    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "opened", "-C", "Project_Main", "-c", "12345"]
    ]);
  });

  it("categorizes reconcile preview results", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"depotFile\":\"//Project/main/add.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\add.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\add.txt\",\"action\":\"add\",\"type\":\"text\",\"change\":\"default\"}",
            "{\"depotFile\":\"//Project/main/edit.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\edit.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\edit.txt\",\"action\":\"edit\",\"type\":\"binary\",\"change\":\"12345\"}",
            "{\"depotFile\":\"//Project/main/delete.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\delete.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\delete.txt\",\"action\":\"delete\",\"type\":\"text\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(
      p4.previewReconcile({
        useModTime: true,
        includeWritable: true,
        fileSpec: "C:/work/Project_Main/..."
      })
    ).resolves.toEqual({
      added: [
        {
          depotFile: "//Project/main/add.txt",
          clientFile: "C:\\work\\Project_Main\\add.txt",
          localFile: "C:\\work\\Project_Main\\add.txt",
          action: "add",
          type: "text",
          changelist: "default"
        }
      ],
      edited: [
        {
          depotFile: "//Project/main/edit.txt",
          clientFile: "C:\\work\\Project_Main\\edit.txt",
          localFile: "C:\\work\\Project_Main\\edit.txt",
          action: "edit",
          type: "binary",
          changelist: 12345
        }
      ],
      deleted: [
        {
          depotFile: "//Project/main/delete.txt",
          clientFile: "C:\\work\\Project_Main\\delete.txt",
          localFile: "C:\\work\\Project_Main\\delete.txt",
          action: "delete",
          type: "text",
          changelist: null
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "reconcile", "-n", "-m", "-w", "C:/work/Project_Main/..."]
    ]);
  });

  it("throws on unsupported reconcile actions", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "{\"action\":\"branch\"}",
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.previewReconcile()).rejects.toThrow("Unsupported reconcile action");
  });

  it("returns sync preview items with a total count", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"depotFile\":\"//Project/main/foo.txt\",\"clientFile\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"rev\":\"8\",\"action\":\"refresh\",\"fileSize\":\"128\"}",
            "{\"depotFile\":\"//Project/main/bar.txt\",\"action\":\"deleted\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.previewSync({ force: true, fileSpec: "//Project/main/..." })).resolves.toEqual({
      items: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: "C:\\work\\Project_Main\\foo.txt",
          localFile: "C:\\work\\Project_Main\\foo.txt",
          revision: 8,
          action: "refresh",
          fileSize: 128
        },
        {
          depotFile: "//Project/main/bar.txt",
          clientFile: null,
          localFile: null,
          revision: null,
          action: "deleted",
          fileSize: null
        }
      ],
      totalCount: 2
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "sync", "-n", "-f", "//Project/main/..."]
    ]);
  });
});
