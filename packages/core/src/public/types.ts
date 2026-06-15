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
 * Source stream for a low-level command output event.
 */
export type P4CommandStreamSource = "stdout" | "stderr";

/**
 * Incremental command events emitted while a `p4` process is running.
 */
export type P4CommandStreamEvent =
  | { type: "start"; command: string; args: string[] }
  | { type: "line"; source: P4CommandStreamSource; line: string }
  | { type: "exit"; exitCode: number };

/**
 * Handle returned by progress-aware operations.
 */
export interface P4OperationHandle<TEvent, TResult> {
  /** Incremental events emitted while the operation runs. */
  events: AsyncIterable<TEvent>;
  /** Final typed result once the operation finishes. */
  result: Promise<TResult>;
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
  /** Kill the child process when it exceeds this duration in milliseconds. */
  timeoutMs?: number;
  /** Allow non-zero exits to be returned instead of throwing. */
  allowNonZeroExit?: boolean;
}

/**
 * Low-level execution options for raw observed `p4` commands.
 */
export interface WatchP4CommandOptions extends P4CommandOptions {}

/**
 * Injectable command runner used by {@link P4ClientOptions.executor}.
 */
export type P4CommandExecutor = (
  command: string,
  args: string[],
  options: P4CommandOptions
) => Promise<P4CommandResult>;

/**
 * Injectable streaming command runner used by progress-aware APIs.
 */
export type P4StreamingCommandExecutor = (
  command: string,
  args: string[],
  options: P4CommandOptions
) => P4OperationHandle<P4CommandStreamEvent, P4CommandResult>;

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
  /** Default timeout applied to raw and higher-level command execution. */
  timeoutMs?: number;
  /** Injectable command executor for tests or custom process handling. */
  executor?: P4CommandExecutor;
  /** Injectable streaming executor for progress-aware APIs and tests. */
  streamExecutor?: P4StreamingCommandExecutor;
}

/**
 * Known Perforce CLI settings used for connection and workspace selection.
 */
export interface P4CliSettings {
  P4PORT?: string;
  P4USER?: string;
  P4CLIENT?: string;
}

/**
 * Individual Perforce setting keys tracked by the local resolver.
 */
export type P4SettingKey = "P4PORT" | "P4USER" | "P4CLIENT";

/**
 * Named local configuration sources that can contribute Perforce settings.
 */
export type P4SettingsSource =
  | "p4v-app-settings"
  | "p4v-connection-map"
  | "cli"
  | "registry";

/**
 * Provenance entry describing which keys came from a local settings source.
 */
export interface P4SettingsContribution {
  source: P4SettingsSource;
  keys: P4SettingKey[];
}

/**
 * Final local settings plus provenance for each contributing source.
 */
export interface P4ResolvedSettings {
  settings: P4CliSettings;
  contributions: P4SettingsContribution[];
}

/**
 * Options for local settings resolution.
 */
