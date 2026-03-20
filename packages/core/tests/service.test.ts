import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createP4Service } from "../src/public/service.js";

describe("createP4Service", () => {
  it("exposes Effect-based wrappers for electroswag-style extraction", async () => {
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
});
