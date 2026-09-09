import { mkdir, stat } from 'node:fs/promises';
import { hostname as getHostName } from "node:os";
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Effect } from 'effect';
import type { Schema } from 'effect';
import { createAsyncEventQueue } from "../internal/async-queue.js";
import { createCancellationScope, ownOperation } from '../internal/cancellation.js';
import {
  AnnotationRow, AnnotationHeaderRow, MessageRow, ChangelistRow, DepotRow, DescribedFileRow, DirRow, FileRow,
  FileRevisionRow, HistoryRevisionRow, OpenedRow, StatRow, StreamRow, SyncRow,
  UserRow, WhereRow, decodeRow
} from '../internal/rows.js';
import {
  P4DepotPathSchema, P4ClientPathSchema, P4LocalPathSchema,
  P4JsonWorkspaceSchema
} from './schemas.js';
import { runCommand, watchCommand } from "../internal/command.js";
import { formatCommandArgs, redactCommandArgs } from "./command-format.js";
import {
  P4CommandError,
  P4ClientOperationError,
  P4MaterializationError,
  P4ParseError
} from "./errors.js";
import {
  isBinaryP4Type,
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  parseP4ProgressLine,
  parseP4JsonLines,
  parseP4KeyValueOutput,
  parseTaggedJsonLine,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requirePositiveTimeoutMs,
  resolveDiffPlan,
  summarizeUnifiedDiff,
  unixSecondsToIsoString,
  workspaceRootFileSpec
} from "./helpers.js";
import {
  mergeIncompleteSettings,
  parseP4SetOutput,
  resolveP4SettingsWithDetails
} from "./settings.js";
import type {
  DescribeChangelistOptions,
  DiffFileOptions,
  GetChangelistDiffSummaryOptions,
  GetEnvironmentOptions,
  GetOpenedFilesOptions,
  ListDepotFilesAtChangeOptions,
  ListDepotFilesAtChangeResult,
  ListDepotsOptions,
  ListDepotDirsOptions,
  ListDepotDirsResult,
  ListDepotFilesOptions,
  ListDepotFilesResult,
  P4Depot,
  P4DepotDir,
  P4DepotFileListing,
  P4FileStat,
  StatFilesOptions,
  WhereFilesOptions,
  P4WhereMapping,
  GetFileHistoryOptions,
  P4FileHistory,
  P4FileRevision,
  ListUsersOptions,
  P4User,
  ListStreamsOptions,
  P4Stream,
  AnnotateFileOptions,
  P4AnnotationResult,
  P4AnnotatedLine,
  ListChangelistsOptions,
  ListChangelistsResult,
  ListWorkspacesOptions,
  ListPendingChangelistsOptions,
  ListShelvedChangelistsOptions,
  ListShelvedChangelistsResult,
  ListSubmittedChangelistsOptions,
  ListSubmittedChangelistsResult,
  P4ChangelistDescription,
  P4ChangelistDiffFileSummary,
  P4ChangelistDiffSummary,
  P4CliSettings,
  P4ClientPath,
  P4DescribedFile,
  P4DepotPath,
  P4DepotFileRevision,
  P4FileAction,
  P4FileDiffResult,
  P4LocalPath,
  P4PendingChangelistSummary,
  P4ShelvedChangelistSummary,
  P4SubmittedChangelistSummary,
  P4ClientOptions,
  P4CommandOptions,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4OperationOptions,
  P4PrintResult,
  P4MaterializeResult,
  P4ReconcileProgressEvent,
  P4EnvironmentSummary,
  P4JsonWorkspace,
  P4OpenedFileSummary,
  P4ResolvedSettings,
  P4ReconcileCandidate,
  P4ReconcilePreviewResult,
  P4SettingsSource,
  P4SyncItem,
  P4SyncErrorItem,
  P4SyncProgressEvent,
  P4SyncResult,
  P4SyncResultWithErrors,
  P4SyncPreviewItem,
  P4SyncPreviewResult,
  P4WorkspaceSummary,
  PreviewReconcileOptions,
  PreviewSyncOptions,
  PrintFileOptions,
  MaterializeDepotFilesOptions,
  SetClientOptions,
  SetClientResult,
  SyncOptions,
  RunTaggedJsonOptions,
  WatchP4CommandOptions
} from "./types.js";

/**
 * Thin, typed wrapper around the Perforce `p4` CLI.
 *
 * `P4Client` focuses on typed Perforce inspection and preview-first workflows,
 * with opt-in mutating sync support. The instance caches environment and
 * workspace lookups unless a method is called with `refresh: true`.
 */
export class P4Client {
  readonly executable: string;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs: number | undefined;

  private readonly executor;
  private readonly streamExecutor;
  private readonly configuredHostName;
  private activeClient: string | null = null;
  private cacheEpoch = 0;
  private cachedEnvironment: P4EnvironmentSummary | null = null;
  private cachedWorkspaces: P4WorkspaceSummary[] | null = null;
  private cachedLocalEnvironment: { cacheKey: string; environment: P4EnvironmentSummary } | null = null;
  private cachedResolvedSettings: { cacheKey: string; resolved: P4ResolvedSettings } | null = null;

  /**
   * Create a reusable Perforce client.
   *
   * @param options Command configuration, environment overrides, and testing
   * hooks used by all later operations.
   */
  constructor(options: P4ClientOptions = {}) {
    this.executable = options.executable ?? "p4";
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs;
    this.configuredHostName = options.hostName;
    this.executor = options.executor ?? runCommand;
    this.streamExecutor = options.streamExecutor ?? watchCommand;
  }

  /**
   * Run a raw `p4` command.
   *
   * Environment variables from the current process, client defaults, and
   * per-call overrides are merged before execution.
   *
   * @throws {P4CommandError} When the command exits non-zero and
   * `allowNonZeroExit` was not enabled.
   */
  async run(args: string[], options: P4CommandOptions = {}): Promise<P4CommandResult> {
    options.signal?.throwIfAborted();
    const commandOptions = this.buildCommandOptions(options);
    const result = await this.executor(this.executable, args, commandOptions);
    options.signal?.throwIfAborted();

    if (result.exitCode !== 0 && !commandOptions.allowNonZeroExit) {
      throw this.toCommandError(args, result);
    }

    return result;
  }

  /**
   * Run a raw `p4` command and observe incremental output lines.
   *
   * The final result follows the same non-zero exit behavior as {@link run}.
   */
  watch(
    args: string[],
    options: WatchP4CommandOptions = {}
  ): P4OperationHandle<P4CommandStreamEvent, P4CommandResult> {
    const commandOptions = this.buildCommandOptions(options);
    options.signal?.throwIfAborted();
    const scope = createCancellationScope(options.signal);
    let handle: P4OperationHandle<P4CommandStreamEvent, P4CommandResult>;
    try {
      handle = this.streamExecutor(this.executable, args, { ...commandOptions, signal: scope.signal });
    } catch (error) {
      scope.dispose();
      throw error;
    }

    const result = handle.result.then((result) => {
      scope.signal.throwIfAborted();
      if (result.exitCode !== 0 && !commandOptions.allowNonZeroExit) {
        throw this.toCommandError(args, result);
      }

      return result;
    });
    // Event consumers can observe a failure before they await the final result.
    void result.catch(() => undefined);
    return ownOperation({ events: handle.events, result }, scope);
  }

  /**
   * Run a command and parse newline-delimited tagged JSON output.
   *
   * By default this method prefixes `-Mj -z tag` to the provided arguments.
   * Set `prefixTaggedJsonFlags` to `false` to pass fully-expanded arguments
   * yourself. Pass `schema` to validate rows and infer their decoded type.
   * Without a schema, fields remain `unknown`.
   *
   * @param args Perforce command arguments.
   * @param options Execution options and an optional Effect decoder.
   * @returns Validated rows, or raw object rows without a schema.
   * @throws {P4ParseError} When JSON or a row does not satisfy the schema.
   */
  runTaggedJson<A>(
    args: string[],
    options: RunTaggedJsonOptions & { schema: Schema.Decoder<A> }
  ): Promise<A[]>;
  runTaggedJson(args: string[], options?: RunTaggedJsonOptions): Promise<Record<string, unknown>[]>;
  async runTaggedJson(
    args: string[],
    options: RunTaggedJsonOptions & { schema?: Schema.Decoder<unknown> } = {}
  ): Promise<unknown[]> {
    options.signal?.throwIfAborted();
    const commandArgs = options.prefixTaggedJsonFlags === false
      ? args
      : ["-Mj", "-z", "tag", ...args];
    const result = await this.run(commandArgs, options);
    return options.schema === undefined
      ? parseP4JsonLines(result.stdout)
      : parseP4JsonLines(result.stdout, options.schema);
  }

  /**
   * Resolve common environment values from `p4 info` plus process environment
   * fallbacks.
   *
   * Results are cached per client instance unless `refresh` is requested.
   */
  async getEnvironment(options: GetEnvironmentOptions = {}): Promise<P4EnvironmentSummary> {
    options.signal?.throwIfAborted();
    if (options.mode === "local") {
      return this.getLocalEnvironment(options);
    }

    const shouldResolveSettings = options.resolveSettings === true || options.settingsSources !== undefined;
    if (!options.refresh && !shouldResolveSettings && this.cachedEnvironment) {
      return { ...this.cachedEnvironment };
    }

    const epoch = this.cacheEpoch;
    const resolvedSettings = shouldResolveSettings
      ? await this.resolveLocalSettings(options)
      : null;
    const result = await this.run(["info"], options);
    const info = parseP4KeyValueOutput(result.stdout);

    // Effective env mirrors the same merge order used by run() so that what
    // getEnvironment() reports matches what commands actually use.
    const effectiveEnv = this.getMergedEnv();

    const environment: P4EnvironmentSummary = {
      // Explicit constructor hostName wins over p4 info for locality overrides.
      hostName: this.configuredHostName ?? info["Client host"] ?? getHostName(),
      // "Server address" from p4 info is the resolved internal address which
      // may not be reachable from the client (e.g. behind a proxy or using
      // SSL).  The configured P4PORT is what actually works for connections.
      p4Port: resolvedSettings?.settings.P4PORT ?? effectiveEnv.P4PORT ?? info["Server address"] ?? null,
      // "User name" and "Client name" from p4 info are authoritative — the
      // server resolved them from tickets, env, and client specs.  Env vars
      // are only a last-resort fallback when the server doesn't report them.
      p4User: info["User name"] ?? resolvedSettings?.settings.P4USER ?? effectiveEnv.P4USER ?? null,
      p4Client: info["Client name"] ?? resolvedSettings?.settings.P4CLIENT ?? effectiveEnv.P4CLIENT ?? null
    };

    options.signal?.throwIfAborted();
    if (!shouldResolveSettings && epoch === this.cacheEpoch) {
      this.cachedEnvironment = environment;
    }

    return { ...environment };
  }

