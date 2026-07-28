import { basename, resolve } from "node:path";

export interface E2EConfig {
  workspaceRoot: string;
  client: string;
  stream: string;
  user: string | null;
  host: string | null;
  p4Port: string | null;
  p4Config: string | null;
  allowOpenedScenarios: boolean;
  allowSyncPreview: boolean;
  repoRoot: string;
  testStreamPackageRoot: string;
  workspaceRootName: string;
  p4Env: NodeJS.ProcessEnv;
}

export type E2EConfigState =
  | {
      enabled: false;
      reason: string;
    }
  | {
      enabled: true;
      config: E2EConfig;
    };

function readBooleanEnv(name: string): boolean {
  return process.env[name] === "1";
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadE2EConfig(): E2EConfigState {
  if (!readBooleanEnv("P4_TS_E2E")) {
    return {
      enabled: false,
      reason: "Set P4_TS_E2E=1 to run Perforce end-to-end tests."
    };
  }

  const workspaceRoot = readOptionalEnv("P4_TS_E2E_WORKSPACE_ROOT");
  const client = readOptionalEnv("P4_TS_E2E_CLIENT");
  const stream = readOptionalEnv("P4_TS_E2E_STREAM");

  if (!workspaceRoot || !client || !stream) {
    throw new Error([
      "P4_TS_E2E=1 requires a complete fixture target.",
      "Set P4_TS_E2E_WORKSPACE_ROOT, P4_TS_E2E_CLIENT, and P4_TS_E2E_STREAM."
    ].join(" "));
  }

  const repoRoot = resolve(import.meta.dir, "../../../../");
  const testStreamPackageRoot = resolve(repoRoot, "packages/test-stream");
  const p4Env: NodeJS.ProcessEnv = {
    ...process.env,
    P4CLIENT: client
  };

  const p4Port = readOptionalEnv("P4_TS_E2E_P4PORT");
  const user = readOptionalEnv("P4_TS_E2E_USER");
  const p4Config = readOptionalEnv("P4_TS_E2E_P4CONFIG");

  if (p4Port) {
    p4Env.P4PORT = p4Port;
  }
  if (user) {
    p4Env.P4USER = user;
  }
  if (p4Config) {
    p4Env.P4CONFIG = p4Config;
  }

  return {
    enabled: true,
    config: {
      workspaceRoot,
      client,
      stream,
      user,
      host: readOptionalEnv("P4_TS_E2E_HOST"),
      p4Port,
      p4Config,
      allowOpenedScenarios: readBooleanEnv("P4_TS_E2E_ALLOW_OPENED_SCENARIOS"),
      allowSyncPreview: readBooleanEnv("P4_TS_E2E_ALLOW_SYNC_PREVIEW"),
      repoRoot,
      testStreamPackageRoot,
      workspaceRootName: basename(workspaceRoot),
      p4Env
    }
  };
}
