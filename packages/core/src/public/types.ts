/**
 * JSON-compatible value used by tagged Perforce JSON output.
 */
export type P4JsonValue =
  | string
  | number
  | boolean
  | null
  | P4JsonValue[]
  | { [key: string]: P4JsonValue };

/**
 * Raw result returned by a `p4` command execution.
 */
export interface P4CommandResult {
  /** Executable that was invoked. */
  command: string;
  /** Final argument vector passed to the command. */
  args: string[];
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
  /** Process exit code. */
  exitCode: number;
}

/**
 * Low-level execution options for raw `p4` commands.
 */
export interface P4CommandOptions {
  /** Working directory used for the command invocation. */
  cwd?: string;
  /** Environment variables merged into the child process. */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin content written to the child process. */
  input?: string;
  /** Allow non-zero exits to be returned instead of throwing. */
  allowNonZeroExit?: boolean;
}

/**
 * Injectable command runner used by {@link P4ClientOptions.executor}.
 */
export type P4CommandExecutor = (
  command: string,
  args: string[],
  options: P4CommandOptions
) => Promise<P4CommandResult>;

/**
 * Configuration for constructing a `P4Client`.
 */
export interface P4ClientOptions {
  /** Path or name of the `p4` executable. Defaults to `p4`. */
  executable?: string;
  /** Default working directory for later commands. */
  cwd?: string;
  /** Default environment variables merged into every command. */
  env?: NodeJS.ProcessEnv;
  /** Override the host name used for local-workspace detection. */
  hostName?: string;
  /** Injectable command executor for tests or custom process handling. */
  executor?: P4CommandExecutor;
}

/**
 * Common environment values resolved from `p4 info` and environment fallbacks.
 */
export interface P4EnvironmentSummary {
  /** Host name reported by Perforce or inferred locally. */
  hostName: string;
  /** Active `P4PORT` value, if known. */
  p4Port: string | null;
  /** Active `P4USER` value, if known. */
  p4User: string | null;
  /** Active `P4CLIENT` value, if known. */
  p4Client: string | null;
}

/**
 * Minimal tagged JSON row shape returned by `p4 clients -u`.
 */
export interface P4JsonWorkspace {
  client: string;
  Stream?: string;
  Root: string;
  Host?: string;
  Owner: string;
  Access?: string;
  Update?: string;
}

/**
 * Workspace fields needed to determine whether a client spec looks local.
 */
export interface LocalWorkspaceCandidate {
  host: string | null;
}

/**
 * Normalized workspace summary returned by `listWorkspaces()`.
 */
export interface P4WorkspaceSummary {
  /** Client workspace name. */
  client: string;
  /** Stream path when the workspace is stream-based. */
  stream: string | null;
  /** Local workspace root. */
  root: string;
  /** Host restriction configured on the client spec, if any. */
  host: string | null;
  /** Workspace owner. */
  owner: string;
  /** Last access/update timestamp as reported by Perforce. */
  accessedAt: string | null;
  /** ISO-8601 version of `accessedAt` when available. */
  accessedAtIso: string | null;
  /** Whether this workspace matches the current `P4CLIENT`. */
  isCurrentClient: boolean;
}

/**
 * Options for `runTaggedJson()`.
 */
export interface RunTaggedJsonOptions extends P4CommandOptions {
  /** Skip automatically prepending `-Mj -z tag`. */
  prefixTaggedJsonFlags?: boolean;
}

/**
 * Filters for listing user workspaces.
 */
export interface ListWorkspacesOptions {
  /** Override the Perforce user whose clients should be listed. */
  user?: string;
  /** Override the host name used for locality checks. */
  hostName?: string;
  /** Include remote/non-local workspaces in the results. */
  includeNonLocal?: boolean;
  /** Ignore cached values and re-query Perforce. */
  refresh?: boolean;
}

/**
 * Filters for listing pending changelists.
 */
export interface ListPendingChangelistsOptions {
  user?: string;
  client?: string | null;
  /** Include a synthesized default changelist entry when opened files exist. */
  includeDefault?: boolean;
  status?: "pending";
  /** Reserved for API consistency with other cached methods. */
  refresh?: boolean;
}

/**
 * Normalized pending changelist summary.
 */