export interface ResolveP4SettingsOptions {
  /** Ordered source precedence. Later sources only fill missing keys. */
  sources?: P4SettingsSource[];
  /** Override registry reads for tests or custom hosts. */
  readRegistry?: () => Promise<P4CliSettings>;
  /** Override `~/.p4qt/ApplicationSettings.xml` reads. */
  readP4vAppSettings?: () => Promise<P4CliSettings>;
  /** Override `~/.p4qt/connectionmap.xml` reads. */
  readP4vConnectionMap?: () => Promise<P4CliSettings>;
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
 * Options for resolving the current Perforce environment.
 */
export interface GetEnvironmentOptions {
  /** Ignore cached values and re-read the underlying sources. */
  refresh?: boolean;
  /** Resolve from the server or from local settings only. Defaults to `server`. */
  mode?: "server" | "local";
  /**
   * In `server` mode, also resolve local settings and use them to fill gaps or
   * prefer the configured `P4PORT` over the resolved server address.
   */
  resolveSettings?: boolean;
  /** Source precedence used when local settings are resolved. */
  settingsSources?: P4SettingsSource[];
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
  /** One or more file specs appended to the command. */
  fileSpec?: string | string[];
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
 * Filters for listing submitted changelists.
 */
export interface ListSubmittedChangelistsOptions {
  /** Depot/stream file spec, for example `//Project/main/...`. */
  fileSpec?: string | string[];
  /** Filter by client workspace. Prefer `fileSpec` for team-wide stream views. */
  client?: string | null;
  user?: string;
  /** Maximum rows to return. Defaults to 50. */
  limit?: number;
  /** Upper changelist cursor. Appended as `@<change>` for paging. */
  beforeChange?: number;
  /** Reserved for API consistency with cached methods. */
  refresh?: boolean;
}

/**
 * Normalized submitted changelist summary.
 */
export interface P4SubmittedChangelistSummary {
  change: number;
  client: string | null;
  user: string | null;
  status: "submitted";
  description: string | null;
  createdAt: string | null;
  createdAtIso: string | null;
}

/**
 * Paged submitted changelist list.
 */
export interface ListSubmittedChangelistsResult {
  items: P4SubmittedChangelistSummary[];
  hasMore: boolean;
  nextBeforeChange: number | null;
}

/**
 * Filters for listing shelved changelists.
 */
export interface ListShelvedChangelistsOptions {
  /** Depot/stream file spec, for example `//Project/main/...`. */
  fileSpec?: string | string[];
  /** Filter by client workspace. Prefer `fileSpec` for team-wide stream views. */
  client?: string | null;
  user?: string;
  /** Maximum rows to return. Defaults to 50. */
  limit?: number;
  /** Upper changelist cursor. Appended as `@<change>` for paging. */
  beforeChange?: number;
  /** Reserved for API consistency with cached methods. */
  refresh?: boolean;
}

/**
 * Normalized shelved changelist summary.
 */
export interface P4ShelvedChangelistSummary {
  change: number;
  client: string | null;
  user: string | null;
  status: "shelved";
  description: string | null;
  createdAt: string | null;
  createdAtIso: string | null;
}

/**
 * Paged shelved changelist list.
 */
export interface ListShelvedChangelistsResult {
  items: P4ShelvedChangelistSummary[];
  hasMore: boolean;
  nextBeforeChange: number | null;
}

export type P4ChangelistListStatus = "pending" | "submitted" | "shelved";

export type P4ChangelistListSummary =
  | P4PendingChangelistSummary
  | P4SubmittedChangelistSummary
  | P4ShelvedChangelistSummary;

/**
 * Filters for listing pending or submitted changelists through one endpoint.
 *
 * Pagination applies only when `status` is `submitted` or `shelved`.
 */
export interface ListChangelistsOptions {
  status: P4ChangelistListStatus;
  includeDefault?: boolean;
  limit?: number;
  beforeChange?: number;
  user?: string;
  client?: string | null;
  fileSpec?: string | string[];
  refresh?: boolean;
}

/**
 * Unified changelist list result.
 */
export interface ListChangelistsResult {
  items: P4ChangelistListSummary[];
  hasMore: boolean;
  nextBeforeChange: number | null;
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
  /** Workspace used to derive a local-root file spec when `fileSpec` is omitted. */
  workspace?: Pick<P4WorkspaceSummary, "root" | "stream">;
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
 * Best-effort parsed progress details from a Perforce progress line.
 */
export interface P4ProgressSnapshot {
  rawMessage: string;
  phase: string | null;
  completed: number | null;
  total: number | null;
  percent: number | null;
}

/**
 * Progress events emitted while previewing reconcile.
 */
export type P4ReconcileProgressEvent =
  | { type: "start"; command: string; args: string[]; progressRequested: boolean }
  | {
      type: "progress";
      source: P4CommandStreamSource;
      rawLine: string;
      snapshot: P4ProgressSnapshot | null;
    }
  | {
      type: "progress-unavailable";
      reason: "unsupported" | "not-emitted";
      message: string;
    }
  | { type: "complete"; result: P4ReconcilePreviewResult };

/**
 * Options for previewing `p4 sync`.
 */
export interface PreviewSyncOptions {
  fileSpec?: string | string[];
  /** Pass `-f` to force sync preview output. */
  force?: boolean;
  /** Pass `-k` to preview metadata updates without changing workspace files. */
  keepWorkspaceFiles?: boolean;
  /** Reserved for future client-side limiting. */
  maxFiles?: number | null;
  /** Reserved for API consistency with other higher-level methods. This is a no-op in v1. */
  refresh?: boolean;
}

/**
 * Options for performing `p4 sync`.
 */
export interface SyncOptions {
  fileSpec?: string | string[];
  /** Pass `-f` to force sync output. */
  force?: boolean;
  /** Pass `-k` to update workspace metadata without changing workspace files. */
  keepWorkspaceFiles?: boolean;
  /** Reserved for API consistency with other higher-level methods. This is a no-op in v1. */
  refresh?: boolean;
}

/**
 * Normalized sync row.
 */
export interface P4SyncItem {
  depotFile: string | null;
  clientFile: string | null;
  localFile: string | null;
  revision: number | null;
  action: string | null;
  fileSize: number | null;
}

/**
 * Result returned by `sync()`.
 */
export interface P4SyncResult {
  /** Individual sync rows emitted by Perforce. */
  items: P4SyncItem[];
  /** Per-file sync failures emitted as tagged error rows. Present only when non-empty. */
  errors?: P4SyncErrorItem[];
  /** Total number of sync rows. */
  totalCount: number;
}

/**
 * Per-file sync error parsed from tagged Perforce output.
 */
export interface P4SyncErrorItem {
  clientFile: string | null;
  depotFile: string | null;
  message: string;
}

/**
 * Sync result shape that always includes parsed error rows.
 */
export interface P4SyncResultWithErrors {
  items: P4SyncItem[];
  errors: P4SyncErrorItem[];
  totalCount: number;
}

/**
 * Progress events emitted while performing `p4 sync`.
 */
export type P4SyncProgressEvent =
  | { type: "start"; command: string; args: string[] }
  | { type: "progress"; item: P4SyncItem; filesSynced: number }
  | { type: "error-row"; error: P4SyncErrorItem }
  | { type: "complete"; result: P4SyncResultWithErrors };

/**
 * Options for changing the active Perforce client setting.
 */
export interface SetClientOptions {
  /** Client name to activate. */
  client: string;
  /** Clear cached environment/workspaces on this P4Client instance. Defaults to true. */
  invalidateCache?: boolean;
}

/**
 * Result returned by `setClient()`.
 */
export interface SetClientResult {
  ok: true;
  previousClient: string | null;
  newClient: string;
}

/**
 * Normalized sync preview row.
 */
export interface P4SyncPreviewItem extends P4SyncItem {}

/**
 * Preview result returned by `previewSync()`.
 */
export interface P4SyncPreviewResult extends P4SyncResult {}

/**
 * Compound shape containing the current environment and listed workspaces.
 */
export interface P4ListWorkspaceResult {
  environment: P4EnvironmentSummary;
  workspaces: P4WorkspaceSummary[];
}

/**
 * Options for {@link P4Client.describeChangelist}.
 */
export interface DescribeChangelistOptions {
  /** Override the client workspace used when resolving opened files. */
  client?: string | null;
  /** When true, describe shelved files via `p4 describe -S -s`. */
  shelved?: boolean;
  /** Reserved for API consistency with other higher-level methods. */
  refresh?: boolean;
}

/**
 * File row included in a changelist description.
 */
export interface P4DescribedFile {
  /** Depot path for the file. */
  depotFile: string;
  /** Open or submit action such as `add`, `edit`, or `delete`. */
  action: string;
  /** Perforce file type when reported. */
  type: string | null;
  /** Depot revision when reported. */
  revision: number | null;
}

/**
 * Normalized changelist description returned by `describeChangelist()`.
 */
export interface P4ChangelistDescription {
  change: number | "default";
  user: string | null;
  client: string | null;
  description: string | null;
  createdAt: string | null;
  createdAtIso: string | null;
  status: "pending" | "submitted";
  /** Present when the description was requested from opened or shelved content. */
  contentSource?: "opened" | "shelved";
  files: P4DescribedFile[];
}

/**
 * Whether a diff compared the workspace or two depot revisions.
 */
export type P4DiffSource = "workspace" | "depot";

/**
 * Options for {@link P4Client.diffFile}.
 */
export interface DiffFileOptions {
  /** Depot path for the file being diffed. */
  depotFile: string;
  /** Local workspace path for the result; not passed to Perforce. */
  localFile?: string;
  /**
   * Start revision for a depot-vs-depot comparison. Requires {@link toRevision}.
   *
   * Use `none` for a nonexistent revision, for example when diffing a newly
   * added file.
   */
  fromRevision?: string | number;
  /**
   * End revision for a depot-vs-depot comparison. Requires {@link fromRevision}.
   */
  toRevision?: string | number;
  /**
   * Open/submit action used to infer depot revisions when {@link changelistStatus}
   * is `submitted` or `shelved` and explicit revisions are omitted.
   */
  action?: string;
  /**
   * Submitted revision used with {@link action} for automatic depot-vs-depot
   * diffs.
   */
  revision?: number | null;
  /**
   * When `submitted` or `shelved`, compares depot revisions instead of the
   * workspace file. Pending changelists default to workspace diffs unless
   * explicit revisions are provided.
   */
  changelistStatus?: "pending" | "submitted" | "shelved";
  /**
   * Shelved changelist number used to build `@=<change>` shelf revisions.
   * Required when {@link changelistStatus} is `shelved` and explicit
   * `fromRevision`/`toRevision` are omitted.
   */
  shelvedChange?: number;
  /** Diff flags passed to `p4 diff` or `p4 diff2`. Defaults to `-du` (unified). */
  diffFlags?: string;
  /**
   * When `false`, binary files are detected from `type` and return an empty
   * diff with `isBinary: true` without invoking Perforce.
   */
  allowBinary?: boolean;
  /** Perforce file type used for binary detection when `allowBinary` is false. */
  type?: string | null;
}

/**
 * Unified diff result for a single file.
 */
export interface P4FileDiffResult {
  depotFile: string;
  localFile: string | null;
  /** Whether the workspace or two depot revisions were compared. */
  source: P4DiffSource;
  /** Start revision when {@link source} is `depot`. */
  fromRevision: string | number | null;
  /** End revision when {@link source} is `depot`. */
  toRevision: string | number | null;
  /** Unified diff text. Empty for binary files or when no diff is emitted. */
  unifiedDiff: string;
  isBinary: boolean;
  /**
   * Process exit code from `p4 diff` or `p4 diff2`.
   *
   * Perforce returns `1` when differences exist. That exit code is treated as
   * success by {@link P4Client.diffFile}; only exit codes `2` and above throw.
   */
  exitCode: number;
  additions: number;
  deletions: number;
}

/**
 * Options for {@link P4Client.printFile}.
 */
export interface PrintFileOptions {
  /** Depot revision to print. Defaults to `have`. */
  revision?: string | number;
}

/**
 * Depot file content returned by `printFile()`.
 */
export interface P4PrintResult {
  depotFile: string;
  revision: string | null;
  /**
   * Text content for non-binary files. Binary files return an empty string and
   * set `isBinary: true`.
   */
  content: string;
  isBinary: boolean;
  type: string | null;
}

/**
 * Parsed unified-diff hunk.
 */
export interface P4DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw diff body lines including context and `+`/`-` prefixes. */
  lines: string[];
}

/**
 * Per-file summary used by changelist diff views before patches are loaded.
 */
export interface P4ChangelistDiffFileSummary {
  depotFile: string;
  localFile: string | null;
  action: string;
  type: string | null;
  isBinary: boolean;
  additions: number | null;
  deletions: number | null;
  /** Patch bodies are always deferred in summary responses. */
  patchLoadState: "deferred";
}

/**
 * Changelist-level diff summary without per-file patch bodies.
 */
export interface P4ChangelistDiffSummary {
  changelist: P4ChangelistDescription;
  files: P4ChangelistDiffFileSummary[];
}

/**
 * Options for {@link P4Client.getChangelistDiffSummary}.
 */
export interface GetChangelistDiffSummaryOptions extends DescribeChangelistOptions {
  /**
   * When enabled, runs `diffFile()` for each non-binary file to populate line
   * counts. Defaults to `false` because large changelists can be slow.
   */
  includeLineCounts?: boolean;
  /** Maximum concurrent `diffFile()` calls when `includeLineCounts` is enabled. */
  concurrency?: number;
}

/**
 * Effect-based wrapper over the `P4Client` operations.
 */
export interface P4Service {
  getP4Environment: (
    options?: boolean | GetEnvironmentOptions
  ) => import("effect").Effect.Effect<P4EnvironmentSummary, Error>;
  listP4Workspaces: (refresh?: boolean) => import("effect").Effect.Effect<P4WorkspaceSummary[], Error>;
  listPendingChangelists: (
    options?: ListPendingChangelistsOptions
  ) => import("effect").Effect.Effect<P4PendingChangelistSummary[], Error>;
  listSubmittedChangelists: (
    options?: ListSubmittedChangelistsOptions
  ) => import("effect").Effect.Effect<ListSubmittedChangelistsResult, Error>;
  listShelvedChangelists: (
    options?: ListShelvedChangelistsOptions
  ) => import("effect").Effect.Effect<ListShelvedChangelistsResult, Error>;
  listChangelists: (
    options: ListChangelistsOptions
  ) => import("effect").Effect.Effect<ListChangelistsResult, Error>;
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
  streamPreviewReconcile: (
    options?: PreviewReconcileOptions
  ) => import("effect").Stream.Stream<P4ReconcileProgressEvent, Error>;
  previewSync: (
    options?: PreviewSyncOptions
  ) => import("effect").Effect.Effect<P4SyncPreviewResult, Error>;
  sync: (
    options?: SyncOptions
  ) => import("effect").Effect.Effect<P4SyncResult, Error>;
  streamSync: (
    options?: SyncOptions
  ) => import("effect").Stream.Stream<P4SyncProgressEvent, Error>;
  setClient: (
    options: SetClientOptions
  ) => import("effect").Effect.Effect<SetClientResult, Error>;
  switchWorkspace: (
    client: string
  ) => import("effect").Effect.Effect<SetClientResult, Error>;
  describeChangelist: (
    change: number | "default",
    options?: DescribeChangelistOptions
  ) => import("effect").Effect.Effect<P4ChangelistDescription, Error>;
  diffFile: (
    options: DiffFileOptions
  ) => import("effect").Effect.Effect<P4FileDiffResult, Error>;
  printFile: (
    depotFile: string,
    options?: PrintFileOptions
  ) => import("effect").Effect.Effect<P4PrintResult, Error>;
  getChangelistDiffSummary: (
    change: number | "default",
    options?: GetChangelistDiffSummaryOptions
  ) => import("effect").Effect.Effect<P4ChangelistDiffSummary, Error>;
}
