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

  it("lists local workspaces using host and path matching", async () => {
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
      }),
      pathExists: (path) => path === "E:\\tools\\Project"
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
      },
      {
        client: "Project_Tools",
        stream: null,
        root: "E:\\tools\\Project",
        host: null,
        owner: "surya",
        accessedAt: "1742100000",
        accessedAtIso: "2025-03-16T04:40:00.000Z",
        isCurrentClient: false
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
});
