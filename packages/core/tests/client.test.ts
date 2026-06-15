import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import { P4CommandError } from "../src/public/errors.js";
import type {
  P4CommandExecutor,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4StreamingCommandExecutor
} from "../src/public/types.js";

function createExecutor(resolver: P4CommandExecutor): P4CommandExecutor {
  return resolver;
}

function createStreamHandle(
  events: P4CommandStreamEvent[],
  result: P4CommandResult
): P4OperationHandle<P4CommandStreamEvent, P4CommandResult> {
  return {
    events: (async function*() {
      for (const event of events) {
        yield event;
      }
    })(),
    result: Promise.resolve(result)
  };
}

function createStreamingExecutor(
  resolver: P4StreamingCommandExecutor
): P4StreamingCommandExecutor {
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

  it("prefers env P4PORT over Server address from p4 info (proxy/SSL scenario)", async () => {
    const p4 = new P4Client({
      env: { P4PORT: "ssl:p4.stairwaygames.work:1666" },
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: [
          "User name: surya",
          "Client name: Project_Main",
          "Client host: DESKTOP-WORK-ARIF",
          "Server address: perforce-main.asia-southeast2-a.c.internal:1666"
        ].join("\n"),
        stderr: "",
        exitCode: 0
      }))
    });

    const env = await p4.getEnvironment();
    expect(env.p4Port).toBe("ssl:p4.stairwaygames.work:1666");
  });

  it("falls back to Server address when no P4PORT is configured", async () => {
    const originalP4PORT = process.env.P4PORT;
    delete process.env.P4PORT;
    try {
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

      const env = await p4.getEnvironment();
      expect(env.p4Port).toBe("ssl:perforce.example.com:1666");
    } finally {
      if (originalP4PORT !== undefined) {
        process.env.P4PORT = originalP4PORT;
      }
    }
  });

  it("supports local environment mode without contacting the server", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args[0] !== "set") {
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        }

        return {
          command,
          args,
          stdout: [
            "P4PORT=ssl:perforce.example.com:1666",
            "P4USER=surya",
            "P4CLIENT=Project_Main"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    const environment = await p4.getEnvironment({ mode: "local" });

    expect(environment.hostName).toEqual(expect.any(String));
    expect(environment).toMatchObject({
      p4Port: "ssl:perforce.example.com:1666",
      p4User: "surya",
      p4Client: "Project_Main"
    });

    expect(calls).toEqual([["set", "-q"]]);
  });

  it("can enrich server environment results with locally resolved settings", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args[0] === "set") {
          return {
            command,
            args,
            stdout: [
              "P4PORT=ssl:configured.example.com:1666",
              "P4CLIENT=Configured_Client"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        return {
          command,
          args,
          stdout: [
            "User name: surya",
            "Client host: DESKTOP-WORK-ARIF",
            "Server address: perforce.internal:1666"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.getEnvironment({ resolveSettings: true })).resolves.toEqual({
      hostName: "DESKTOP-WORK-ARIF",
      p4Port: "ssl:configured.example.com:1666",
      p4User: "surya",
      p4Client: "Configured_Client"
    });

    expect(calls).toEqual([
      ["set", "-q"],
      ["info"]
    ]);
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

  it("passes the configured default timeout to raw command execution", async () => {
    let capturedTimeout: number | undefined;
    const p4 = new P4Client({
      timeoutMs: 1500,
      executor: createExecutor(async (command, args, options) => {
        capturedTimeout = options.timeoutMs;
        return {
          command,
          args,
          stdout: "",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await p4.run(["info"]);
    expect(capturedTimeout).toBe(1500);
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

  it("lists submitted changelists with fileSpec pagination", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Submitted feature\",\"status\":\"submitted\"}",
            "{\"change\":\"12340\",\"client\":\"Project_Tools\",\"user\":\"maya\",\"time\":\"1742266000\",\"desc\":\"Tooling\",\"status\":\"submitted\"}",
            "{\"change\":\"default\",\"desc\":\"ignored\"}",
            "{\"change\":\"not-a-change\",\"desc\":\"ignored\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(
      p4.listSubmittedChangelists({
        fileSpec: "//Project/main/...",
        user: "surya",
        limit: 2,
        beforeChange: 12350
      })
    ).resolves.toEqual({
      items: [
        {
          change: 12345,
          client: "Project_Main",
          user: "surya",
          status: "submitted",
          description: "Submitted feature",
          createdAt: "1742266870",
          createdAtIso: "2025-03-18T03:01:10.000Z"
        },
        {
          change: 12340,
          client: "Project_Tools",
          user: "maya",
          status: "submitted",
          description: "Tooling",
          createdAt: "1742266000",
          createdAtIso: "2025-03-18T02:46:40.000Z"
        }
      ],
      hasMore: true,
      nextBeforeChange: 12339
    });

    expect(calls).toEqual([
      [
        "-Mj",
        "-z",
        "tag",
        "changes",
        "-s",
        "submitted",
        "-l",
        "-u",
        "surya",
        "-m",
        "2",
        "//Project/main/...",
        "@12350"
      ]
    ]);
  });

  it("returns no submitted pagination cursor when the result is below the limit", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "{\"change\":\"2\",\"client\":\"Project_Main\",\"user\":\"surya\"}",
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.listSubmittedChangelists({ limit: 5 })).resolves.toMatchObject({
      hasMore: false,
      nextBeforeChange: null
    });
  });

  it("lists shelved changelists with fileSpec pagination", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Shelved review\",\"status\":\"pending\"}",
            "{\"change\":\"12340\",\"client\":\"Project_Tools\",\"user\":\"maya\",\"time\":\"1742266000\",\"desc\":\"Tooling shelf\",\"status\":\"pending\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(
      p4.listShelvedChangelists({
        fileSpec: "//Project/main/...",
        user: "surya",
        client: "Project_Main",
        limit: 2,
        beforeChange: 12350
      })
    ).resolves.toEqual({
      items: [
        {
          change: 12345,
          client: "Project_Main",
          user: "surya",
          status: "shelved",
          description: "Shelved review",
          createdAt: "1742266870",
          createdAtIso: "2025-03-18T03:01:10.000Z"
        },
        {
          change: 12340,
          client: "Project_Tools",
          user: "maya",
          status: "shelved",
          description: "Tooling shelf",
          createdAt: "1742266000",
          createdAtIso: "2025-03-18T02:46:40.000Z"
        }
      ],
      hasMore: true,
      nextBeforeChange: 12339
    });

    expect(calls).toEqual([
      [
        "-Mj",
        "-z",
        "tag",
        "changes",
        "-s",
        "shelved",
        "-l",
        "-u",
        "surya",
        "-c",
        "Project_Main",
        "-m",
        "2",
        "//Project/main/...",
        "@12350"
      ]
    ]);
  });

  it("unifies pending and submitted changelist listing", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"status\":\"pending\"}",
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(
      p4.listChangelists({ status: "pending", includeDefault: false })
    ).resolves.toEqual({
      items: [
        {
          change: 12345,
          client: "Project_Main",
          user: "surya",
          status: "pending",
          description: null,
          createdAt: null,
          createdAtIso: null,
          isDefault: false
        }
      ],
      hasMore: false,
      nextBeforeChange: null
    });
  });

  it("unifies shelved changelist listing", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"status\":\"pending\"}",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(
      p4.listChangelists({ status: "shelved", limit: 1 })
    ).resolves.toEqual({
      items: [
        {
          change: 12345,
          client: "Project_Main",
          user: "surya",
          status: "shelved",
          description: null,
          createdAt: null,
          createdAtIso: null
        }
      ],
      hasMore: true,
      nextBeforeChange: 12344
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "changes", "-s", "shelved", "-l", "-m", "1"]
    ]);
  });

  it("sets the active client and invalidates cached environment", async () => {
    const calls: string[][] = [];
    let infoCalls = 0;
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        if (args[0] === "set") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }

        infoCalls += 1;
        return {
          command,
          args,
          stdout: [
            "User name: surya",
            `Client name: ${infoCalls === 1 ? "Project_Old" : "Project_New"}`,
            "Client host: DESKTOP-WORK-ARIF",
            "Server address: ssl:perforce.example.com:1666"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await p4.getEnvironment();
    await expect(p4.setClient({ client: "Project_New" })).resolves.toEqual({
      ok: true,
      previousClient: "Project_Old",
      newClient: "Project_New"
    });
    await expect(p4.getEnvironment()).resolves.toMatchObject({
      p4Client: "Project_New"
    });

    expect(calls).toEqual([
      ["info"],
      ["set", "P4CLIENT=Project_New"],
      ["info"]
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

  it("derives reconcile fileSpec from workspace root when omitted", async () => {
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
      p4.previewReconcile({ workspace: { root: "E:\\Game", stream: "//Project/main" } })
    ).resolves.toEqual({
      added: [],
      edited: [],
      deleted: []
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "reconcile", "-n", "E:/Game/..."]
    ]);
  });

  it("prefers explicit reconcile fileSpec over workspace-derived fileSpec", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      })
    });

    await p4.previewReconcile({
      fileSpec: "//Project/main/...",
      workspace: { root: "E:\\Game", stream: "//Project/main" }
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "reconcile", "-n", "//Project/main/..."]
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

  it("emits reconcile progress events and returns the final preview result", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      streamExecutor: createStreamingExecutor((command, args) => {
        calls.push(args);

        return createStreamHandle(
          [
            { type: "start", command, args },
            { type: "line", source: "stderr", line: "Scanning workspace: 1/4 (25%)" },
            {
              type: "line",
              source: "stdout",
              line: "{\"depotFile\":\"//Project/main/edit.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\edit.txt\",\"action\":\"edit\",\"change\":\"12345\"}"
            },
            { type: "line", source: "stdout", line: "Hashing files: 4/4 (100%)" },
            { type: "exit", exitCode: 0 }
          ],
          {
            command,
            args,
            stdout: [
              "Scanning workspace: 1/4 (25%)",
              "{\"depotFile\":\"//Project/main/edit.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\edit.txt\",\"action\":\"edit\",\"change\":\"12345\"}",
              "Hashing files: 4/4 (100%)"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          }
        );
      })
    });

    const operation = p4.watchPreviewReconcile({ fileSpec: "C:/work/Project_Main/..." });
    const events = [];

    for await (const event of operation.events) {
      events.push(event);
    }

    await expect(operation.result).resolves.toEqual({
      added: [],
      edited: [
        {
          depotFile: "//Project/main/edit.txt",
          clientFile: null,
          localFile: "C:\\work\\Project_Main\\edit.txt",
          action: "edit",
          type: null,
          changelist: 12345
        }
      ],
      deleted: []
    });

    expect(events).toEqual([
      {
        type: "start",
        command: "p4",
        args: ["-I", "-Mj", "-z", "tag", "reconcile", "-n", "C:/work/Project_Main/..."],
        progressRequested: true
      },
      {
        type: "progress",
        source: "stderr",
        rawLine: "Scanning workspace: 1/4 (25%)",
        snapshot: {
          rawMessage: "Scanning workspace: 1/4 (25%)",
          phase: "Scanning workspace",
          completed: 1,
          total: 4,
          percent: 25
        }
      },
      {
        type: "progress",
        source: "stdout",
        rawLine: "Hashing files: 4/4 (100%)",
        snapshot: {
          rawMessage: "Hashing files: 4/4 (100%)",
          phase: "Hashing files",
          completed: 4,
          total: 4,
          percent: 100
        }
      },
      {
        type: "complete",
        result: {
          added: [],
          edited: [
            {
              depotFile: "//Project/main/edit.txt",
              clientFile: null,
              localFile: "C:\\work\\Project_Main\\edit.txt",
              action: "edit",
              type: null,
              changelist: 12345
            }
          ],
          deleted: []
        }
      }
    ]);

    expect(calls).toEqual([
      ["-I", "-Mj", "-z", "tag", "reconcile", "-n", "C:/work/Project_Main/..."]
    ]);
  });

  it("reports progress-unavailable when reconcile emits no progress lines", async () => {
    const p4 = new P4Client({
      streamExecutor: createStreamingExecutor((command, args) =>
        createStreamHandle(
          [
            { type: "start", command, args },
            {
              type: "line",
              source: "stdout",
              line: "{\"depotFile\":\"//Project/main/add.txt\",\"action\":\"add\",\"change\":\"default\"}"
            },
            { type: "exit", exitCode: 0 }
          ],
          {
            command,
            args,
            stdout: "{\"depotFile\":\"//Project/main/add.txt\",\"action\":\"add\",\"change\":\"default\"}",
            stderr: "",
            exitCode: 0
          }
        ))
    });

    const operation = p4.watchPreviewReconcile();
    const events = [];
    for await (const event of operation.events) {
      events.push(event);
    }

    await operation.result;

    expect(events[1]).toEqual({
      type: "progress-unavailable",
      reason: "not-emitted",
      message: "Perforce did not emit progress lines for this reconcile preview."
    });
  });

  it("retries without -I when progress is unsupported", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      streamExecutor: createStreamingExecutor((command, args) => {
        calls.push(args);

        if (args[0] === "-I") {
          return createStreamHandle(
            [
              { type: "start", command, args },
              { type: "line", source: "stderr", line: "Unknown option: -I." },
              { type: "exit", exitCode: 1 }
            ],
            {
              command,
              args,
              stdout: "",
              stderr: "Unknown option: -I.",
              exitCode: 1
            }
          );
        }

        return createStreamHandle(
          [
            { type: "start", command, args },
            {
              type: "line",
              source: "stdout",
              line: "{\"depotFile\":\"//Project/main/delete.txt\",\"action\":\"delete\"}"
            },
            { type: "exit", exitCode: 0 }
          ],
          {
            command,
            args,
            stdout: "{\"depotFile\":\"//Project/main/delete.txt\",\"action\":\"delete\"}",
            stderr: "",
            exitCode: 0
          }
        );
      })
    });

    const operation = p4.watchPreviewReconcile();
    const events = [];
    for await (const event of operation.events) {
      events.push(event);
    }

    await expect(operation.result).resolves.toEqual({
      added: [],
      edited: [],
      deleted: [
        {
          depotFile: "//Project/main/delete.txt",
          clientFile: null,
          localFile: null,
          action: "delete",
          type: null,
          changelist: null
        }
      ]
    });

    expect(events).toContainEqual({
      type: "progress-unavailable",
      reason: "unsupported",
      message: "Unknown option: -I."
    });
    expect(calls).toEqual([
      ["-I", "-Mj", "-z", "tag", "reconcile", "-n"],
      ["-Mj", "-z", "tag", "reconcile", "-n"]
    ]);
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

  it("passes keepWorkspaceFiles to sync preview", async () => {
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
      p4.previewSync({ keepWorkspaceFiles: true, fileSpec: "//Project/main/..." })
    ).resolves.toEqual({
      items: [],
      totalCount: 0
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "sync", "-n", "-k", "//Project/main/..."]
    ]);
  });

  it("returns sync items with a total count", async () => {
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

    await expect(
      p4.sync({ force: true, keepWorkspaceFiles: true, fileSpec: "//Project/main/..." })
    ).resolves.toEqual({
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
      ["-Mj", "-z", "tag", "sync", "-f", "-k", "//Project/main/..."]
    ]);
  });

  it("returns structured sync errors from tagged error rows", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: [
          "{\"depotFile\":\"//Project/main/foo.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"rev\":\"8\",\"action\":\"refresh\"}",
          "{\"severity\":\"3\",\"data\":\"Can't clobber writable file E:\\\\Game\\\\Content\\\\Asset.uasset\"}",
          "{\"severity\":\"3\",\"data\":\"E:\\\\Game\\\\Content\\\\Map.umap - can't overwrite existing file\"}"
        ].join("\n"),
        stderr: "",
        exitCode: 1
      }))
    });

    await expect(p4.sync()).resolves.toEqual({
      items: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: "C:\\work\\Project_Main\\foo.txt",
          revision: 8,
          action: "refresh",
          fileSize: null
        }
      ],
      errors: [
        {
          clientFile: "E:\\Game\\Content\\Asset.uasset",
          depotFile: null,
          message: "Can't clobber writable file E:\\Game\\Content\\Asset.uasset"
        },
        {
          clientFile: "E:\\Game\\Content\\Map.umap",
          depotFile: null,
          message: "E:\\Game\\Content\\Map.umap - can't overwrite existing file"
        }
      ],
      totalCount: 1
    });
  });

  it("streams sync progress and error rows", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      streamExecutor: createStreamingExecutor((command, args) => {
        calls.push(args);
        return createStreamHandle(
          [
            { type: "start", command, args },
            {
              type: "line",
              source: "stdout",
              line: "{\"depotFile\":\"//Project/main/foo.txt\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"rev\":\"8\",\"action\":\"refresh\"}"
            },
            {
              type: "line",
              source: "stdout",
              line: "{\"severity\":\"3\",\"data\":\"Can't clobber writable file E:\\\\Game\\\\Content\\\\Asset.uasset\"}"
            },
            { type: "exit", exitCode: 1 }
          ],
          {
            command,
            args,
            stdout: "",
            stderr: "",
            exitCode: 1
          }
        );
      })
    });

    const operation = p4.watchSync({ fileSpec: "//Project/main/..." });
    const events = [];
    for await (const event of operation.events) {
      events.push(event);
    }

    await expect(operation.result).resolves.toEqual({
      items: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: "C:\\work\\Project_Main\\foo.txt",
          revision: 8,
          action: "refresh",
          fileSize: null
        }
      ],
      errors: [
        {
          clientFile: "E:\\Game\\Content\\Asset.uasset",
          depotFile: null,
          message: "Can't clobber writable file E:\\Game\\Content\\Asset.uasset"
        }
      ],
      totalCount: 1
    });

    expect(events).toEqual([
      {
        type: "start",
        command: "p4",
        args: ["-Mj", "-z", "tag", "sync", "//Project/main/..."]
      },
      {
        type: "progress",
        item: {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: "C:\\work\\Project_Main\\foo.txt",
          revision: 8,
          action: "refresh",
          fileSize: null
        },
        filesSynced: 1
      },
      {
        type: "error-row",
        error: {
          clientFile: "E:\\Game\\Content\\Asset.uasset",
          depotFile: null,
          message: "Can't clobber writable file E:\\Game\\Content\\Asset.uasset"
        }
      },
      {
        type: "complete",
        result: {
          items: [
            {
              depotFile: "//Project/main/foo.txt",
              clientFile: null,
              localFile: "C:\\work\\Project_Main\\foo.txt",
              revision: 8,
              action: "refresh",
              fileSize: null
            }
          ],
          errors: [
            {
              clientFile: "E:\\Game\\Content\\Asset.uasset",
              depotFile: null,
              message: "Can't clobber writable file E:\\Game\\Content\\Asset.uasset"
            }
          ],
          totalCount: 1
        }
      }
    ]);

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "sync", "//Project/main/..."]
    ]);
  });

  it("returns an empty sync result when Perforce emits no rows", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "",
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.sync()).resolves.toEqual({
      items: [],
      totalCount: 0
    });
  });

  it("throws a typed error when sync exits non-zero", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "",
        stderr: "Your session has expired, please login again.",
        exitCode: 1
      }))
    });

    await expect(p4.sync()).rejects.toBeInstanceOf(P4CommandError);
  });

  it("describes a numbered changelist from tagged JSON", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Feature work\",\"status\":\"pending\"}",
            "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"rev\":\"7\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.describeChangelist(12345)).resolves.toEqual({
      change: 12345,
      client: "Project_Main",
      user: "surya",
      description: "Feature work",
      createdAt: "1742266870",
      createdAtIso: "2025-03-18T03:01:10.000Z",
      status: "pending",
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          action: "edit",
          type: "text",
          revision: 7
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "describe", "-s", "12345"]
    ]);
  });

  it("describes shelved files from a numbered changelist", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Feature work\",\"status\":\"pending\"}",
            "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"rev\":\"7\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.describeChangelist(12345, { shelved: true })).resolves.toEqual({
      change: 12345,
      client: "Project_Main",
      user: "surya",
      description: "Feature work",
      createdAt: "1742266870",
      createdAtIso: "2025-03-18T03:01:10.000Z",
      status: "pending",
      contentSource: "shelved",
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          action: "edit",
          type: "text",
          revision: 7
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "describe", "-S", "-s", "12345"]
    ]);
  });

  it("describes a numbered changelist from numbered tagged describe fields", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: JSON.stringify({
          change: "12345",
          client: "Project_Main",
          user: "surya",
          time: "1742266870",
          desc: "Feature work",
          status: "pending",
          depotFile0: "//Project/main/foo.txt",
          action0: "edit",
          type0: "text",
          rev0: "7",
          depotFile1: "//Project/main/deleted.txt",
          action1: "delete",
          type1: "text",
          rev1: "3"
        }),
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.describeChangelist(12345)).resolves.toMatchObject({
      change: 12345,
      status: "pending",
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          action: "edit",
          type: "text",
          revision: 7
        },
        {
          depotFile: "//Project/main/deleted.txt",
          action: "delete",
          type: "text",
          revision: 3
        }
      ]
    });
  });

  it("describes the default changelist from opened files", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        if (args.includes("opened")) {
          return {
            command,
            args,
            stdout: [
              "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"change\":\"default\",\"desc\":\"Default changelist\",\"user\":\"surya\",\"client\":\"Project_Main\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\",\"rev\":\"7\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      })
    });

    await expect(p4.describeChangelist("default")).resolves.toEqual({
      change: "default",
      client: "Project_Main",
      user: "surya",
      description: "Default changelist",
      createdAt: null,
      createdAtIso: null,
      status: "pending",
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          action: "edit",
          type: "text",
          revision: 7
        }
      ]
    });
  });

  it("treats p4 diff exit code 1 as a successful diff result", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: [
            "--- //Project/main/foo.txt",
            "+++ //Project/main/foo.txt",
            "@@ -1 +1,2 @@",
            " line",
            "+added"
          ].join("\n"),
          stderr: "",
          exitCode: 1
        };
      })
    });

    await expect(
      p4.diffFile({ depotFile: "//Project/main/foo.txt", localFile: "C:/work/foo.txt" })
    ).resolves.toEqual({
      depotFile: "//Project/main/foo.txt",
      localFile: "C:/work/foo.txt",
      source: "workspace",
      fromRevision: null,
      toRevision: null,
      unifiedDiff: [
        "--- //Project/main/foo.txt",
        "+++ //Project/main/foo.txt",
        "@@ -1 +1,2 @@",
        " line",
        "+added"
      ].join("\n"),
      isBinary: false,
      exitCode: 1,
      additions: 1,
      deletions: 0
    });

    expect(calls).toEqual([
      ["diff", "-du", "//Project/main/foo.txt"]
    ]);
  });

  it("compares depot revisions when fromRevision and toRevision are provided", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "@@ -1,2 +1,3 @@\n context\n-removed\n+added\n",
          stderr: "",
          exitCode: 1
        };
      })
    });

    await expect(
      p4.diffFile({
        depotFile: "//Project/main/foo.txt",
        fromRevision: 3,
        toRevision: 4
      })
    ).resolves.toMatchObject({
      source: "depot",
      fromRevision: 3,
      toRevision: 4,
      exitCode: 1,
      additions: 1,
      deletions: 1
    });

    expect(calls).toEqual([
      ["diff2", "-du", "//Project/main/foo.txt#3", "//Project/main/foo.txt#4"]
    ]);
  });

  it("auto-routes submitted changelist files to depot-vs-depot diffs", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "@@ -1 +1,2 @@\n line\n+added\n",
          stderr: "",
          exitCode: 1
        };
      })
    });

    await expect(
      p4.diffFile({
        depotFile: "//Project/main/foo.txt",
        action: "edit",
        revision: 7,
        changelistStatus: "submitted"
      })
    ).resolves.toMatchObject({
      source: "depot",
      fromRevision: 6,
      toRevision: 7
    });

    expect(calls).toEqual([
      ["diff2", "-du", "//Project/main/foo.txt#6", "//Project/main/foo.txt#7"]
    ]);
  });

  it("auto-routes shelved changelist files to depot-vs-shelf diffs", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "@@ -1 +1,2 @@\n line\n+added\n",
          stderr: "",
          exitCode: 1
        };
      })
    });

    await expect(
      p4.diffFile({
        depotFile: "//Project/main/foo.txt",
        action: "edit",
        revision: 7,
        changelistStatus: "shelved",
        shelvedChange: 12345
      })
    ).resolves.toMatchObject({
      source: "depot",
      fromRevision: 6,
      toRevision: "@=12345"
    });

    expect(calls).toEqual([
      ["diff2", "-du", "//Project/main/foo.txt#6", "//Project/main/foo.txt@=12345"]
    ]);
  });

  it("returns an empty diff for binary files when allowBinary is false", async () => {
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
      p4.diffFile({
        depotFile: "//Project/main/foo.uasset",
        type: "binary",
        allowBinary: false
      })
    ).resolves.toMatchObject({
      depotFile: "//Project/main/foo.uasset",
      unifiedDiff: "",
      isBinary: true,
      exitCode: 0,
      additions: 0,
      deletions: 0
    });

    expect(calls).toEqual([]);
  });

  it("throws when p4 diff exits with code 2 or higher", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "",
        stderr: "file(s) not opened on this client.",
        exitCode: 2
      }))
    });

    await expect(
      p4.diffFile({ depotFile: "//Project/main/foo.txt" })
    ).rejects.toBeInstanceOf(P4CommandError);
  });

  it("prints text depot content and strips the header line", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);
        return {
          command,
          args,
          stdout: "//Project/main/foo.txt#3 - text\nhello\nworld\n",
          stderr: "",
          exitCode: 0
        };
      })
    });

    await expect(p4.printFile("//Project/main/foo.txt", { revision: 3 })).resolves.toEqual({
      depotFile: "//Project/main/foo.txt",
      revision: "3",
      content: "hello\nworld\n",
      isBinary: false,
      type: "text"
    });

    expect(calls).toEqual([
      ["print", "-q", "//Project/main/foo.txt#3"]
    ]);
  });

  it("marks binary print output without returning content", async () => {
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => ({
        command,
        args,
        stdout: "//Project/main/foo.uasset#1 - binary\n\x00\x01\x02",
        stderr: "",
        exitCode: 0
      }))
    });

    await expect(p4.printFile("//Project/main/foo.uasset")).resolves.toEqual({
      depotFile: "//Project/main/foo.uasset",
      revision: "1",
      content: "",
      isBinary: true,
      type: "binary"
    });
  });

  it("builds a changelist diff summary without running diff by default", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args.includes("describe")) {
          return {
            command,
            args,
            stdout: [
              "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Feature work\",\"status\":\"pending\"}",
              "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"rev\":\"7\"}",
              "{\"depotFile\":\"//Project/main/bar.uasset\",\"action\":\"edit\",\"type\":\"binary\",\"rev\":\"2\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        if (args.includes("opened")) {
          return {
            command,
            args,
            stdout: [
              "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"change\":\"12345\",\"path\":\"C:\\\\work\\\\Project_Main\\\\foo.txt\"}",
              "{\"depotFile\":\"//Project/main/bar.uasset\",\"action\":\"edit\",\"type\":\"binary\",\"change\":\"12345\",\"path\":\"C:\\\\work\\\\Project_Main\\\\bar.uasset\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      })
    });

    await expect(p4.getChangelistDiffSummary(12345)).resolves.toEqual({
      changelist: {
        change: 12345,
        client: "Project_Main",
        user: "surya",
        description: "Feature work",
        createdAt: "1742266870",
        createdAtIso: "2025-03-18T03:01:10.000Z",
        status: "pending",
        files: [
          {
            depotFile: "//Project/main/foo.txt",
            action: "edit",
            type: "text",
            revision: 7
          },
          {
            depotFile: "//Project/main/bar.uasset",
            action: "edit",
            type: "binary",
            revision: 2
          }
        ]
      },
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          localFile: "C:\\work\\Project_Main\\foo.txt",
          action: "edit",
          type: "text",
          isBinary: false,
          additions: null,
          deletions: null,
          patchLoadState: "deferred"
        },
        {
          depotFile: "//Project/main/bar.uasset",
          localFile: "C:\\work\\Project_Main\\bar.uasset",
          action: "edit",
          type: "binary",
          isBinary: true,
          additions: null,
          deletions: null,
          patchLoadState: "deferred"
        }
      ]
    });

    expect(calls.some((args) => args.includes("diff"))).toBe(false);
  });

  it("builds a shelved changelist diff summary without opened file lookup", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args.includes("describe")) {
          return {
            command,
            args,
            stdout: [
              "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Shelved work\",\"status\":\"pending\"}",
              "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"rev\":\"7\"}",
              "{\"depotFile\":\"//Project/main/bar.uasset\",\"action\":\"edit\",\"type\":\"binary\",\"rev\":\"2\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      })
    });

    await expect(p4.getChangelistDiffSummary(12345, { shelved: true })).resolves.toEqual({
      changelist: {
        change: 12345,
        client: "Project_Main",
        user: "surya",
        description: "Shelved work",
        createdAt: "1742266870",
        createdAtIso: "2025-03-18T03:01:10.000Z",
        status: "pending",
        contentSource: "shelved",
        files: [
          {
            depotFile: "//Project/main/foo.txt",
            action: "edit",
            type: "text",
            revision: 7
          },
          {
            depotFile: "//Project/main/bar.uasset",
            action: "edit",
            type: "binary",
            revision: 2
          }
        ]
      },
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          localFile: null,
          action: "edit",
          type: "text",
          isBinary: false,
          additions: null,
          deletions: null,
          patchLoadState: "deferred"
        },
        {
          depotFile: "//Project/main/bar.uasset",
          localFile: null,
          action: "edit",
          type: "binary",
          isBinary: true,
          additions: null,
          deletions: null,
          patchLoadState: "deferred"
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "describe", "-S", "-s", "12345"]
    ]);
  });

  it("builds shelved line counts with depot-vs-shelf diffs", async () => {
    const calls: string[][] = [];
    const p4 = new P4Client({
      executor: createExecutor(async (command, args) => {
        calls.push(args);

        if (args.includes("describe")) {
          return {
            command,
            args,
            stdout: [
              "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Shelved work\",\"status\":\"pending\"}",
              "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"type\":\"text\",\"rev\":\"7\"}"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }

        if (args[0] === "diff2") {
          return {
            command,
            args,
            stdout: "@@ -1,2 +1,3 @@\n context\n-removed\n+added\n",
            stderr: "",
            exitCode: 1
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      })
    });

    await expect(
      p4.getChangelistDiffSummary(12345, { shelved: true, includeLineCounts: true })
    ).resolves.toMatchObject({
      files: [
        {
          depotFile: "//Project/main/foo.txt",
          localFile: null,
          additions: 1,
          deletions: 1
        }
      ]
    });

    expect(calls).toEqual([
      ["-Mj", "-z", "tag", "describe", "-S", "-s", "12345"],
      ["diff2", "-du", "//Project/main/foo.txt#6", "//Project/main/foo.txt@=12345"]
    ]);
  });
});
