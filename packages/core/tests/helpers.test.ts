import { describe, expect, it } from "bun:test";
import {
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeP4Change,
  parseP4JsonLines,
  parseP4KeyValueOutput,
  parseP4ProgressLine,
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
