import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { E2EConfig } from "./config.js";

export interface FixtureSentinel {
  relativePath: string;
  workspacePath: string;
  seedPath: string;
  expectedContent: string;
}

export interface E2EFixture {
  sentinels: FixtureSentinel[];
}

interface StreamManifest {
  seedRoot: string;
}

const SENTINEL_PATHS = [
  "src/app/config.json",
  "src/app/index.txt",
  "src/assets/list.txt",
  "docs/guide/getting-started.md"
] as const;

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadFixture(config: E2EConfig): E2EFixture {
  const manifest = readJsonFile<StreamManifest>(
    resolve(config.testStreamPackageRoot, "stream-manifest.json")
  );
  const seedRoot = resolve(config.testStreamPackageRoot, manifest.seedRoot);
  const sentinels = SENTINEL_PATHS.map((relativePath) => {
    const seedPath = join(seedRoot, relativePath);
    return {
      relativePath,
      workspacePath: join(config.workspaceRoot, relativePath),
      seedPath,
      expectedContent: readFileSync(seedPath, "utf8")
    };
  });

  return { sentinels };
}

export function assertSeededWorkspace(fixture: E2EFixture): void {
  const mismatches: string[] = [];

  for (const sentinel of fixture.sentinels) {
    if (!existsSync(sentinel.workspacePath)) {
      mismatches.push(`Missing workspace file: ${sentinel.relativePath}`);
      continue;
    }

    const actualContent = readFileSync(sentinel.workspacePath, "utf8");
    if (actualContent !== sentinel.expectedContent) {
      mismatches.push(`Workspace file does not match seeded content: ${sentinel.relativePath}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error([
      "The canonical E2E workspace does not match the test-stream seed.",
      ...mismatches
    ].join("\n"));
  }
}
