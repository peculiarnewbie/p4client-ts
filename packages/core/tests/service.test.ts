import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { createP4Service } from "../src/public/service.js";

describe("createP4Service", () => {
  it("exposes Effect-based wrappers for service-oriented usage", async () => {
    const service = createP4Service({
      executor: async (command, args) => {
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
            "{\"client\":\"Project_Main\",\"Owner\":\"surya\",\"Host\":\"DESKTOP-WORK-ARIF\",\"Root\":\"C:\\\\work\\\\Project_Main\",\"Stream\":\"//Project/main\",\"Access\":\"1742266870\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        };
      }
    });

    await expect(Effect.runPromise(service.getP4Environment())).resolves.toEqual({
      hostName: "DESKTOP-WORK-ARIF",
      p4Port: "ssl:perforce.example.com:1666",
      p4User: "surya",
      p4Client: "Project_Main"
    });

    await expect(Effect.runPromise(service.listP4Workspaces())).resolves.toEqual([
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
  });

  it("exposes changelist and preview wrappers", async () => {
    const service = createP4Service({
      executor: async (command, args) => {
        if (args.includes("changes")) {
          return {
            command,
            args,
            stdout: "{\"change\":\"12345\",\"client\":\"Project_Main\",\"user\":\"surya\",\"time\":\"1742266870\",\"desc\":\"Feature work\",\"status\":\"pending\"}",
            stderr: "",
            exitCode: 0
          };
        }

        if (args.includes("opened")) {
          return {
            command,
            args,
            stdout: "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"change\":\"default\",\"user\":\"surya\",\"client\":\"Project_Main\"}",
            stderr: "",
            exitCode: 0
          };
        }

        if (args.includes("reconcile")) {
          return {
            command,
            args,
            stdout: "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"change\":\"12345\"}",
            stderr: "",
            exitCode: 0
          };
        }

        return {
          command,
          args,
          stdout: "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"refresh\",\"rev\":\"9\",\"fileSize\":\"256\"}",
          stderr: "",
          exitCode: 0
        };
      }
    });

    await expect(Effect.runPromise(service.listPendingChangelists())).resolves.toEqual([
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
        description: "Feature work",
        createdAt: "1742266870",
        createdAtIso: "2025-03-18T03:01:10.000Z",
        isDefault: false
      }
    ]);

    await expect(Effect.runPromise(service.getOpenedFiles({ change: "default" }))).resolves.toEqual([
      {
        depotFile: "//Project/main/foo.txt",
        clientFile: null,
        localFile: null,
        action: "edit",
        type: null,
        changelist: "default",
        changelistDescription: null,
        user: "surya",
        client: "Project_Main",
        revision: null,
        isDefaultChangelist: true
      }
    ]);

    await expect(Effect.runPromise(service.getChangelistFiles("default"))).resolves.toEqual([
      {
        depotFile: "//Project/main/foo.txt",
        clientFile: null,
        localFile: null,
        action: "edit",
        type: null,
        changelist: "default",
        changelistDescription: null,
        user: "surya",
        client: "Project_Main",
        revision: null,
        isDefaultChangelist: true
      }
    ]);

    await expect(Effect.runPromise(service.previewReconcile())).resolves.toEqual({
      added: [],
      edited: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: null,
          action: "edit",
          type: null,
          changelist: 12345
        }
      ],
      deleted: []
    });

    await expect(Effect.runPromise(service.previewSync())).resolves.toEqual({
      items: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: null,
          revision: 9,
          action: "refresh",
          fileSize: 256
        }
      ],
      totalCount: 1
    });

    await expect(Effect.runPromise(service.sync())).resolves.toEqual({
      items: [
        {
          depotFile: "//Project/main/foo.txt",
          clientFile: null,
          localFile: null,
          revision: 9,
          action: "refresh",
          fileSize: 256
        }
      ],
      totalCount: 1
    });
  });

  it("streams reconcile progress events through the Effect service", async () => {
    const service = createP4Service({
      streamExecutor: (command, args) => ({
        events: (async function*() {
          yield { type: "start", command, args };
          yield { type: "line", source: "stderr" as const, line: "Scanning workspace: 1/2 (50%)" };
          yield {
            type: "line",
            source: "stdout" as const,
            line: "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"change\":\"12345\"}"
          };
          yield { type: "exit", exitCode: 0 };
        })(),
        result: Promise.resolve({
          command,
          args,
          stdout: [
            "Scanning workspace: 1/2 (50%)",
            "{\"depotFile\":\"//Project/main/foo.txt\",\"action\":\"edit\",\"change\":\"12345\"}"
          ].join("\n"),
          stderr: "",
          exitCode: 0
        })
      })
    });

    const events = await Effect.runPromise(
      service.streamPreviewReconcile().pipe(Stream.runCollect)
    );

    expect(Array.from(events)).toEqual([
      {
        type: "start",
        command: "p4",
        args: ["-I", "-Mj", "-z", "tag", "reconcile", "-n"],
        progressRequested: true
      },
      {
        type: "progress",
        source: "stderr",
        rawLine: "Scanning workspace: 1/2 (50%)",
        snapshot: {
          rawMessage: "Scanning workspace: 1/2 (50%)",
          phase: "Scanning workspace",
          completed: 1,
          total: 2,
          percent: 50
        }
      },
      {
        type: "complete",
        result: {
          added: [],
          edited: [
            {
              depotFile: "//Project/main/foo.txt",
              clientFile: null,
              localFile: null,
              action: "edit",
              type: null,
              changelist: 12345
            }
          ],
          deleted: []
        }
      }
    ]);
  });
});