  /**
   * List Perforce workspaces for a user.
   *
   * By default only workspaces that appear local to the current machine are
   * returned. Locality uses an exact host match when the client spec has a
   * `Host`, and for hostless specs checks whether the workspace root exists
   * on disk (hostless clients are otherwise usable from any machine).
   *
   * Results are cached when the default local-workspace query is used.
   *
   * @throws {Error} When no user can be resolved from the options or current
   * environment.
   */
  async listWorkspaces(options: ListWorkspacesOptions = {}): Promise<P4WorkspaceSummary[]> {
    options.signal?.throwIfAborted();
    if (!options.refresh && !options.user && !options.hostName && !options.includeNonLocal && this.cachedWorkspaces) {
      return this.cachedWorkspaces.map((workspace) => ({ ...workspace }));
    }

    const epoch = this.cacheEpoch;
    const environment = await this.getEnvironment(options);
    const user = options.user ?? environment.p4User;
    if (!user) {
      throw new Error("P4USER is not configured.");
    }

    const hostName = options.hostName ?? environment.hostName;
    const allWorkspaces = await this.runTaggedJson(['clients', '-u', user], {
      ...options,
      schema: P4JsonWorkspaceSchema
    });

    const workspaces = allWorkspaces
      .filter((workspace) => {
        if (options.includeNonLocal) return true;
        return isLocalWorkspace(
          { host: workspace.Host ?? null, root: workspace.Root ?? null },
          hostName
        );
      })
      .map((workspace) => this.toWorkspaceSummary(workspace, environment))
      .sort((left, right) => {
        const rootCompare = left.root.localeCompare(right.root);
        if (rootCompare !== 0) return rootCompare;
        return left.client.localeCompare(right.client);
      });

    options.signal?.throwIfAborted();
    if (!options.user && !options.hostName && !options.includeNonLocal && epoch === this.cacheEpoch) {
      this.cachedWorkspaces = workspaces;
    }

    return workspaces.map((workspace) => ({ ...workspace }));
  }

  /**
   * Switch the active client for this `P4Client` instance.
   *
   * Persists `P4CLIENT` via `p4 set` and also applies an instance-local
   * override so later commands use the new client even when constructor `env`
   * or `P4CONFIG` would otherwise take precedence over `p4 set` values.
   */
  async setClient(options: SetClientOptions): Promise<SetClientResult> {
    options.signal?.throwIfAborted();
    const environment = await this.getEnvironment(options);
    await this.run(["set", `P4CLIENT=${options.client}`], options);
    this.activeClient = options.client;

    if (options.invalidateCache !== false) {
      this.clearCaches();
    }

    return {
      ok: true,
      previousClient: environment.p4Client,
      newClient: options.client
    };
  }

  /**
   * Convenience alias for {@link setClient}.
   */
  async switchWorkspace(client: string, options: P4OperationOptions = {}): Promise<SetClientResult> {
    options.signal?.throwIfAborted();
    return this.setClient({ ...options, client });
  }

  /**
   * List pending changelists for a user or client.
   *
   * When `includeDefault` is enabled, this method may synthesize a default
   * changelist entry by querying `p4 opened -c default` if Perforce does not
   * return it in the normal `changes` output.
   */
  async listPendingChangelists(
    options: ListPendingChangelistsOptions = {}
  ): Promise<P4PendingChangelistSummary[]> {
    options.signal?.throwIfAborted();
    const commandArgs = ["changes", "-s", options.status ?? "pending"];
    if (options.limit !== undefined) {
      commandArgs.push("-m", String(requirePositiveInteger(options.limit, "limit")));
    }
    if (options.user) {
      commandArgs.push("-u", options.user);
    }
    if (options.client) {
      commandArgs.push("-c", options.client);
    }
    this.appendFileSpecs(commandArgs, options.fileSpec);

    const changes = await this.runTaggedJson(commandArgs, options);
    const summaries = changes.map((change) => this.toPendingChangelistSummary(change));
    const includeDefault = options.includeDefault ?? true;

    if (!includeDefault || summaries.some((summary) => summary.isDefault)) {
      return summaries;
    }

    const defaultOpenedOptions: GetOpenedFilesOptions = { ...options, change: "default" };
    if (options.user !== undefined) {
      defaultOpenedOptions.user = options.user;
    }
    if (options.client !== undefined) {
      defaultOpenedOptions.client = options.client;
    }
    if (options.fileSpec !== undefined) {
      defaultOpenedOptions.fileSpec = options.fileSpec;
    }

    const defaultOpened = await this.getOpenedFiles(defaultOpenedOptions);

    if (defaultOpened.length === 0) {
      return summaries;
    }

    const defaultClient = options.client ?? defaultOpened[0]?.client ?? null;
    const defaultUser = options.user ?? defaultOpened[0]?.user ?? null;
    const defaultDescription = defaultOpened[0]?.changelistDescription ?? "Default changelist";

    return [
      {
        change: "default",
        client: defaultClient,
        user: defaultUser,
        status: "pending",
        description: defaultDescription,
        createdAt: null,
        createdAtIso: null,
        isDefault: true
      },
      ...summaries
    ];
  }

  /**
   * List submitted changelists for a user, client, or file spec.
   *
   * For stream/team views, prefer `fileSpec` such as `//Project/main/...`
   * instead of `client`, which scopes results to one workspace.
   */
  async listSubmittedChangelists(
    options: ListSubmittedChangelistsOptions = {}
  ): Promise<ListSubmittedChangelistsResult> {
    options.signal?.throwIfAborted();
    return this.listNumberedChangelists(
      "submitted",
      options,
      (row) => this.toSubmittedChangelistSummary(row)
    );
  }

  /**
   * List shelved changelists for a user, client, or file spec.
   */
  async listShelvedChangelists(
    options: ListShelvedChangelistsOptions = {}
  ): Promise<ListShelvedChangelistsResult> {
    options.signal?.throwIfAborted();
    return this.listNumberedChangelists(
      "shelved",
      options,
      (row) => this.toShelvedChangelistSummary(row)
    );
  }

  /**
   * List pending, submitted, or shelved changelists through a single discriminated API.
   *
   * Pagination fields are populated only for submitted and shelved changelists.
   */
  async listChangelists(options: ListChangelistsOptions): Promise<ListChangelistsResult> {
    options.signal?.throwIfAborted();
    if (options.status === "submitted") {
      return this.listSubmittedChangelists(options);
    }
    if (options.status === "shelved") {
      return this.listShelvedChangelists(options);
    }

    const pendingOptions: ListPendingChangelistsOptions = {
      ...options,
      status: "pending"
    };
    if (options.includeDefault !== undefined) pendingOptions.includeDefault = options.includeDefault;
    if (options.user !== undefined) pendingOptions.user = options.user;
    if (options.client !== undefined) pendingOptions.client = options.client;
    if (options.fileSpec !== undefined) pendingOptions.fileSpec = options.fileSpec;
    if (options.refresh !== undefined) pendingOptions.refresh = options.refresh;

    const items = await this.listPendingChangelists(pendingOptions);
    return {
      items,
      hasMore: false,
      nextBeforeChange: null
    };
  }

  /**
   * List opened files as a flat typed array.
   *
   * Callers can filter by user, client, changelist, or file spec and can
   * regroup the returned rows in their own UI.
   */
  async getOpenedFiles(options: GetOpenedFilesOptions = {}): Promise<P4OpenedFileSummary[]> {
    options.signal?.throwIfAborted();
    const commandArgs = ["opened"];
    if (options.user) {
      commandArgs.push("-u", options.user);
    }
    if (options.client) {
      commandArgs.push("-C", options.client);
    }
    if (options.change !== undefined) {
      commandArgs.push("-c", String(options.change));
    }
    this.appendFileSpecs(commandArgs, options.fileSpec);

    const files = await this.runTaggedJson(commandArgs, options);
    return files.map((file) => this.toOpenedFileSummary(file));
  }

  /**
   * List files opened in a specific changelist.
   */
  async getChangelistFiles(
    change: number | "default",
    options: Omit<GetOpenedFilesOptions, "change"> = {}
  ): Promise<P4OpenedFileSummary[]> {
    options.signal?.throwIfAborted();
    return this.getOpenedFiles({ ...options, change });
  }

  /**
   * Describe a changelist and return its metadata plus file rows.
   *
   * Numbered changelists use `p4 describe -s`. The default changelist falls
   * back to `p4 opened -c default` because `describe` does not apply there.
   */
  async describeChangelist(
    change: number | "default",
    options: DescribeChangelistOptions = {}
  ): Promise<P4ChangelistDescription> {
    options.signal?.throwIfAborted();
    if (change === "default") {
      if (options.shelved) {
        throw new Error("Shelved changelist descriptions require a numbered changelist.");
      }
      return this.describeDefaultChangelist(options);
    }

    const commandArgs = options.shelved
      ? ["describe", "-S", "-s", String(change)]
      : ["describe", "-s", String(change)];
    const rows = await this.runTaggedJson(commandArgs, options);
    return this.toChangelistDescription(
      change,
      rows,
      options.shelved ? "shelved" : undefined
    );
  }

