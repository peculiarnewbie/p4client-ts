import { describe, expect, it } from "bun:test";
import {
  buildDepotDiffFilespec,
  isBinaryP4Type,
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeP4Change,
  parseP4JsonLines,
  parseP4KeyValueOutput,
  parseP4PrintHeader,
  parseP4ProgressLine,
  parseUnifiedDiff,
  resolveDepotDiffRevisions,
  resolveDiffPlan,
  summarizeUnifiedDiff,
  unixSecondsToIsoString
} from "../src/public/helpers.js";
import type { P4JsonWorkspace } from "../src/public/types.js";

describe("parseP4KeyValueOutput", () => {
  it("parses p4 info output", () => {
    const output = [
      "User name: surya",
      "Client name: Arif_UE-ManaBreak",
      "Client host: DESKTOP-WORK-ARIF",
      "Server address: ssl:perforce.example.com:1666"
    ].join("\n");

    expect(parseP4KeyValueOutput(output)).toEqual({
      "User name": "surya",
      "Client name": "Arif_UE-ManaBreak",
      "Client host": "DESKTOP-WORK-ARIF",
      "Server address": "ssl:perforce.example.com:1666"
    });
  });
});

describe("parseP4JsonLines", () => {
  it("parses newline-delimited JSON from p4 -Mj -z tag", () => {
    const output = [
      "{\"client\":\"Arif_UE-ManaBreak\",\"Owner\":\"arif\",\"Host\":\"DESKTOP-WORK-ARIF\",\"Root\":\"C:\\\\work\\\\ManaBreak\",\"Stream\":\"//ManaBreak/main\",\"Access\":\"1742266870\"}",
      "{\"client\":\"Arif_MBResearch\",\"Owner\":\"arif\",\"Root\":\"D:\\\\workspace\\\\MBResearch\",\"Access\":\"1742180400\"}"
    ].join("\n");

    const result = parseP4JsonLines<P4JsonWorkspace>(output);

    expect(result).toEqual([
      {
        client: "Arif_UE-ManaBreak",
        Owner: "arif",
        Host: "DESKTOP-WORK-ARIF",
        Root: "C:\\work\\ManaBreak",
        Stream: "//ManaBreak/main",
        Access: "1742266870"
      },
      {
        client: "Arif_MBResearch",
        Owner: "arif",
        Root: "D:\\workspace\\MBResearch",
        Access: "1742180400"
      }
    ]);
  });

  it("handles empty lines", () => {
    expect(parseP4JsonLines("")).toEqual([]);
    expect(parseP4JsonLines("\n\n")).toEqual([]);
  });
});

describe("parseP4ProgressLine", () => {
  it("extracts best-effort progress fields from a human-readable line", () => {
    expect(parseP4ProgressLine("Scanning workspace: 3/12 (25%)")).toEqual({
      rawMessage: "Scanning workspace: 3/12 (25%)",
      phase: "Scanning workspace",
      completed: 3,
      total: 12,
      percent: 25
    });
  });
});

describe("isLocalWorkspace", () => {
  it("accepts only exact host matches", () => {
    expect(isLocalWorkspace({ host: "DESKTOP-WORK-ARIF" }, "DESKTOP-WORK-ARIF")).toBe(true);
    expect(isLocalWorkspace({ host: "RENDER-NODE" }, "DESKTOP-WORK-ARIF")).toBe(false);
    expect(isLocalWorkspace({ host: null }, "DESKTOP-WORK-ARIF")).toBe(false);
  });
});

describe("unixSecondsToIsoString", () => {
  it("converts unix seconds to an ISO timestamp", () => {
    expect(unixSecondsToIsoString("1742266870")).toBe("2025-03-18T03:01:10.000Z");
  });

  it("returns null for missing or invalid values", () => {
    expect(unixSecondsToIsoString(null)).toBeNull();
    expect(unixSecondsToIsoString("not-a-number")).toBeNull();
  });
});

describe("normalizeNullableString", () => {
  it("returns trimmed strings and null for empty values", () => {
    expect(normalizeNullableString("  hello  ")).toBe("hello");
    expect(normalizeNullableString("   ")).toBeNull();
    expect(normalizeNullableString(undefined)).toBeNull();
  });
});

