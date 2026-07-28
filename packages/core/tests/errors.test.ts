import { describe, expect, it } from "bun:test";
import { P4Client } from "../src/public/client.js";
import {
  P4CommandError,
  P4TimeoutError,
  classifyP4Error,
  isP4ConnectionError
} from "../src/public/errors.js";
import type { P4CommandExecutor, P4ErrorCategory } from "../src/public/index.js";

function createExecutor(resolver: P4CommandExecutor): P4CommandExecutor {
  return resolver;
}

function failingExecutor(stderr: string): P4CommandExecutor {
  return createExecutor(async (command, args) => ({
    command,
    args,
    stdout: "",
    stderr,
    exitCode: 1
  }));
}

// ---------------------------------------------------------------------------
// classifyP4Error (unit)
// ---------------------------------------------------------------------------

describe("classifyP4Error", () => {
  const cases: [string, P4ErrorCategory][] = [
    // connection
    ["Connect to server failed; check $P4PORT.", "connection"],
    ["TCP connect to perforce-main:1666 failed.", "connection"],
    ["No such host is known.", "connection"],
    ["Connection refused", "connection"],
    ["Network is unreachable", "connection"],
    ["Operation timed out", "connection"],

    // server_config
    ["check $P4PORT", "server_config"],
    ["P4PORT invalid port number", "server_config"],
    ["SSL init failure", "server_config"],

    // authentication
    ["Your session has expired, please login again.", "authentication"],
    ["Password invalid.", "authentication"],
    ["Perforce password (P4PASSWD) invalid or unset.", "authentication"],
    ["login required", "authentication"],
    ["Ticket expired", "authentication"],

    // client
    ["Client 'Arif_DESKTOP_WORK_SubwayMain' unknown - use 'client' command to create it.", "client"],
    ["unknown client Arif_DESKTOP_WORK_SubwayMain", "client"],
    ["Client has not been set", "client"],

    // command (fallback)
    ["Some random error message", "command"],
    ["", "command"],
  ];

  for (const [text, expected] of cases) {
    it(`classifies "${text.slice(0, 50)}…" as "${expected}"`, () => {
      expect(classifyP4Error(text)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// P4CommandError (unit)
// ---------------------------------------------------------------------------

describe("P4CommandError", () => {
  it("auto-classifies from the error message when no explicit category is given", () => {
    const result = { command: "p4", args: ["info"], stdout: "", stderr: "Connect to server failed", exitCode: 1 };
    const error = new P4CommandError("p4 info exited with 1: Connect to server failed", result);

    expect(error.category).toBe("connection");
    expect(error.result).toBe(result);
    expect(error.message).toContain("Connect to server failed");
    expect(error.name).toBe("P4CommandError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(P4CommandError);
  });

  it("uses an explicit category when provided", () => {
    const result = { command: "p4", args: ["sync"], stdout: "", stderr: "weird error", exitCode: 1 };
    const error = new P4CommandError("p4 sync exited with 1: weird error", result, "authentication");

    expect(error.category).toBe("authentication");
  });

  it("preserves the raw P4CommandResult for debugging", () => {
    const result = {
      command: "p4",
      args: ["-Mj", "-z", "tag", "changes", "-s", "pending", "-c", "Arif_DESKTOP_WORK_SubwayMain"],
      stdout: "",
      stderr: "Perforce client error:\n\tConnect to server failed; check $P4PORT.\n\tTCP connect to perforce-main:1666 failed.\n\tNo such host is known.",
      exitCode: 1
    };
    const error = new P4CommandError(`p4 exited with 1: ${result.stderr}`, result);

    expect(error.result.args).toEqual(result.args);
    expect(error.result.exitCode).toBe(1);
    expect(error.result.stderr).toContain("perforce-main:1666");
  });
});

describe("P4TimeoutError", () => {
  it("preserves timeout metadata and partial output", () => {
    const error = new P4TimeoutError("p4", ["info"], 1500, "partial out", "partial err");

    expect(error.name).toBe("P4TimeoutError");
    expect(error.message).toContain("timed out after 1500ms");
    expect(error.command).toBe("p4");
    expect(error.args).toEqual(["info"]);
    expect(error.timeoutMs).toBe(1500);
    expect(error.stdout).toBe("partial out");
    expect(error.stderr).toBe("partial err");
  });
});

describe("isP4ConnectionError", () => {
  it("matches unreachable-server style failures without treating auth failures as connection errors", () => {
    expect(isP4ConnectionError(new Error([
      "Perforce client error:",
      "\tConnect to server failed; check $P4PORT.",
      "\tTCP connect to perforce-main:1666 failed.",
      "\tNo such host is known."
    ].join("\n")))).toBe(true);

    expect(isP4ConnectionError(new Error(
      "Perforce client error:\n\tConnect to server failed; check $P4PORT.\n\tconnect: 8.215.30.90:1666: WSAETIMEDOUT"
    ))).toBe(true);

    expect(isP4ConnectionError(new Error("Your session has expired, please login again."))).toBe(false);
    expect(isP4ConnectionError(new P4TimeoutError("p4", ["info"], 1500))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4Client.run() integration – error category flows through
// ---------------------------------------------------------------------------

describe("P4Client error classification", () => {
  it("classifies host-not-found / cannot-connect as connection error", async () => {
    const stderr = [
      "Perforce client error:",
      "\tConnect to server failed; check $P4PORT.",
      "\tTCP connect to perforce-main.asia-southeast2-a.c.achievement-396505.internal:1666 failed.",
      "\tNo such host is known."
    ].join("\n");

    const p4 = new P4Client({ executor: failingExecutor(stderr) });

    try {
      await p4.run(["info"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      expect(err).toBeInstanceOf(P4CommandError);
      const p4err = err as P4CommandError;
      expect(p4err.category).toBe("connection");
      expect(p4err.result.exitCode).toBe(1);
    }
  });

  it("classifies missing P4PORT / bad server config as server_config error", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("P4PORT invalid port number")
    });

    try {
      await p4.run(["info"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      expect(err).toBeInstanceOf(P4CommandError);
      expect((err as P4CommandError).category).toBe("server_config");
    }
  });

  it("classifies expired session as authentication error", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("Your session has expired, please login again.")
    });

    try {
      await p4.run(["changes"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      expect(err).toBeInstanceOf(P4CommandError);
      expect((err as P4CommandError).category).toBe("authentication");
    }
  });

  it("classifies invalid workspace as client error", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("Client 'Arif_DESKTOP_WORK_SubwayMain' unknown - use 'client' command to create it.")
    });

    try {
      await p4.run(["-Mj", "-z", "tag", "changes", "-s", "pending", "-c", "Arif_DESKTOP_WORK_SubwayMain"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      expect(err).toBeInstanceOf(P4CommandError);
      expect((err as P4CommandError).category).toBe("client");
    }
  });

  it("classifies unknown failures as generic command error", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("Something completely unexpected happened")
    });

    try {
      await p4.run(["sync"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      expect(err).toBeInstanceOf(P4CommandError);
      expect((err as P4CommandError).category).toBe("command");
    }
  });

  it("still respects allowNonZeroExit (no error thrown)", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("Connect to server failed; check $P4PORT.")
    });

    const result = await p4.run(["info"], { allowNonZeroExit: true });
    expect(result.exitCode).toBe(1);
  });

  it("is backward-compatible: instanceof P4CommandError still works", async () => {
    const p4 = new P4Client({
      executor: failingExecutor("Perforce client error")
    });

    await expect(p4.run(["info"])).rejects.toBeInstanceOf(P4CommandError);
    await expect(p4.run(["info"])).rejects.toBeInstanceOf(Error);
  });

  it("works with the real-world electroswag error format", async () => {
    // Exact error from the issue description
    const stderr = `Perforce client error:
    Connect to server failed; check $P4PORT.
    TCP connect to perforce-main.asia-southeast2-a.c.achievement-396505.internal:1666 failed.
    No such host is known.`;

    const p4 = new P4Client({ executor: failingExecutor(stderr) });

    try {
      await p4.run(["-Mj", "-z", "tag", "changes", "-s", "pending", "-c", "Arif_DESKTOP_WORK_SubwayMain"]);
      throw new Error("expected P4CommandError");
    } catch (err) {
      const p4err = err as P4CommandError;
      expect(p4err).toBeInstanceOf(P4CommandError);
      expect(p4err.category).toBe("connection");
      expect(p4err.result.stderr).toContain("perforce-main.asia-southeast2-a.c.achievement-396505.internal:1666");
      expect(p4err.result.args).toContain("Arif_DESKTOP_WORK_SubwayMain");
    }
  });

  it("redacts password-like arguments from timeout error messages", () => {
    const error = new P4TimeoutError("p4", ["-P", "s3cret", "info"], 1000);
    expect(error.message).toContain("-P ***");
    expect(error.message).not.toContain("s3cret");
    expect(error.args).toEqual(["-P", "***", "info"]);
  });
});
