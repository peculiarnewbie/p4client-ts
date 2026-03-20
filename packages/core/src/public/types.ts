export type P4JsonValue =
  | string
  | number
  | boolean
  | null
  | P4JsonValue[]
  | { [key: string]: P4JsonValue };

export interface P4CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface P4CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowNonZeroExit?: boolean;
}

export type P4CommandExecutor = (
  command: string,
  args: string[],
  options: P4CommandOptions
) => Promise<P4CommandResult>;

export interface P4ClientOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  hostName?: string;
  pathExists?: (path: string) => boolean;
  executor?: P4CommandExecutor;
}

export interface P4EnvironmentSummary {
  hostName: string;
  p4Port: string | null;
  p4User: string | null;
  p4Client: string | null;
}

export interface P4JsonWorkspace {
  client: string;
  Stream?: string;
  Root: string;
  Host?: string;
  Owner: string;
  Access?: string;
  Update?: string;
}

export interface LocalWorkspaceCandidate {
  root: string;
  host: string | null;
}

export interface P4WorkspaceSummary {
  client: string;
  stream: string | null;
  root: string;
  host: string | null;
  owner: string;
  accessedAt: string | null;
  accessedAtIso: string | null;
  isCurrentClient: boolean;
}

export interface RunTaggedJsonOptions extends P4CommandOptions {
  prefixTaggedJsonFlags?: boolean;
}

export interface ListWorkspacesOptions {
  user?: string;
  hostName?: string;
  includeNonLocal?: boolean;
  refresh?: boolean;
}

export interface P4ListWorkspaceResult {
  environment: P4EnvironmentSummary;
  workspaces: P4WorkspaceSummary[];
}

export interface P4Service {
  getP4Environment: (refresh?: boolean) => import("effect").Effect.Effect<P4EnvironmentSummary, Error>;
  listP4Workspaces: (refresh?: boolean) => import("effect").Effect.Effect<P4WorkspaceSummary[], Error>;
}
