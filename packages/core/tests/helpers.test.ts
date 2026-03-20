import { describe, expect, it } from "bun:test";
import {
  isLocalWorkspace,
  parseP4JsonLines,
  parseP4KeyValueOutput,
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

describe("isLocalWorkspace", () => {
  it("accepts host matches and local roots", () => {
    const workspace = {
      root: "C:\\work\\ManaBreak",
      host: "DESKTOP-WORK-ARIF"
    };
    const otherWorkspace = {
      root: "D:\\workspace\\MBResearch",
      host: "RENDER-NODE"
    };

    expect(isLocalWorkspace(workspace, "DESKTOP-WORK-ARIF", () => false)).toBe(true);
    expect(
      isLocalWorkspace(otherWorkspace, "DESKTOP-WORK-ARIF", (root) => root === "D:\\workspace\\MBResearch")
    ).toBe(true);
    expect(isLocalWorkspace(otherWorkspace, "DESKTOP-WORK-ARIF", () => false)).toBe(false);
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