describe("normalizeNullableNumber", () => {
  it("parses finite numeric values", () => {
    expect(normalizeNullableNumber("123")).toBe(123);
    expect(normalizeNullableNumber(42)).toBe(42);
  });

  it("returns null for invalid values", () => {
    expect(normalizeNullableNumber("abc")).toBeNull();
    expect(normalizeNullableNumber(undefined)).toBeNull();
  });
});

describe("normalizeP4Change", () => {
  it("handles default and numbered changelists", () => {
    expect(normalizeP4Change("default")).toBe("default");
    expect(normalizeP4Change("12345")).toBe(12345);
  });

  it("returns null for missing or invalid values", () => {
    expect(normalizeP4Change(undefined)).toBeNull();
    expect(normalizeP4Change("not-a-change")).toBeNull();
  });
});

describe("isBinaryP4Type", () => {
  it("detects binary and xbinary Perforce types", () => {
    expect(isBinaryP4Type("binary")).toBe(true);
    expect(isBinaryP4Type("xbinary")).toBe(true);
    expect(isBinaryP4Type("text")).toBe(false);
    expect(isBinaryP4Type(null)).toBe(false);
  });
});

describe("summarizeUnifiedDiff", () => {
  it("counts addition and deletion lines", () => {
    const diff = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,2 +1,3 @@",
      " context",
      "-removed",
      "+added",
      "+another"
    ].join("\n");

    expect(summarizeUnifiedDiff(diff)).toEqual({
      additions: 2,
      deletions: 1
    });
  });
});

describe("parseUnifiedDiff", () => {
  it("parses unified diff hunks", () => {
    const diff = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,2 +1,3 @@",
      " context",
      "-removed",
      "+added"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" context", "-removed", "+added"]
      }
    ]);
  });
});

describe("parseP4PrintHeader", () => {
  it("parses p4 print header lines", () => {
    expect(parseP4PrintHeader("//Project/main/foo.txt#3 - text")).toEqual({
      depotFile: "//Project/main/foo.txt",
      revision: "3",
      type: "text"
    });
  });
});

describe("resolveDepotDiffRevisions", () => {
  it("maps submitted actions to revision endpoints", () => {
    expect(
      resolveDepotDiffRevisions({
        depotFile: "//Project/main/foo.txt",
        action: "add",
        revision: 1
      })
    ).toEqual({ fromRevision: "none", toRevision: 1 });

    expect(
      resolveDepotDiffRevisions({
        depotFile: "//Project/main/foo.txt",
        action: "edit",
        revision: 7
      })
    ).toEqual({ fromRevision: 6, toRevision: 7 });

    expect(
      resolveDepotDiffRevisions({
        depotFile: "//Project/main/foo.txt",
        action: "delete",
        revision: 7
      })
    ).toEqual({ fromRevision: 7, toRevision: "none" });
  });
});

describe("resolveDiffPlan", () => {
  it("selects workspace diffs for pending changelists by default", () => {
    expect(
      resolveDiffPlan({
        depotFile: "//Project/main/foo.txt",
        changelistStatus: "pending"
      })
    ).toEqual({
      source: "workspace",
      command: "diff",
      args: ["-du", "//Project/main/foo.txt"],
      fromRevision: null,
      toRevision: null
    });
  });

  it("selects depot diffs for submitted changelists", () => {
    expect(
      resolveDiffPlan({
        depotFile: "//Project/main/foo.txt",
        action: "edit",
        revision: 4,
        changelistStatus: "submitted"
      })
    ).toEqual({
      source: "depot",
      command: "diff2",
      args: ["-du", "//Project/main/foo.txt#3", "//Project/main/foo.txt#4"],
      fromRevision: 3,
      toRevision: 4
    });
  });
});

describe("buildDepotDiffFilespec", () => {
  it("builds revision and none filespecs", () => {
    expect(buildDepotDiffFilespec("//Project/main/foo.txt", 3)).toBe(
      "//Project/main/foo.txt#3"
    );
    expect(buildDepotDiffFilespec("//Project/main/foo.txt", "none")).toBe(
      "//Project/main/foo.txt#none"
    );
  });
});
