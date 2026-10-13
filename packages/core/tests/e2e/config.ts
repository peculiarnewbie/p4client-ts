import { resolve } from "node:path";

export interface E2EConfig {
  workspaceRoot: string;
  client: string;
  stream: string;
  p4Executable: string;
  user: string;
  p4Port: string;
  syncBaseChange: number;
  testStreamPackageRoot: string;
  p4Env: NodeJS.ProcessEnv;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The canonical E2E runner did not provide ${name}. Run "bun run test:e2e".`);
  }
  return value;
}

function readRequiredPositiveIntegerEnv(name: string): number {
  const value = Number(readRequiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function loadE2EConfig(): E2EConfig {
  const repoRoot = resolve(import.meta.dir, "../../../../");
  const client = readRequiredEnv("P4CLIENT");
  const p4Port = readRequiredEnv('P4PORT');
  if (p4Port !== readRequiredEnv('P4_TS_E2E_ISOLATED_PORT') || !/^127\.0\.0\.1:\d+$/.test(p4Port)) {
    throw new Error('Refusing E2E commands outside the disposable localhost server.');
  }
  return {
    workspaceRoot: readRequiredEnv("P4_TS_E2E_WORKSPACE_ROOT"),
    client,
    stream: readRequiredEnv("P4_TS_E2E_STREAM"),
    p4Executable: readRequiredEnv("P4_TS_E2E_P4_EXECUTABLE"),
    user: readRequiredEnv("P4USER"),
    p4Port,
    syncBaseChange: readRequiredPositiveIntegerEnv("P4_TS_E2E_SYNC_BASE_CHANGE"),
    testStreamPackageRoot: resolve(repoRoot, "packages/test-stream"),
    p4Env: { ...process.env, P4CLIENT: client }
  };
}
