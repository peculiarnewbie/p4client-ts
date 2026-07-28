import { describe, expect, it } from "bun:test";
import { loadE2EConfig } from "./config.js";

describe("p4-ts e2e gate", () => {
  it("reports whether live Perforce fixtures are opted in", () => {
    const state = loadE2EConfig();

    if (!state.enabled) {
      console.info(`[e2e] skipped: ${state.reason}`);
      expect(state.enabled).toBe(false);
      return;
    }

    expect(state.config.client.length).toBeGreaterThan(0);
    expect(state.config.stream.length).toBeGreaterThan(0);
    expect(state.config.workspaceRoot.length).toBeGreaterThan(0);
  });
});