  /**
   * Return a unified diff for a changelist file.
   *
   * Pending changelists compare the workspace file against depot `#have` via
   * `p4 diff`. Submitted changelists compare two depot revisions via
   * `p4 diff2`, either inferred from `action`/`revision` or supplied through
   * `fromRevision`/`toRevision`.
   *
   * `p4 diff` and `p4 diff2` exit with code `1` when differences exist. This
   * method treats exit codes `0` and `1` as success and only throws for exit
   * code `2` or higher.
   */
  async diffFile(options: DiffFileOptions): Promise<P4FileDiffResult> {
    options.signal?.throwIfAborted();
    const allowBinary = options.allowBinary ?? true;
    const isBinary = isBinaryP4Type(options.type);

    if (!allowBinary && isBinary) {
      const source: P4FileDiffResult["source"] =
        options.changelistStatus === "submitted"
        || options.changelistStatus === "shelved"
        || (options.fromRevision !== undefined && options.toRevision !== undefined)
          ? "depot"
          : "workspace";

      return {
        depotFile: decodeRow(P4DepotPathSchema, options.depotFile),
        localFile: this.toLocalPath(options.localFile),
        source,
        fromRevision: null,
        toRevision: null,
        unifiedDiff: "",
        isBinary: true,
        exitCode: 0,
        additions: 0,
        deletions: 0
      };
    }

    const plan = resolveDiffPlan(options);
    const result = await this.run([plan.command, ...plan.args], {
      ...options,
      allowNonZeroExit: true
    });

    if (result.exitCode > 1) {
      throw this.toCommandError([plan.command, ...plan.args], result);
    }

    const unifiedDiff = result.stdout;
    const { additions, deletions } = summarizeUnifiedDiff(unifiedDiff);

    return {
      depotFile: decodeRow(P4DepotPathSchema, options.depotFile),
      localFile: this.toLocalPath(options.localFile),
      source: plan.source,
      fromRevision: plan.fromRevision,
      toRevision: plan.toRevision,
      unifiedDiff,
      isBinary: false,
      exitCode: result.exitCode,
      additions,
      deletions
    };
  }

  /**
   * Print depot file content at a revision.
   *
   * Binary files return `isBinary: true` with empty `content` without fetching
   * the payload. Text files return UTF-8 string content from a quiet print.
   */
  async printFile(depotFile: string, options: PrintFileOptions = {}): Promise<P4PrintResult> {
    options.signal?.throwIfAborted();
    const revision = options.revision ?? "have";
    const filespec = `${depotFile}#${revision}`;
    const fileRows = await this.runTaggedJson(["files", filespec], options);
    const meta = fileRows[0];
    if (!meta) {
      throw new Error(`Unable to resolve depot file metadata for ${filespec}.`);
    }

    const parsed = decodeRow(FileRow, meta);
    const type = normalizeNullableString(parsed.type);
    const resolvedDepotFile = parsed.depotFile;
    const resolvedRevision = (parsed.rev == null ? null : String(parsed.rev))
      ?? (typeof revision === "number" || revision !== "have" ? String(revision) : null);

    if (isBinaryP4Type(type)) {
      return {
        depotFile: resolvedDepotFile,
        revision: resolvedRevision,
        content: "",
        isBinary: true,
        type
      };
    }

    const result = await this.run(["print", "-q", filespec], options);
    return {
      depotFile: resolvedDepotFile,
      revision: resolvedRevision,
      content: result.stdout,
      isBinary: false,
      type
    };
  }

  /**
   * List exact file revisions that existed beneath a depot path when a
   * submitted changelist was created.
   *
   * The query uses `p4 files -e`, so deleted, purged, and archived revisions
   * are omitted. One extra row is requested to report whether the bounded
   * result was truncated.
   *
   * @param options Depot path, submitted changelist, and result bound.
   * @returns Exact revisions plus a `hasMore` truncation indicator.
   * @throws {P4ParseError} When Perforce returns malformed revision metadata.
   */
  async listDepotFilesAtChange(
    options: ListDepotFilesAtChangeOptions
  ): Promise<ListDepotFilesAtChangeResult> {
    options.signal?.throwIfAborted();
    const maxFiles = requirePositiveInteger(options.maxFiles, "maxFiles");
    const change = requirePositiveInteger(options.change, "change");
    if (!Number.isSafeInteger(maxFiles) || maxFiles === Number.MAX_SAFE_INTEGER) {
      throw new Error("maxFiles must be smaller than Number.MAX_SAFE_INTEGER.");
    }
    if (!options.depotPath.startsWith("//") || /[#@]/.test(options.depotPath)) {
      throw new Error("depotPath must use depot syntax without a revision specifier.");
    }

    const rows = await this.runTaggedJson([
      "files",
      "-e",
      "-m",
      String(maxFiles + 1),
      `${options.depotPath}@${change}`
    ], options);
    const hasMore = rows.length > maxFiles;
    const items = rows
      .slice(0, maxFiles)
      .map((row) => this.toDepotFileRevision(row));

    return { items, hasMore };
  }

  /**
   * List the top-level depots on the server via `p4 depots`.
   *
   * These are the roots of the depot tree that {@link listDepotDirs} and
   * {@link listDepotFiles} expand.
   */
  async listDepots(options: ListDepotsOptions = {}): Promise<P4Depot[]> {
    options.signal?.throwIfAborted();
    const args = ["-Mj", "-z", "tag", "depots"];
    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'name' in row);
    return rows.map((row) => this.toDepot(row));
  }

  /**
   * List the immediate subdirectories beneath a depot path via `p4 dirs`.
   *
   * This is the primitive for lazy tree expansion: one call returns the folder
   * nodes at a single level without pulling the recursive subtree. `p4 dirs`
   * has no server-side limit, so `maxResults` is applied client-side.
   *
   * An empty or non-existent directory resolves to an empty list rather than
   * throwing.
   */
  async listDepotDirs(options: ListDepotDirsOptions): Promise<ListDepotDirsResult> {
    options.signal?.throwIfAborted();
    const base = this.normalizeBrowseDir(options.depotPath);
    const spec = this.appendAtChange(`${base}/*`, options.atChange);
    const args = ["-Mj", "-z", "tag", "dirs", spec];
    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'dir' in row);

    const allItems = rows.map((row) => this.toDepotDir(row));
    if (options.maxResults === undefined) {
      return { items: allItems, hasMore: false };
    }

