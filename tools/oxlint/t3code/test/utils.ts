// Vendored from pingdotgg/t3code (oxlint-plugin-t3code), MIT, Copyright (c) 2026 T3 Tools Inc. See LICENSE.
// Adapted from upstream's @effect/vitest harness: same fixture setup and assertions, on
// vite-plus/test, running oxlint synchronously.

import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
// oxlint is a dependency of vite-plus, not of this repository, so resolve it through vite-plus.
const oxlintBin = join(
  dirname(
    createRequire(createRequire(join(repoRoot, "package.json")).resolve("vite-plus/package.json"))
      .resolve("oxlint/package.json"),
  ),
  "bin",
  "oxlint",
);
const pluginPath = join(import.meta.dirname, "..", "index.ts");

interface RuleHarness {
  readonly valid: (name: string, source: string) => void;
  readonly invalid: (name: string, source: string, assertion?: (output: string) => void) => void;
}

interface RuleHarnessOptions {
  readonly filename?: string;
  readonly ruleOptions?: ReadonlyArray<unknown>;
}

interface OxlintRun {
  readonly exitCode: number | null;
  readonly output: string;
}

export const createOxlintRuleHarness = (
  ruleName: string,
  options: RuleHarnessOptions = {},
): RuleHarness => {
  const [pluginName, shortRuleName] = ruleName.split("/");
  const diagnosticRuleName =
    pluginName && shortRuleName ? `${pluginName}\\(${shortRuleName}\\)` : ruleName;

  const run = (source: string): OxlintRun => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "p4ts-oxlint-"));
    try {
      const configPath = join(fixtureDir, ".oxlintrc.json");
      const sourcePath = join(fixtureDir, options.filename ?? "fixture.ts");
      writeFileSync(
        configPath,
        JSON.stringify({
          jsPlugins: [{ name: "t3code", specifier: pluginPath }],
          rules: { [ruleName]: ["error", ...(options.ruleOptions ?? [])] },
        }),
      );
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, source);

      // oxlint's bin is an extensionless Node script, which Windows cannot spawn directly.
      const result = spawnSync("node", [oxlintBin, "--config", configPath, sourcePath], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      if (result.error) throw result.error;

      return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  };

  return {
    valid(name, source) {
      describe(name, () => {
        it("passes", () => {
          const result = run(source);
          expect(result.output).not.toMatch(new RegExp(diagnosticRuleName));
          expect(result.exitCode).toBe(0);
        });
      });
    },
    invalid(name, source, assertion) {
      describe(name, () => {
        it("reports the rule diagnostic", () => {
          const result = run(source);
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toMatch(new RegExp(diagnosticRuleName));
          assertion?.(result.output);
        });
      });
    },
  };
};