export interface P4PendingChangelistSummary {
  change: number | "default";
  client: string | null;
  user: string | null;
  status: "pending";
  description: string | null;
  createdAt: string | null;
  createdAtIso: string | null;
  isDefault: boolean;
}

/**
 * Filters for listing opened files.
 */
export interface GetOpenedFilesOptions {
  user?: string;
  client?: string | null;
  change?: number | "default";
  /** One or more file specs appended to the command. */
  fileSpec?: string | string[];
  /** Reserved for API consistency with other higher-level methods. */
  refresh?: boolean;
}

/**
 * Flat row returned by `getOpenedFiles()` and `getChangelistFiles()`.
 */
export interface P4OpenedFileSummary {
  depotFile: string | null;
  clientFile: string | null;
  localFile: string | null;
  action: string;
  type: string | null;
  changelist: number | "default";
  changelistDescription: string | null;
  user: string | null;
  client: string | null;
  revision: number | null;
  isDefaultChangelist: boolean;
}

/**
 * Options for previewing `p4 reconcile`.
 */
export interface PreviewReconcileOptions {
  fileSpec?: string | string[];
  changelist?: number | "default";
  /** Pass `-m` to reconcile using file modification times. */
  useModTime?: boolean;
  /** Pass `-w` to include writable files. */
  includeWritable?: boolean;
  /** Reserved for API consistency with other higher-level methods. */
  refresh?: boolean;
}

/**
 * Normalized reconcile preview row.
 */
export interface P4ReconcileCandidate {
  depotFile: string | null;
  clientFile: string | null;
  localFile: string | null;
  action: "add" | "edit" | "delete";
  type: string | null;
  changelist: number | "default" | null;
}

/**
 * Grouped reconcile preview result keyed by preview action.
 */
export interface P4ReconcilePreviewResult {
  added: P4ReconcileCandidate[];
  edited: P4ReconcileCandidate[];
  deleted: P4ReconcileCandidate[];
}

/**
 * Options for previewing `p4 sync`.
 */
export interface PreviewSyncOptions {
  fileSpec?: string | string[];
  /** Pass `-f` to force sync preview output. */
  force?: boolean;
  /** Reserved for future parity with sync behavior. */
  keepWorkspaceFiles?: boolean;
  /** Reserved for future client-side limiting. */
  maxFiles?: number | null;
  /** Reserved for API consistency with other higher-level methods. */
  refresh?: boolean;
}

/**
 * Normalized sync preview row.
 */
export interface P4SyncPreviewItem {
  depotFile: string | null;
  clientFile: string | null;
  localFile: string | null;
  revision: number | null;
  action: string | null;
  fileSize: number | null;
}

/**
 * Preview result returned by `previewSync()`.
 */
export interface P4SyncPreviewResult {
  /** Individual preview rows emitted by Perforce. */
  items: P4SyncPreviewItem[];
  /** Total number of preview rows. */
  totalCount: number;
}

/**
 * Compound shape containing the current environment and listed workspaces.
 */
export interface P4ListWorkspaceResult {
  environment: P4EnvironmentSummary;
  workspaces: P4WorkspaceSummary[];
}

/**
 * Effect-based wrapper over the `P4Client` operations.
 */
export interface P4Service {
  getP4Environment: (refresh?: boolean) => import("effect").Effect.Effect<P4EnvironmentSummary, Error>;
  listP4Workspaces: (refresh?: boolean) => import("effect").Effect.Effect<P4WorkspaceSummary[], Error>;
  listPendingChangelists: (
    options?: ListPendingChangelistsOptions
  ) => import("effect").Effect.Effect<P4PendingChangelistSummary[], Error>;
  getOpenedFiles: (
    options?: GetOpenedFilesOptions
  ) => import("effect").Effect.Effect<P4OpenedFileSummary[], Error>;
  getChangelistFiles: (
    change: number | "default",
    options?: Omit<GetOpenedFilesOptions, "change">
  ) => import("effect").Effect.Effect<P4OpenedFileSummary[], Error>;
  previewReconcile: (
    options?: PreviewReconcileOptions
  ) => import("effect").Effect.Effect<P4ReconcilePreviewResult, Error>;
  previewSync: (
    options?: PreviewSyncOptions
  ) => import("effect").Effect.Effect<P4SyncPreviewResult, Error>;
}