    const maxResults = requirePositiveInteger(options.maxResults, "maxResults");
    return {
      items: allItems.slice(0, maxResults),
      hasMore: allItems.length > maxResults
    };
  }

  /**
   * List the immediate files beneath a depot path via `p4 files`.
   *
   * The single-level `/*` wildcard keeps the listing to one directory level.
   * Head-deleted files are excluded by default; see
   * {@link ListDepotFilesOptions.deletedFiles}. An empty or non-existent
   * directory resolves to an empty list rather than throwing.
   */
  async listDepotFiles(options: ListDepotFilesOptions): Promise<ListDepotFilesResult> {
    options.signal?.throwIfAborted();
    const base = this.normalizeBrowseDir(options.depotPath);
    const spec = this.appendAtChange(`${base}/*`, options.atChange);
    const deletedFiles = options.deletedFiles ?? "exclude";
    const maxResults = options.maxResults === undefined
      ? undefined
      : requirePositiveInteger(options.maxResults, "maxResults");

    const args = ["-Mj", "-z", "tag", "files"];
    // `p4 files -m` counts head-deleted revisions, so a server-side bound only
    // stays exact when no client-side delete filtering follows. When filtering,
    // list the whole level and bound client-side (single-level, so bounded in
    // practice) to keep both items and hasMore exact.
    if (deletedFiles === "include" && maxResults !== undefined) {
      args.push("-m", String(maxResults + 1));
    }
    args.push(spec);

    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'depotFile' in row);

    const listings = rows
      .map((row) => this.toDepotFileListing(row))
      .filter((listing) => {
        if (deletedFiles === "include") return true;
        if (deletedFiles === "only") return listing.isDeletedAtHead;
        return !listing.isDeletedAtHead;
      });

    if (maxResults === undefined) {
      return { items: listings, hasMore: false };
    }

    return {
      items: listings.slice(0, maxResults),
      hasMore: listings.length > maxResults
    };
  }

  /**
   * Resolve rich per-file metadata via `p4 fstat`.
   *
   * All file specs are statted in a single `p4 fstat` call, making this the
   * batching primitive for explorer badges: out-of-date state, head/have
   * revisions, type, size, and concurrent-open information. Use `fields` to
   * narrow the returned columns and `includeFileSize` to opt into size/digest.
   *
   * Files that do not exist resolve to no rows rather than throwing.
   */
  async statFiles(options: StatFilesOptions): Promise<P4FileStat[]> {
    options.signal?.throwIfAborted();
    const specs = Array.isArray(options.fileSpec) ? options.fileSpec : [options.fileSpec];
    if (specs.length === 0) {
      return [];
    }

    const args = ["-Mj", "-z", "tag", "fstat"];
    if (options.maxResults !== undefined) {
      args.push("-m", String(requirePositiveInteger(options.maxResults, "maxResults")));
    }
    if (options.includeFileSize) {
      args.push("-Ol");
    }
    if (options.fields && options.fields.length > 0) {
      args.push("-T", options.fields.join(" "));
    }
    for (const spec of specs) {
      args.push(this.appendAtChange(spec, options.atChange));
    }

    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'depotFile' in row);
    return rows.map((row) => this.toFileStat(row));
  }

  /**
   * Map file specs across depot, client, and local syntax via `p4 where`.
   *
   * Use this for "reveal in workspace" / "open in editor" actions and to
   * resolve arbitrary depot paths to filesystem paths. Specs outside the client
   * view resolve to no rows rather than throwing. A client view with
   * overlapping or exclusionary lines can produce multiple rows per spec;
   * exclusion rows are flagged with {@link P4WhereMapping.isExcluded}.
   */
  async whereFiles(options: WhereFilesOptions): Promise<P4WhereMapping[]> {
    options.signal?.throwIfAborted();
    const specs = Array.isArray(options.fileSpec) ? options.fileSpec : [options.fileSpec];
    if (specs.length === 0) {
      return [];
    }

    const args = ["-Mj", "-z", "tag", "where", ...specs];
    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'depotFile' in row);
    return rows.map((row) => this.toWhereMapping(row));
  }

  /**
   * Return a file's revision history via `p4 filelog`.
   *
   * Full changelist descriptions are requested with `-l`. Set `followBranches`
   * to trace history across integrations, branches, and renames. A
   * non-existent file resolves to an empty revision list rather than throwing.
   *
   * `p4 filelog` emits one row per depot path, and several paths come back not
   * only from `-i` but also from a wildcard spec and from a renamed file, whose
   * ancestry Perforce reports even without `-i`. Revisions from every path are
   * merged into one list
   * ordered by changelist descending, each tagged with its originating
   * {@link P4FileRevision.depotFile}, and `maxRevisions` bounds that merged
   * total.
   */
  async getFileHistory(options: GetFileHistoryOptions): Promise<P4FileHistory> {
    options.signal?.throwIfAborted();
    const maxRevisions =
      options.maxRevisions === undefined
        ? undefined
        : requirePositiveInteger(options.maxRevisions, "maxRevisions");

    const args = ["-Mj", "-z", "tag", "filelog", "-l"];
    if (options.followBranches) {
      args.push("-i");
    }
    if (maxRevisions !== undefined) {
      args.push("-m", String(maxRevisions));
    }
    args.push(options.depotFile);

    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'depotFile' in row);

    const row = rows[0];
    if (!row) {
      return { depotFile: decodeRow(P4DepotPathSchema, options.depotFile), revisions: [] };
    }

    // `-m N` bounds each path separately, so the merged list can exceed the
    // requested total and has to be sliced here. Taking the head path from the
    // first row rather than from `options.depotFile` keeps client and local
    // specs resolved to depot syntax; with `-i` the first row is the requested
    // path, never an ancestor.
    const merged = this.mergeFileRevisions(rows);
    return {
      depotFile: decodeRow(P4DepotPathSchema, row.depotFile, row),
      revisions: maxRevisions === undefined ? merged : merged.slice(0, maxRevisions)
    };
  }

  /**
   * Resolve Perforce users via `p4 users` for display and attribution.
   *
   * Pass `users` to resolve specific identifiers, or omit it to list all users.
   * This turns raw user IDs on changelists and file revisions into full names
   * and emails.
   */
  async listUsers(options: ListUsersOptions = {}): Promise<P4User[]> {
    options.signal?.throwIfAborted();
    const args = ["-Mj", "-z", "tag", "users"];
    if (options.maxResults !== undefined) {
      args.push("-m", String(requirePositiveInteger(options.maxResults, "maxResults")));
    }
    if (options.users && options.users.length > 0) {
      args.push(...options.users);
    }

    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'User' in row);
    return rows.map((row) => this.toUser(row));
  }

  /**
   * List streams via `p4 streams`.
   *
   * Each result carries its `parent`, so callers can assemble the stream
   * hierarchy of a stream depot without additional queries. Scope the listing
   * with `fileSpec` such as `//Project/...`.
   */
  async listStreams(options: ListStreamsOptions = {}): Promise<P4Stream[]> {
    options.signal?.throwIfAborted();
    const args = ["-Mj", "-z", "tag", "streams"];
    if (options.maxResults !== undefined) {
      args.push("-m", String(requirePositiveInteger(options.maxResults, "maxResults")));
    }
    this.appendFileSpecs(args, options.fileSpec);

    const result = await this.runBrowse(args, options.signal);
    const rows = this.selectDataRows(args, result, (row) => 'Stream' in row);
    return rows.map((row) => this.toStream(row));
  }

  /**
   * Return line-by-line blame for a text file via `p4 annotate`.
   *
   * Lines are annotated with the changelist that last modified them
   * (`p4 annotate -c`), which callers can join with {@link getFileHistory} or
   * {@link describeChangelist} to resolve authors and descriptions. Set
   * `followIntegrations` to attribute lines to their integration source. A
   * non-existent file resolves to an empty line list rather than throwing.
   */
  async annotateFile(options: AnnotateFileOptions): Promise<P4AnnotationResult> {
    options.signal?.throwIfAborted();
    const spec = this.appendRevision(options.depotFile, options.revision);
    const args = ["-Mj", "-z", "tag", "annotate", "-q", "-c"];
    if (options.followIntegrations) {
      args.push("-I");
    }
    args.push(spec);

    const result = await this.runBrowse(args, options.signal);
    const rows = parseP4JsonLines(result.stdout);

    let depotFile: P4DepotPath | null = null;
    let revision: string | null = null;
    let hasFatal = false;
    const lines: P4AnnotatedLine[] = [];

    for (const row of rows) {
      // Annotated line rows always carry `upper` (the changelist from `-c`).
      // Message rows such as "no such file(s)" carry `data` but no `upper`, so
      // keying on `upper` alone avoids misreading them as content lines.
      if (row.upper !== undefined) {
        const parsed = decodeRow(AnnotationRow, row);
        lines.push({
          line: lines.length + 1,
          change: parsed.upper,
          data: this.stripTrailingNewline(parsed.data)
        });
        continue;
      }

      if ('depotFile' in row) {
        const parsed = decodeRow(AnnotationHeaderRow, row);
        depotFile = parsed.depotFile;
        revision = normalizeNullableString(parsed.rev);
        continue;
      }

      const severity = normalizeNullableNumber(row.severity);
      if (severity !== null && severity >= 3) {
        hasFatal = true;
      }
    }

    if (hasFatal) {
      throw this.toCommandError(args, result);
    }
    if (rows.length === 0 && result.exitCode !== 0) {
      throw this.toCommandError(args, result);
    }

    return {
      depotFile: depotFile ?? decodeRow(P4DepotPathSchema, options.depotFile),
      revision,
      lines
    };
  }

  /**
   * Download exact depot revisions into a caller-provided temporary directory.
   *
   * Each revision is written by `p4 print -o`, keeping file payloads out of
   * this client's text stdout capture. Files are placed beneath
   * `<directory>/<depot>/<path>` and no workspace sync or mutation command is
   * used.
   *
   * @param options Exact revisions, destination directory, and hard file bound.
   * @returns Local paths for all successfully materialized revisions.
   * @throws {P4MaterializationError} When the bound, depot path, or destination
   * directory is invalid.
   */
  async materializeDepotFiles(
    options: MaterializeDepotFilesOptions
  ): Promise<P4MaterializeResult> {
    options.signal?.throwIfAborted();
    const maxFiles = requirePositiveInteger(options.maxFiles, "maxFiles");
    const concurrency = requirePositiveInteger(options.concurrency ?? 4, "concurrency");
    if (options.files.length > maxFiles) {
      throw new P4MaterializationError(
        `Refusing to materialize ${options.files.length} files; maxFiles is ${maxFiles}.`,
        "limit_exceeded"
      );
    }

    const destinationDirectory = resolve(this.cwd ?? process.cwd(), options.directory);
    try {
      const destinationStat = await stat(destinationDirectory);
      if (!destinationStat.isDirectory()) {
        throw new Error("Destination is not a directory.");
      }
    } catch (error) {
      throw new P4MaterializationError(
        `Materialization directory is unavailable: ${destinationDirectory}`,
        "invalid_destination",
        error
      );
    }

    const seenTargets = new Set<string>();
    options.signal?.throwIfAborted();
    const plans = options.files.map((file) => {
      const outputPath = this.getMaterializedFilePath(destinationDirectory, file.depotFile);
      const targetKey = process.platform === "win32" ? outputPath.toLowerCase() : outputPath;
      if (seenTargets.has(targetKey)) {
        throw new P4MaterializationError(
          `Multiple revisions resolve to the same output path: ${file.depotFile}`,
          "invalid_depot_path"
        );
      }
      seenTargets.add(targetKey);
      return { file, outputPath };
    });

    const items = await this.mapWithConcurrency(plans, concurrency, async (plan) => {
      options.signal?.throwIfAborted();
      await mkdir(dirname(plan.outputPath), { recursive: true });
      await this.run([
        "print",
        "-q",
        "-K",
        "-o",
        plan.outputPath,
        `${plan.file.depotFile}#${plan.file.revision}`
      ], options);

      return {
        file: plan.file,
        localPath: decodeRow(P4LocalPathSchema, plan.outputPath)
      };
    });

    return {
      directory: decodeRow(P4LocalPathSchema, destinationDirectory),
      items,
      totalCount: items.length
    };
  }

  /**
   * Return a changelist file tree suitable for lazy diff loading.
   *
   * Patch bodies are not loaded unless `includeLineCounts` is enabled.
   */
  async getChangelistDiffSummary(
    change: number | "default",
    options: GetChangelistDiffSummaryOptions = {}
  ): Promise<P4ChangelistDiffSummary> {
    options.signal?.throwIfAborted();
    const changelist = await this.describeChangelist(change, options);
    const openedLookup = options.shelved || changelist.status === "submitted"
      ? new Map<string, P4OpenedFileSummary>()
      : await this.getOpenedFileLookup(change, options);
    const includeLineCounts = options.includeLineCounts ?? false;
    const concurrency = requirePositiveInteger(options.concurrency ?? 3, "concurrency");

    const baseSummaries = changelist.files.map((file) =>
      this.toChangelistDiffFileSummary(file, openedLookup.get(file.depotFile) ?? null)
    );

    if (!includeLineCounts) {
      return { changelist, files: baseSummaries };
    }

    const describedFiles = new Map(changelist.files.map((file) => [file.depotFile, file]));
    const files = await this.mapWithConcurrency(
      baseSummaries,
      concurrency,
      async (summary) => {
        options.signal?.throwIfAborted();
        if (summary.isBinary) {
          return summary;
        }

        const describedFile = describedFiles.get(summary.depotFile);
        const diffOptions: DiffFileOptions = {
          ...options,
          depotFile: summary.depotFile,
          type: summary.type,
          allowBinary: false,
          changelistStatus: options.shelved ? "shelved" : changelist.status
        };
        if (options.shelved) {
          if (typeof change !== "number") {
            throw new Error("Shelved diff summaries require a numbered changelist.");
          }
          diffOptions.shelvedChange = change;
        }
        if (summary.localFile) {
          diffOptions.localFile = summary.localFile;
        }
        if (describedFile) {
          diffOptions.action = describedFile.action;
          diffOptions.revision = describedFile.revision;
        }

        const diff = await this.diffFile(diffOptions);

        return {
          ...summary,
          additions: diff.additions,
          deletions: diff.deletions
        };
      }
    );

    return { changelist, files };
  }

  /**
   * Preview reconcile results using `p4 reconcile -n`.
   *
   * This method never performs the reconcile operation itself.
   */
  async previewReconcile(
    options: PreviewReconcileOptions = {}
  ): Promise<P4ReconcilePreviewResult> {
    options.signal?.throwIfAborted();
    const commandArgs = this.getPreviewReconcileCommandArgs(options);
    const rows = await this.runTaggedJson(commandArgs, options);
    return this.toReconcilePreviewResult(rows);
  }

  /**
   * Preview reconcile results while observing best-effort progress events.
   *
   * The final structured preview result remains authoritative; progress lines
   * are emitted as raw, version-dependent hints.
   */
  watchPreviewReconcile(
    options: PreviewReconcileOptions = {}
  ): P4OperationHandle<P4ReconcileProgressEvent, P4ReconcilePreviewResult> {
    const queue = this.createAsyncEventQueue<P4ReconcileProgressEvent>();
    const baseArgs = this.getPreviewReconcileCommandArgs(options);
    const argsWithProgress = ["-I", "-Mj", "-z", "tag", ...baseArgs];
    const scope = createCancellationScope(options.signal);

    queue.push({
      type: "start",
      command: this.executable,
      args: redactCommandArgs(argsWithProgress),
      progressRequested: true
    });

    const result = (async () => {
      let sawProgress = false;

      const executeAttempt = async (args: string[]): Promise<{
        rows: Record<string, unknown>[];
      }> => {
        const rows: Record<string, unknown>[] = [];
        const handle = this.watch(args, { signal: scope.signal, allowNonZeroExit: true });

        for await (const event of handle.events) {
          if (event.type !== "line") {
            continue;
          }

          if (event.source === "stdout") {
            const parsed = this.tryParseJsonLine(event.line);
            if (parsed) {
              rows.push(parsed);
              continue;
            }
          }

          sawProgress = true;
          queue.push({
            type: "progress",
            source: event.source,
            rawLine: event.line,
            snapshot: parseP4ProgressLine(event.line)
          });
        }

        const commandResult = await handle.result;
        if (commandResult.exitCode !== 0) {
          throw new P4CommandError(
            `${this.executable} ${formatCommandArgs(args)} exited with ${commandResult.exitCode}: ${
              commandResult.stderr.trim() || commandResult.stdout.trim() || "Unknown error"
            }`,
            commandResult
          );
        }

        return { rows };
      };

      try {
        const firstAttempt = await executeAttempt(argsWithProgress);
        const preview = this.toReconcilePreviewResult(firstAttempt.rows);

        if (!sawProgress) {
          queue.push({
            type: "progress-unavailable",
            reason: "not-emitted",
            message: "Perforce did not emit progress lines for this reconcile preview."
          });
        }

        queue.push({ type: "complete", result: preview });
        return preview;
      } catch (error) {
        if (!(error instanceof P4CommandError) || !this.isUnsupportedProgressError(error.result)) {
          throw error;
        }

        queue.push({
          type: "progress-unavailable",
          reason: "unsupported",
          message: error.result.stderr.trim() || error.result.stdout.trim() || "Progress output is unsupported."
        });

        const fallbackRows = await executeAttempt(["-Mj", "-z", "tag", ...baseArgs]);
        const preview = this.toReconcilePreviewResult(fallbackRows.rows);
        if (!sawProgress) {
          queue.push({
            type: "progress-unavailable",
            reason: "not-emitted",
            message: "Reconcile preview completed without emitting progress lines."
          });
        }
        queue.push({ type: "complete", result: preview });
        return preview;
      }
    })();

    void result.then(
      () => {
        queue.finish();
      },
      (error) => {
        queue.fail(error);
      }
    );

    return ownOperation({ events: queue.iterable, result }, scope);
  }

  /**
   * Preview sync results using `p4 sync -n`.
   *
   * This method never performs the sync itself. The returned `totalCount`
   * mirrors the number of preview rows emitted by Perforce.
   */
  async previewSync(options: PreviewSyncOptions = {}): Promise<P4SyncPreviewResult> {
    options.signal?.throwIfAborted();
    const rows = await this.runTaggedJson(
      this.getSyncCommandArgs(options, true), options
    );

    return this.toSyncResult(rows);
  }

  /**
   * Perform `p4 sync`.
   *
   * Callers should typically use {@link previewSync} first to inspect pending
   * work, then call this method to apply the same file spec and flags.
   */
  async sync(options: SyncOptions = {}): Promise<P4SyncResult> {
    options.signal?.throwIfAborted();
    const commandArgs = ["-Mj", "-z", "tag", ...this.getSyncCommandArgs(options, false)];
    const result = await this.run(commandArgs, { ...options, allowNonZeroExit: true });
    const rows = parseP4JsonLines(result.stdout);

    if (result.exitCode !== 0 && rows.length === 0) {
      throw this.toCommandError(commandArgs, result);
    }

    return this.toSyncResult(rows);
  }

  /**
   * Perform `p4 sync` while streaming typed progress and per-file error rows.
   */
  watchSync(options: SyncOptions = {}): P4OperationHandle<P4SyncProgressEvent, P4SyncResultWithErrors> {
    const queue = this.createAsyncEventQueue<P4SyncProgressEvent>();
    const args = ["-Mj", "-z", "tag", ...this.getSyncCommandArgs(options, false)];
    const scope = createCancellationScope(options.signal);

    queue.push({
      type: "start",
      command: this.executable,
      args: redactCommandArgs(args)
    });

    const result = (async () => {
      const items: P4SyncItem[] = [];
      const errors: P4SyncErrorItem[] = [];
      const handle = this.watch(args, { signal: scope.signal, allowNonZeroExit: true });

      for await (const event of handle.events) {
        if (event.type !== "line" || event.source !== "stdout") {
          continue;
        }

        const row = this.tryParseJsonLine(event.line);
        if (!row) {
          continue;
        }

        if (this.isSyncErrorRow(row)) {
          const error = this.toSyncErrorItem(row);
          errors.push(error);
          queue.push({ type: "error-row", error });
          continue;
        }

        if (row.action !== undefined || row.depotFile !== undefined) {
          const item = this.toSyncItem(row);
          items.push(item);
          queue.push({
            type: "progress",
            item,
            filesSynced: items.length
          });
        }
      }

      const commandResult = await handle.result;
      if (commandResult.exitCode !== 0 && errors.length === 0) {
        throw this.toCommandError(args, commandResult);
      }

      const syncResult: P4SyncResultWithErrors = {
        items,
        errors,
        totalCount: items.length
      };
      queue.push({ type: "complete", result: syncResult });
      return syncResult;
    })();

    void result.then(
      () => {
        queue.finish();
      },
      (error) => {
        queue.fail(error);
      }
    );

    return ownOperation({ events: queue.iterable, result }, scope);
  }

  private toWorkspaceSummary(
    workspace: P4JsonWorkspace,
    environment: P4EnvironmentSummary
  ): P4WorkspaceSummary {
    const accessedAt = workspace.Access ?? workspace.Update ?? null;

    return {
      client: workspace.client,
      stream: workspace.Stream ?? null,
      root: workspace.Root,
      host: workspace.Host ?? null,
      owner: workspace.Owner,
      accessedAt,
      accessedAtIso: unixSecondsToIsoString(accessedAt),
      isCurrentClient: workspace.client === environment.p4Client
    };
  }

  private toPendingChangelistSummary(change: Record<string, unknown>): P4PendingChangelistSummary {
    const parsed = decodeRow(ChangelistRow, change);
    const normalizedChange = parsed.change;

    const createdAt = normalizeNullableString(parsed.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(parsed.client),
      user: normalizeNullableString(parsed.user),
      status: "pending",
      description: normalizeNullableString(parsed.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt),
      isDefault: normalizedChange === "default"
    };
  }

  private async listNumberedChangelists<TSummary extends { change: number }>(
    status: "submitted" | "shelved",
    options: ListSubmittedChangelistsOptions | ListShelvedChangelistsOptions,
    toSummary: (row: Record<string, unknown>) => TSummary | null
  ): Promise<{
    items: TSummary[];
    hasMore: boolean;
    nextBeforeChange: number | null;
  }> {
    const limit = requirePositiveInteger(options.limit ?? 50, "limit");
    const commandArgs = ["changes", "-s", status, "-l"];
    if (options.user) {
      commandArgs.push("-u", options.user);
    }
    if (options.client) {
      commandArgs.push("-c", options.client);
    }
    commandArgs.push("-m", String(limit + 1));
    this.appendFileSpecs(commandArgs, options.fileSpec);
    if (options.beforeChange !== undefined) {
      commandArgs.push(`@${requireNonNegativeInteger(options.beforeChange, "beforeChange")}`);
    }

    const rows = await this.runTaggedJson(commandArgs, options);
    const summaries = rows
      .map((row) => toSummary(row))
      .filter((summary): summary is TSummary => summary !== null);
    const hasMore = summaries.length > limit;
    const items = hasMore ? summaries.slice(0, limit) : summaries;
    const oldestChange = items.reduce<number | null>(
      (oldest, item) => oldest === null ? item.change : Math.min(oldest, item.change),
      null
    );

    return {
      items,
      hasMore,
      nextBeforeChange: hasMore && oldestChange !== null ? oldestChange - 1 : null
    };
  }

  private toSubmittedChangelistSummary(
    change: Record<string, unknown>
  ): P4SubmittedChangelistSummary | null {
    const parsed = decodeRow(ChangelistRow, change);
    const normalizedChange = parsed.change;
    if (normalizedChange === "default") {
      return null;
    }

    const createdAt = normalizeNullableString(parsed.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(parsed.client),
      user: normalizeNullableString(parsed.user),
      status: "submitted",
      description: normalizeNullableString(parsed.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt)
    };
  }

  private toShelvedChangelistSummary(
    change: Record<string, unknown>
  ): P4ShelvedChangelistSummary | null {
    const parsed = decodeRow(ChangelistRow, change);
    const normalizedChange = parsed.change;
    if (normalizedChange === "default") {
      return null;
    }

    const createdAt = normalizeNullableString(parsed.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(parsed.client),
      user: normalizeNullableString(parsed.user),
      status: "shelved",
      description: normalizeNullableString(parsed.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt)
    };
  }

  private async describeDefaultChangelist(
    options: DescribeChangelistOptions
  ): Promise<P4ChangelistDescription> {
    const openedOptions: GetOpenedFilesOptions = { ...options, change: "default" };
    if (options.client !== undefined) {
      openedOptions.client = options.client;
    }

    const openedFiles = await this.getOpenedFiles(openedOptions);
    const first = openedFiles[0];

    return {
      change: "default",
      user: first?.user ?? null,
      client: options.client ?? first?.client ?? null,
      description: first?.changelistDescription ?? "Default changelist",
      createdAt: null,
      createdAtIso: null,
      status: "pending",
      files: openedFiles.flatMap((file) => file.depotFile === null
        ? []
        : [this.toDescribedFileFromOpened({ ...file, depotFile: file.depotFile })])
    };
  }

  private toChangelistDescription(
    change: number | "default",
    rows: Record<string, unknown>[],
    contentSource?: "opened" | "shelved"
  ): P4ChangelistDescription {
    const metadata = rows.find((row) => row.change !== undefined) ?? rows[0];
    if (!metadata) {
      throw new Error(`Unable to parse changelist description for change ${String(change)}.`);
    }

    const parsed = decodeRow(ChangelistRow, metadata);
    const normalizedChange = parsed.change;
    const createdAt = normalizeNullableString(parsed.time);
    const statusValue = normalizeNullableString(parsed.status)?.toLowerCase();

    const description: P4ChangelistDescription = {
      change: normalizedChange,
      user: normalizeNullableString(parsed.user),
      client: normalizeNullableString(parsed.client),
      description: normalizeNullableString(parsed.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt),
      status: statusValue === "submitted" ? "submitted" : "pending",
      files: this.toDescribedFiles(rows)
    };
    if (contentSource !== undefined) {
      description.contentSource = contentSource;
    }

    return description;
  }

  private toDescribedFiles(rows: Record<string, unknown>[]): P4DescribedFile[] {
    const files: P4DescribedFile[] = [];

    for (const row of rows) {
      if ('depotFile' in row) {
        files.push(this.toDescribedFile(row));
      }

      const indexes = Object.keys(row)
        .map((key) => /^depotFile(\d+)$/.exec(key)?.[1])
        .filter((index): index is string => index !== undefined)
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index))
        .sort((left, right) => left - right);

      for (const index of indexes) {
        files.push(this.toDescribedFile({
          depotFile: row[`depotFile${index}`],
          action: row[`action${index}`],
          type: row[`type${index}`],
          rev: row[`rev${index}`]
        }));
      }
    }

    return files;
  }

  private toDescribedFile(row: Record<string, unknown>): P4DescribedFile {
    const parsed = decodeRow(DescribedFileRow, row);
    return {
      depotFile: parsed.depotFile,
      action: parsed.action,
      type: normalizeNullableString(parsed.type),
      revision: parsed.rev ?? null
    };
  }
  private toDescribedFileFromOpened(
    file: P4OpenedFileSummary & { depotFile: P4DepotPath }
  ): P4DescribedFile {
    return {
      depotFile: file.depotFile,
      action: file.action,
      type: file.type,
      revision: file.revision
    };
  }

  private toChangelistDiffFileSummary(
    file: P4DescribedFile,
    opened: P4OpenedFileSummary | null
  ): P4ChangelistDiffFileSummary {
    const type = file.type ?? opened?.type ?? null;

    return {
      depotFile: file.depotFile,
      localFile: opened?.localFile ?? null,
      action: file.action,
      type,
      isBinary: isBinaryP4Type(type),
      additions: null,
      deletions: null,
      patchLoadState: "deferred"
    };
  }

  private async getOpenedFileLookup(
    change: number | "default",
    options: DescribeChangelistOptions
  ): Promise<Map<string, P4OpenedFileSummary>> {
    const openedOptions: GetOpenedFilesOptions = { ...options, change };
    if (options.client !== undefined) {
      openedOptions.client = options.client;
    }

    const openedFiles = await this.getOpenedFiles(openedOptions);
    const lookup = new Map<string, P4OpenedFileSummary>();

    for (const file of openedFiles) {
      if (file.depotFile) {
        lookup.set(file.depotFile, file);
      }
    }

    return lookup;
  }

  private async mapWithConcurrency<TInput, TOutput>(
    items: TInput[],
    concurrency: number,
    mapper: (item: TInput) => Promise<TOutput>
  ): Promise<TOutput[]> {
    const limit = requirePositiveInteger(concurrency, "concurrency");
    return Effect.runPromise(Effect.forEach(
      items,
      (item) => Effect.tryPromise({
        try: () => mapper(item),
        catch: (error) => new P4ClientOperationError('Concurrent operation failed.', error)
      }).pipe(Effect.uninterruptible),
      // The operation signal cancels active commands. Join their Promise adapters
      // before rejecting, while preventing queued work from starting on failure.
      { concurrency: limit }
    )).catch((error: unknown) => {
      throw error instanceof P4ClientOperationError ? error.cause : error;
    });
  }

  private toOpenedFileSummary(file: Record<string, unknown>): P4OpenedFileSummary {
    const parsed = decodeRow(OpenedRow, file);
    const changelist = parsed.change ?? 'default';
    const action = parsed.action;

    return {
      depotFile: parsed.depotFile ?? null,
      clientFile: this.toClientFile(parsed.clientFile),
      localFile: this.toLocalFile(parsed.path) ?? this.toLocalFile(parsed.clientFile),
      action,
      type: normalizeNullableString(parsed.type),
      changelist,
      changelistDescription: normalizeNullableString(parsed.desc),
      user: normalizeNullableString(parsed.user),
      client: normalizeNullableString(parsed.client),
      revision: parsed.rev ?? null,
      isDefaultChangelist: changelist === "default"
    };
  }

  private toDepotFileRevision(row: Record<string, unknown>): P4DepotFileRevision {
    const parsed = decodeRow(FileRevisionRow, row);
    return {
      depotFile: parsed.depotFile,
      revision: parsed.rev,
      changelist: parsed.change,
      action: parsed.action,
      type: parsed.type
    };
  }
  /**
   * Run a read-only browse command that tolerates benign "no such file(s)"
   * warnings by returning them as empty listings.
   */
  private async runBrowse(args: string[], signal?: AbortSignal): Promise<P4CommandResult> {
    const options: P4CommandOptions = { allowNonZeroExit: true };
    if (signal !== undefined) {
      options.signal = signal;
    }
    return this.run(args, options);
  }

  /**
   * Split tagged JSON rows into data rows versus Perforce message rows.
   *
   * Warning-level messages (such as "no such file(s)" for an empty directory)
   * are treated as an empty result. Error-level messages, or a non-zero exit
   * with no parseable output at all, raise a {@link P4CommandError}.
   */
  private selectDataRows(
    args: string[],
    result: P4CommandResult,
    hasData: (row: Record<string, unknown>) => boolean
  ): Record<string, unknown>[] {
    const rows = parseP4JsonLines(result.stdout);
    const data: Record<string, unknown>[] = [];
    let hasFatal = false;

    for (const row of rows) {
      const severity = normalizeNullableNumber(row.severity);
      if (severity !== null && severity >= 3) {
        hasFatal = true;
        continue;
      }
      if (hasData(row)) {
        data.push(row);
        continue;
      }

      decodeRow(MessageRow, row);
    }

    if (hasFatal) {
      throw this.toCommandError(args, result);
    }

    if (rows.length === 0 && result.exitCode !== 0) {
      throw this.toCommandError(args, result);
    }

    return data;
  }

  /**
   * Validate and normalize a directory depot path for single-level browsing.
   */
  private normalizeBrowseDir(depotPath: string): string {
    if (!depotPath.startsWith("//") || /[#@*]/.test(depotPath) || depotPath.includes("...")) {
      throw new Error("depotPath must be a depot directory without a wildcard or revision specifier.");
    }

    return depotPath.replace(/\/+$/, "");
  }

  private appendAtChange(spec: string, atChange: number | undefined): string {
    if (atChange === undefined) {
      return spec;
    }

    return `${spec}@${requirePositiveInteger(atChange, "atChange")}`;
  }

  private depotBaseName(depotPath: string): string {
    const trimmed = depotPath.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    return index >= 0 ? trimmed.slice(index + 1) : trimmed;
  }

  private toDepot(row: Record<string, unknown>): P4Depot {
    const parsed = decodeRow(DepotRow, row);
    const name = parsed.name;
    return {
      name,
      depotPath: decodeRow(P4DepotPathSchema, `//${name}`),
      type: normalizeNullableString(parsed.type),
      map: normalizeNullableString(parsed.map),
      description: normalizeNullableString(parsed.desc)
    };
  }

  private toDepotDir(row: Record<string, unknown>): P4DepotDir {
    const parsed = decodeRow(DirRow, row);
    const depotDir = parsed.dir;
    return {
      depotDir,
      name: this.depotBaseName(depotDir)
    };
  }

  private toDepotFileListing(row: Record<string, unknown>): P4DepotFileListing {
    const parsed = decodeRow(FileRow, row);
    const depotFile = parsed.depotFile;
    const action = parsed.action ?? null;
    const type = normalizeNullableString(parsed.type);

    return {
      depotFile,
      name: this.depotBaseName(depotFile),
      revision: parsed.rev ?? null,
      action,
      type,
      changelist: parsed.change ?? null,
      isDeletedAtHead: this.isDeleteAction(action),
      isBinary: isBinaryP4Type(type)
    };
  }

  private toFileStat(row: Record<string, unknown>): P4FileStat {
    const parsed = decodeRow(StatRow, row);
    const depotFile = parsed.depotFile;
    const headAction = parsed.headAction ?? null;
    const headType = normalizeNullableString(parsed.headType);
    const headRevision = parsed.headRev ?? null;
    const haveRevision = parsed.haveRev ?? null;
    const headTime = normalizeNullableString(parsed.headTime);
    const isDeletedAtHead = this.isDeleteAction(headAction);

    const isOutOfDate = haveRevision !== null
      && (isDeletedAtHead || (headRevision !== null && haveRevision < headRevision));

    const otherOpen: string[] = [];
    for (const key of Object.keys(row)) {
      if (/^otherOpen\d+$/.test(key)) {
        const value = normalizeNullableString(row[key]);
        if (value !== null) {
          otherOpen.push(value);
        }
      }
    }

    const otherLocked = Object.keys(row).some((key) => /^otherLock\d*$/.test(key));

    return {
      depotFile,
      localFile: this.toLocalPath(parsed.clientFile),
      isMapped: row.isMapped !== undefined,
      headAction,
      headType,
      headRevision,
      headChange: parsed.headChange ?? null,
      headTime,
      headTimeIso: unixSecondsToIsoString(headTime),
      haveRevision,
      fileSize: parsed.fileSize ?? null,
      digest: normalizeNullableString(parsed.digest),
      isDeletedAtHead,
      isOutOfDate,
      isBinary: isBinaryP4Type(headType),
      openAction: parsed.action ?? null,
      openChangelist: parsed.action !== undefined ? parsed.change ?? null : null,
      otherOpen,
      otherLocked
    };
  }

  private isDeleteAction(action: P4FileAction | null): boolean {
    if (!action) return false;
    const normalized = action.toLowerCase();
    return normalized === "delete"
      || normalized === "move/delete"
      || normalized === "archive"
      || normalized === "purge";
  }

  private toWhereMapping(row: Record<string, unknown>): P4WhereMapping {
    const parsed = decodeRow(WhereRow, row);
    const stripExclusion = (value: string | null): string | null =>
      value === null ? null : value.replace(/^-/, "");

    const rawDepot = normalizeNullableString(parsed.depotFile);
    const isExcluded = row.unmap !== undefined || (rawDepot?.startsWith("-") ?? false);

    return {
      depotFile: decodeRow(P4DepotPathSchema, parsed.depotFile.replace(/^-/, ''), row),
      clientFile: this.toClientPath(stripExclusion(normalizeNullableString(parsed.clientFile))),
      localFile: this.toLocalPath(stripExclusion(normalizeNullableString(parsed.path))),
      isExcluded
    };
  }

  /**
   * Flatten every `p4 filelog` row into one newest-first revision list.
   *
   * Revision numbers restart at 1 on each path, so the merged list is ordered
   * by changelist descending (falling back to submit time when both sides lack
   * a changelist) rather than by revision number, which would interleave
   * unrelated paths. Equal or incomparable keys keep input order, which is row
   * order and newest-first within a row.
   */
  private mergeFileRevisions(rows: Record<string, unknown>[]): P4FileRevision[] {
    const merged: P4FileRevision[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const depotFile = this.toDepotPath(row.depotFile);
      if (depotFile === null) {
        continue;
      }

      for (const revision of this.toFileRevisions(row, depotFile)) {
        // A wide integration graph can surface the same path in several rows.
        const key = `${depotFile}#${revision.revision}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push(revision);
      }
    }

    return merged.sort(compareFileRevisionsNewestFirst);
  }

  private toFileRevisions(row: Record<string, unknown>, depotFile: P4DepotPath): P4FileRevision[] {
    const indexes = Object.keys(row)
      .map((key) => /^rev(\d+)$/.exec(key)?.[1])
      .filter((index): index is string => index !== undefined)
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index))
      .sort((left, right) => left - right);

    const revisions: P4FileRevision[] = [];
    for (const index of indexes) {
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(HistoryRevisionRow.fields)) {
        if (`${key}${index}` in row) fields[key] = row[`${key}${index}`];
      }
      const parsed = decodeRow(HistoryRevisionRow, fields, row);
      const time = normalizeNullableString(parsed.time);
      revisions.push({
        depotFile,
        revision: parsed.rev,
        change: parsed.change ?? null,
        action: parsed.action ?? null,
        type: normalizeNullableString(parsed.type),
        time,
        timeIso: unixSecondsToIsoString(time),
        user: normalizeNullableString(parsed.user),
        client: normalizeNullableString(parsed.client),
        description: normalizeNullableString(parsed.desc),
        digest: normalizeNullableString(parsed.digest),
        fileSize: parsed.fileSize ?? null
      });
    }

    return revisions;
  }

  private toUser(row: Record<string, unknown>): P4User {
    const parsed = decodeRow(UserRow, row);
    const accessedAt = normalizeNullableString(parsed.Access);
    return {
      user: parsed.User,
      email: normalizeNullableString(parsed.Email),
      fullName: normalizeNullableString(parsed.FullName),
      type: normalizeNullableString(parsed.Type),
      accessedAt,
      accessedAtIso: unixSecondsToIsoString(accessedAt)
    };
  }

  private toStream(row: Record<string, unknown>): P4Stream {
    const parsed = decodeRow(StreamRow, row);
    const stream = parsed.Stream;
    const parent = normalizeNullableString(parsed.Parent);

    return {
      stream,
      name: normalizeNullableString(parsed.Name) ?? this.depotBaseName(stream),
      owner: normalizeNullableString(parsed.Owner),
      parent: parent !== null && parent !== "none" ? this.toDepotPath(parent) : null,
      type: normalizeNullableString(parsed.Type),
      description: normalizeNullableString(parsed.desc)
    };
  }

  private appendRevision(depotFile: string, revision: string | number | undefined): string {
    if (revision === undefined) {
      return depotFile;
    }

    const text = String(revision);
    if (text.startsWith("#") || text.startsWith("@")) {
      return `${depotFile}${text}`;
    }

    return `${depotFile}#${text}`;
  }

  private stripTrailingNewline(value: string): string {
    return value.replace(/\r?\n$/, "");
  }

  private getMaterializedFilePath(directory: string, depotFile: P4DepotPath): string {
    if (!depotFile.startsWith("//")) {
      throw new P4MaterializationError(
        `Invalid depot path: ${depotFile}`,
        "invalid_depot_path"
      );
    }

    const segments = depotFile.slice(2).split("/");
    if (
      segments.length < 2
      || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new P4MaterializationError(
        `Invalid depot path: ${depotFile}`,
        "invalid_depot_path"
      );
    }

    const outputPath = resolve(directory, ...segments);
    const relativePath = relative(directory, outputPath);
    if (
      relativePath.length === 0
      || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || relativePath === ".."
      || isAbsolute(relativePath)
    ) {
      throw new P4MaterializationError(
        `Depot path escapes the materialization directory: ${depotFile}`,
        "invalid_depot_path"
      );
    }

    return outputPath;
  }

  private toReconcileCandidate(row: Record<string, unknown>): P4ReconcileCandidate {
    const parsed = decodeRow(OpenedRow, row);
    const action = normalizeNullableString(parsed.action);
    if (action !== "add" && action !== "edit" && action !== "delete") {
      throw new P4ParseError(
        `Unsupported reconcile action "${String(parsed.action)}".`, JSON.stringify(row), null
      );
    }

    return {
      depotFile: parsed.depotFile ?? null,
      clientFile: this.toClientFile(parsed.clientFile),
      localFile: this.toLocalFile(parsed.path) ?? this.toLocalFile(parsed.clientFile),
      action,
      type: normalizeNullableString(parsed.type),
      changelist: parsed.change ?? null
    };
  }

  private toReconcilePreviewResult(rows: Record<string, unknown>[]): P4ReconcilePreviewResult {
    const result: P4ReconcilePreviewResult = {
      added: [],
      edited: [],
      deleted: []
    };

    for (const row of rows) {
      if (this.isReconcileMessageRow(row)) {
        continue;
      }
      const candidate = this.toReconcileCandidate(row);
      if (candidate.action === "add") result.added.push(candidate);
      else if (candidate.action === "edit") result.edited.push(candidate);
      else result.deleted.push(candidate);
    }

    return result;
  }

  private isReconcileMessageRow(row: Record<string, unknown>): boolean {
    const severity = normalizeNullableNumber(row.severity);
    return normalizeNullableString(row.action) === null
      && severity !== null
      && severity < 3
      && normalizeNullableString(row.data) !== null;
  }

  private getSyncCommandArgs(
    options: Pick<PreviewSyncOptions, "fileSpec" | "force" | "keepWorkspaceFiles">,
    preview: boolean
  ): string[] {
    const commandArgs = ["sync"];
    if (preview) {
      commandArgs.push("-n");
    }
    if (options.force) {
      commandArgs.push("-f");
    }
    if (options.keepWorkspaceFiles) {
      commandArgs.push("-k");
    }
    this.appendFileSpecs(commandArgs, options.fileSpec);
    return commandArgs;
  }

  private toSyncResult(rows: Record<string, unknown>[]): P4SyncResult {
    const items: P4SyncItem[] = [];
    const errors: P4SyncErrorItem[] = [];

    for (const row of rows) {
      if (this.isP4MessageRow(row)) {
        continue;
      }
      if (this.isSyncErrorRow(row)) {
        errors.push(this.toSyncErrorItem(row));
        continue;
      }

      items.push(this.toSyncItem(row));
    }

    const result: P4SyncResult = {
      items,
      totalCount: items.length
    };
    if (errors.length > 0) {
      result.errors = errors;
    }

    return result;
  }

  private toSyncItem(row: Record<string, unknown>): P4SyncItem {
    const parsed = decodeRow(SyncRow, row);
    return {
      depotFile: this.toDepotPath(parsed.depotFile),
      clientFile: this.toClientFile(parsed.clientFile),
      localFile: this.toLocalFile(parsed.path) ?? this.toLocalFile(parsed.clientFile),
      revision: parsed.rev ?? null,
      action: parsed.action ?? null,
      fileSize: parsed.fileSize ?? null
    };
  }

  private isSyncErrorRow(row: Record<string, unknown>): boolean {
    const severity = normalizeNullableNumber(row.severity);
    return severity !== null && severity >= 3;
  }

  private isP4MessageRow(row: Record<string, unknown>): boolean {
    const hasFileField = [row.depotFile, row.clientFile, row.path].some(
      (value) => normalizeNullableString(value) !== null
    );
    const severity = normalizeNullableNumber(row.severity);
    return !hasFileField
      && severity !== null
      && severity < 3
      && normalizeNullableString(row.data) !== null;
  }

  private toSyncErrorItem(row: Record<string, unknown>): P4SyncErrorItem {
    const data = normalizeNullableString(row.data);
    const clientFile = this.toClientFile(row.clientFile)
      ?? this.toLocalPath(row.path)
      ?? (data ? this.toLocalPath(this.extractFilePathFromSyncErrorData(data)) : null);

    return {
      clientFile,
      depotFile: this.toDepotPath(row.depotFile),
      message: data ?? normalizeNullableString(row.generic) ?? "Perforce sync failed."
    };
  }

  private toDepotPath(value: unknown): P4DepotPath | null {
    if (value === null || value === undefined || value === '') return null;
    const normalized = typeof value === 'string' ? value.trim() : value;
    return decodeRow(P4DepotPathSchema, normalized);
  }
  private toClientFile(value: unknown): P4ClientPath | P4LocalPath | null {
    if (typeof value === 'string' && !value.startsWith('//')) {
      return this.toLocalPath(value);
    }
    return this.toClientPath(value);
  }

  private toClientPath(value: unknown): P4ClientPath | null {
    if (value === null || value === undefined || value === '') return null;
    const normalized = typeof value === 'string' ? value.trim() : value;
    return decodeRow(P4ClientPathSchema, normalized);
  }
  private toLocalPath(value: unknown): P4LocalPath | null {
    if (value === null || value === undefined || value === '') return null;
    const normalized = typeof value === 'string' ? value.trim() : value;
    return decodeRow(P4LocalPathSchema, normalized);
  }
  private toLocalFile(value: unknown): P4LocalPath | null {
    const normalized = normalizeNullableString(value);
    if (normalized === null) {
      return null;
    }
    if (isAbsolute(normalized) || !normalized.startsWith("//")) {
      return decodeRow(P4LocalPathSchema, normalized);
    }

    const clientRelativePath = /^\/\/[^/]+\/(.+)$/.exec(normalized)?.[1];
    if (clientRelativePath === undefined || this.cwd === undefined) {
      return null;
    }
    return decodeRow(P4LocalPathSchema, resolve(this.cwd, ...clientRelativePath.split("/")));
  }

  private extractFilePathFromSyncErrorData(message: string): string | null {
    const clobberMatch = /Can't clobber writable file\s+(.+)$/i.exec(message);
    if (clobberMatch?.[1]) {
      return clobberMatch[1].trim();
    }

    const overwriteMatch = /^(.+?)\s+-\s+can't overwrite existing file/i.exec(message);
    if (overwriteMatch?.[1]) {
      return overwriteMatch[1].trim();
    }

    return null;
  }

  private appendFileSpecs(commandArgs: string[], fileSpec: string | string[] | undefined) {
    if (fileSpec === undefined) return;

    if (Array.isArray(fileSpec)) {
      commandArgs.push(...fileSpec);
      return;
    }

    commandArgs.push(fileSpec);
  }

  private getPreviewReconcileCommandArgs(options: PreviewReconcileOptions): string[] {
    const commandArgs = ["reconcile", "-n"];
    if (options.changelist !== undefined) {
      commandArgs.push("-c", String(options.changelist));
    }
    if (options.useModTime) {
      commandArgs.push("-m");
    }
    if (options.includeWritable) {
      commandArgs.push("-w");
    }
    const fileSpec = options.fileSpec ?? (
      options.workspace ? workspaceRootFileSpec(options.workspace) : undefined
    );
    this.appendFileSpecs(commandArgs, fileSpec);
    return commandArgs;
  }

  private buildCommandOptions(options: P4CommandOptions): P4CommandOptions {
    const commandOptions: P4CommandOptions = {
      env: this.getMergedEnv(options.env)
    };

    const cwd = options.cwd ?? this.cwd;
    if (cwd !== undefined) {
      commandOptions.cwd = cwd;
    }

    if (options.input !== undefined) {
      commandOptions.input = options.input;
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (timeoutMs !== undefined) {
      commandOptions.timeoutMs = requirePositiveTimeoutMs(timeoutMs);
    }

    if (options.signal !== undefined) {
      commandOptions.signal = options.signal;
    }

    if (options.allowNonZeroExit !== undefined) {
      commandOptions.allowNonZeroExit = options.allowNonZeroExit;
    }

    return commandOptions;
  }

  private getMergedEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.env,
      ...overrides
    };

    if (this.activeClient !== null && overrides?.P4CLIENT === undefined) {
      env.P4CLIENT = this.activeClient;
    }

    return env;
  }

  private async getLocalEnvironment(options: GetEnvironmentOptions): Promise<P4EnvironmentSummary> {
    options.signal?.throwIfAborted();
    const cacheKey = this.getSettingsCacheKey(options.settingsSources);
    if (!options.refresh && this.cachedLocalEnvironment?.cacheKey === cacheKey) {
      return { ...this.cachedLocalEnvironment.environment };
    }

    const epoch = this.cacheEpoch;
    const resolved = await this.resolveLocalSettings(options);
    const environment: P4EnvironmentSummary = {
      hostName: this.configuredHostName ?? getHostName(),
      p4Port: resolved.settings.P4PORT ?? null,
      p4User: resolved.settings.P4USER ?? null,
      p4Client: resolved.settings.P4CLIENT ?? null
    };

    options.signal?.throwIfAborted();
    if (epoch === this.cacheEpoch) {
      this.cachedLocalEnvironment = { cacheKey, environment };
    }
    return { ...environment };
  }

  private async resolveLocalSettings(
    options: Pick<GetEnvironmentOptions, "refresh" | "settingsSources" | "signal">
  ): Promise<P4ResolvedSettings> {
    options.signal?.throwIfAborted();
    const cacheKey = this.getSettingsCacheKey(options.settingsSources);
    if (!options.refresh && this.cachedResolvedSettings?.cacheKey === cacheKey) {
      return {
        settings: { ...this.cachedResolvedSettings.resolved.settings },
        contributions: this.cachedResolvedSettings.resolved.contributions.map((entry) => ({
          ...entry,
          keys: [...entry.keys]
        }))
      };
    }

    const epoch = this.cacheEpoch;
    const cliSettings = await this.readCliSettings(options.settingsSources, options);
    const resolveOptions = options.settingsSources !== undefined
      ? { ...options, sources: options.settingsSources }
      : options;
    const resolved = await resolveP4SettingsWithDetails(cliSettings, resolveOptions);
    options.signal?.throwIfAborted();

    if (epoch === this.cacheEpoch) {
      this.cachedResolvedSettings = { cacheKey, resolved };
    }
    return {
      settings: { ...resolved.settings },
      contributions: resolved.contributions.map((entry) => ({
        ...entry,
        keys: [...entry.keys]
      }))
    };
  }

  private async readCliSettings(sources?: P4SettingsSource[], options: P4OperationOptions = {}): Promise<P4CliSettings> {
    options.signal?.throwIfAborted();
    if (sources && !sources.includes("cli")) {
      return {};
    }

    const effectiveEnvSettings = this.getEffectiveCliSettings();

    try {
      const result = await this.run(["set", "-q"], { ...options, allowNonZeroExit: true });
      const cliSettings = result.exitCode === 0 ? parseP4SetOutput(result.stdout) : {};
      return mergeIncompleteSettings(effectiveEnvSettings, cliSettings);
    } catch {
      options.signal?.throwIfAborted();
      return effectiveEnvSettings;
    }
  }

  private getEffectiveCliSettings(): P4CliSettings {
    const effectiveEnv = this.getMergedEnv();
    const settings: P4CliSettings = {};

    if (effectiveEnv.P4PORT) {
      settings.P4PORT = effectiveEnv.P4PORT;
    }
    if (effectiveEnv.P4USER) {
      settings.P4USER = effectiveEnv.P4USER;
    }
    if (effectiveEnv.P4CLIENT) {
      settings.P4CLIENT = effectiveEnv.P4CLIENT;
    }

    return settings;
  }

  private getSettingsCacheKey(sources?: P4SettingsSource[]): string {
    return sources?.join("|") ?? "__default__";
  }

  private clearCaches(): void {
    this.cacheEpoch += 1;
    this.cachedEnvironment = null;
    this.cachedWorkspaces = null;
    this.cachedLocalEnvironment = null;
    this.cachedResolvedSettings = null;
  }

  private toCommandError(args: string[], result: P4CommandResult): P4CommandError {
    const details = result.stderr.trim() || result.stdout.trim() || "Unknown error";
    return new P4CommandError(
      `${this.executable} ${formatCommandArgs(args)} exited with ${result.exitCode}: ${details}`,
      result
    );
  }

  private tryParseJsonLine(line: string): Record<string, unknown> | null {
    return parseTaggedJsonLine(line);
  }

  private isUnsupportedProgressError(result: P4CommandResult): boolean {
    const text = [result.stderr, result.stdout].filter(Boolean).join("\n");
    const patterns = [
      /unknown option.*-I/i,
      /invalid option.*-I/i,
      /don't know about.*-I/i,
      /progress indicators?.*not available/i,
      /not compatible with.*-I/i,
      /usage:.*\bp4\b/i
    ];

    return patterns.some((pattern) => pattern.test(text));
  }

  private createAsyncEventQueue<T>(): {
    iterable: AsyncIterable<T>;
    push: (event: T) => void;
    fail: (error: unknown) => void;
    finish: () => void;
  } {
    return createAsyncEventQueue<T>();
  }
}

/**
 * Order merged `p4 filelog` revisions newest first.
 *
 * Changelists are compared when both sides report one, submit time otherwise.
 * Returning `0` for incomparable pairs leaves them in input order, since
 * `Array.prototype.sort` is stable.
 */
function compareFileRevisionsNewestFirst(left: P4FileRevision, right: P4FileRevision): number {
  if (left.change !== null && right.change !== null) {
    return right.change - left.change;
  }

  const leftTime = left.time === null ? null : Number(left.time);
  const rightTime = right.time === null ? null : Number(right.time);
  if (
    leftTime !== null &&
    rightTime !== null &&
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime)
  ) {
    return rightTime - leftTime;
  }

  return 0;
}
