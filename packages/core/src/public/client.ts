import { hostname as getHostName } from "node:os";
import { runCommand, watchCommand } from "../internal/command.js";
import { P4CommandError } from "./errors.js";
import {
  isBinaryP4Type,
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeP4Change,
  parseP4PrintHeader,
  parseP4ProgressLine,
  parseP4JsonLines,
  parseP4KeyValueOutput,
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
  P4PrintResult,
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
    const commandOptions = this.buildCommandOptions(options);
    const result = await this.executor(this.executable, args, commandOptions);

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
    const handle = this.streamExecutor(this.executable, args, commandOptions);

    return {
      events: handle.events,
      result: handle.result.then((result) => {
        if (result.exitCode !== 0 && !commandOptions.allowNonZeroExit) {
          throw this.toCommandError(args, result);
        }

        return result;
      })
    };
  }

  /**
   * Run a command and parse newline-delimited tagged JSON output.
   *
   * By default this method prefixes `-Mj -z tag` to the provided arguments.
   * Set `prefixTaggedJsonFlags` to `false` to pass fully-expanded arguments
   * yourself.
   */
  async runTaggedJson<T = Record<string, unknown>>(
    args: string[],
    options: RunTaggedJsonOptions = {}
  ): Promise<T[]> {
    const commandArgs = options.prefixTaggedJsonFlags === false
      ? args
      : ["-Mj", "-z", "tag", ...args];
    const result = await this.run(commandArgs, options);
    return parseP4JsonLines<T>(result.stdout);
  }

  /**
   * Resolve common environment values from `p4 info` plus process environment
   * fallbacks.
   *
   * Results are cached per client instance unless `refresh` is requested.
   */
  async getEnvironment(options: GetEnvironmentOptions = {}): Promise<P4EnvironmentSummary> {
    if (options.mode === "local") {
      return this.getLocalEnvironment(options);
    }

    const shouldResolveSettings = options.resolveSettings === true || options.settingsSources !== undefined;
    if (!options.refresh && !shouldResolveSettings && this.cachedEnvironment) {
      return this.cachedEnvironment;
    }

    const resolvedSettings = shouldResolveSettings
      ? await this.resolveLocalSettings(options)
      : null;
    const result = await this.run(["info"]);
    const info = parseP4KeyValueOutput(result.stdout);

    // Effective env mirrors the same merge order used by run() so that what
    // getEnvironment() reports matches what commands actually use.
    const effectiveEnv = { ...process.env, ...this.env };

    const environment: P4EnvironmentSummary = {
      hostName: info["Client host"] ?? this.configuredHostName ?? getHostName(),
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

    if (!shouldResolveSettings) {
      this.cachedEnvironment = environment;
    }

    return environment;
  }

  /**
   * List Perforce workspaces for a user.
   *
   * By default only workspaces that appear local to the current machine are
   * returned. Locality is determined from the workspace host or by checking
   * whether the workspace root exists on disk.
   *
   * Results are cached when the default local-workspace query is used.
   *
   * @throws {Error} When no user can be resolved from the options or current
   * environment.
   */
  async listWorkspaces(options: ListWorkspacesOptions = {}): Promise<P4WorkspaceSummary[]> {
    if (!options.refresh && !options.user && !options.hostName && !options.includeNonLocal && this.cachedWorkspaces) {
      return this.cachedWorkspaces;
    }

    const environment = options.refresh === undefined
      ? await this.getEnvironment()
      : await this.getEnvironment({ refresh: options.refresh });
    const user = options.user ?? environment.p4User;
    if (!user) {
      throw new Error("P4USER is not configured.");
    }

    const hostName = options.hostName ?? environment.hostName;
    const allWorkspaces = await this.runTaggedJson<P4JsonWorkspace>(["clients", "-u", user]);

    const workspaces = allWorkspaces
      .filter((workspace) => {
        if (options.includeNonLocal) return true;
        return isLocalWorkspace(
          { host: workspace.Host ?? null },
          hostName
        );
      })
      .map((workspace) => this.toWorkspaceSummary(workspace, environment))
      .sort((left, right) => {
        const rootCompare = left.root.localeCompare(right.root);
        if (rootCompare !== 0) return rootCompare;
        return left.client.localeCompare(right.client);
      });

    if (!options.user && !options.hostName && !options.includeNonLocal) {
      this.cachedWorkspaces = workspaces;
    }

    return workspaces;
  }

  /**
   * Set the active Perforce client and clear cached client-derived state.
   */
  async setClient(options: SetClientOptions): Promise<SetClientResult> {
    const environment = await this.getEnvironment();
    await this.run(["set", `P4CLIENT=${options.client}`]);

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
  async switchWorkspace(client: string): Promise<SetClientResult> {
    return this.setClient({ client });
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
    const commandArgs = ["changes", "-s", options.status ?? "pending"];
    if (options.user) {
      commandArgs.push("-u", options.user);
    }
    if (options.client) {
      commandArgs.push("-c", options.client);
    }
    this.appendFileSpecs(commandArgs, options.fileSpec);

    const changes = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
    const summaries = changes.map((change) => this.toPendingChangelistSummary(change));
    const includeDefault = options.includeDefault ?? true;

    if (!includeDefault || summaries.some((summary) => summary.isDefault)) {
      return summaries;
    }

    const defaultOpenedOptions: GetOpenedFilesOptions = { change: "default" };
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
    if (options.status === "submitted") {
      return this.listSubmittedChangelists(options);
    }
    if (options.status === "shelved") {
      return this.listShelvedChangelists(options);
    }

    const pendingOptions: ListPendingChangelistsOptions = {
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

    const files = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
    return files.map((file) => this.toOpenedFileSummary(file));
  }

  /**
   * List files opened in a specific changelist.
   */
  async getChangelistFiles(
    change: number | "default",
    options: Omit<GetOpenedFilesOptions, "change"> = {}
  ): Promise<P4OpenedFileSummary[]> {
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
    if (change === "default") {
      if (options.shelved) {
        throw new Error("Shelved changelist descriptions require a numbered changelist.");
      }
      return this.describeDefaultChangelist(options);
    }

    const commandArgs = options.shelved
      ? ["describe", "-S", "-s", String(change)]
      : ["describe", "-s", String(change)];
    const rows = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
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
        depotFile: this.toDepotPath(options.depotFile)!,
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
      allowNonZeroExit: true
    });

    if (result.exitCode > 1) {
      throw this.toCommandError([plan.command, ...plan.args], result);
    }

    const unifiedDiff = result.stdout;
    const { additions, deletions } = summarizeUnifiedDiff(unifiedDiff);

    return {
      depotFile: this.toDepotPath(options.depotFile)!,
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
   * Binary files return `isBinary: true` with empty `content`. Text files
   * return UTF-8 string content with the `p4 print` header stripped.
   */
  async printFile(depotFile: string, options: PrintFileOptions = {}): Promise<P4PrintResult> {
    const revision = options.revision ?? "have";
    const filespec = `${depotFile}#${revision}`;
    const result = await this.run(["print", "-q", filespec]);

    return this.toPrintResult(depotFile, result.stdout);
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
    const changelist = await this.describeChangelist(change, options);
    const openedLookup = options.shelved
      ? new Map<string, P4OpenedFileSummary>()
      : await this.getOpenedFileLookup(change, options);
    const includeLineCounts = options.includeLineCounts ?? false;
    const concurrency = options.concurrency ?? 3;

    const baseSummaries = changelist.files.map((file) =>
      this.toChangelistDiffFileSummary(file, openedLookup.get(file.depotFile) ?? null)
    );

    if (!includeLineCounts) {
      return { changelist, files: baseSummaries };
    }

    const files = await this.mapWithConcurrency(
      baseSummaries,
      concurrency,
      async (summary) => {
        if (summary.isBinary) {
          return summary;
        }

        const describedFile = changelist.files.find((file) => file.depotFile === summary.depotFile);
        const diffOptions: DiffFileOptions = {
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
    const commandArgs = this.getPreviewReconcileCommandArgs(options);
    const rows = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
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

    queue.push({
      type: "start",
      command: this.executable,
      args: argsWithProgress,
      progressRequested: true
    });

    const result = (async () => {
      let sawProgress = false;

      const executeAttempt = async (args: string[]): Promise<{
        rows: Record<string, unknown>[];
      }> => {
        const rows: Record<string, unknown>[] = [];
        const handle = this.watch(args, { allowNonZeroExit: true });

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
            `${this.executable} ${args.join(" ")} exited with ${commandResult.exitCode}: ${
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

    return {
      events: queue.iterable,
      result
    };
  }

  /**
   * Preview sync results using `p4 sync -n`.
   *
   * This method never performs the sync itself. The returned `totalCount`
   * mirrors the number of preview rows emitted by Perforce.
   */
  async previewSync(options: PreviewSyncOptions = {}): Promise<P4SyncPreviewResult> {
    const rows = await this.runTaggedJson<Record<string, unknown>>(
      this.getSyncCommandArgs(options, true)
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
    const commandArgs = ["-Mj", "-z", "tag", ...this.getSyncCommandArgs(options, false)];
    const result = await this.run(commandArgs, { allowNonZeroExit: true });
    const rows = parseP4JsonLines<Record<string, unknown>>(result.stdout);

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

    queue.push({
      type: "start",
      command: this.executable,
      args
    });

    const result = (async () => {
      const items: P4SyncItem[] = [];
      const errors: P4SyncErrorItem[] = [];
      const handle = this.watch(args, { allowNonZeroExit: true });

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

    return {
      events: queue.iterable,
      result
    };
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
    const normalizedChange = normalizeP4Change(change.change);
    if (normalizedChange === null) {
      throw new Error(`Unable to parse pending changelist from row: ${JSON.stringify(change)}`);
    }

    const createdAt = normalizeNullableString(change.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(change.client),
      user: normalizeNullableString(change.user),
      status: "pending",
      description: normalizeNullableString(change.desc),
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
    const limit = options.limit ?? 50;
    const commandArgs = ["changes", "-s", status, "-l"];
    if (options.user) {
      commandArgs.push("-u", options.user);
    }
    if (options.client) {
      commandArgs.push("-c", options.client);
    }
    commandArgs.push("-m", String(limit));
    this.appendFileSpecs(commandArgs, options.fileSpec);
    if (options.beforeChange !== undefined) {
      commandArgs.push(`@${options.beforeChange}`);
    }

    const rows = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
    const items = rows
      .map((row) => toSummary(row))
      .filter((summary): summary is TSummary => summary !== null);
    const oldestChange = items.reduce<number | null>(
      (oldest, item) => oldest === null ? item.change : Math.min(oldest, item.change),
      null
    );
    const hasMore = oldestChange !== null && items.length >= limit && oldestChange > 1;

    return {
      items,
      hasMore,
      nextBeforeChange: hasMore ? oldestChange - 1 : null
    };
  }

  private toSubmittedChangelistSummary(
    change: Record<string, unknown>
  ): P4SubmittedChangelistSummary | null {
    const normalizedChange = normalizeP4Change(change.change);
    if (normalizedChange === null || normalizedChange === "default") {
      return null;
    }

    const createdAt = normalizeNullableString(change.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(change.client),
      user: normalizeNullableString(change.user),
      status: "submitted",
      description: normalizeNullableString(change.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt)
    };
  }

  private toShelvedChangelistSummary(
    change: Record<string, unknown>
  ): P4ShelvedChangelistSummary | null {
    const normalizedChange = normalizeP4Change(change.change);
    if (normalizedChange === null || normalizedChange === "default") {
      return null;
    }

    const createdAt = normalizeNullableString(change.time);

    return {
      change: normalizedChange,
      client: normalizeNullableString(change.client),
      user: normalizeNullableString(change.user),
      status: "shelved",
      description: normalizeNullableString(change.desc),
      createdAt,
      createdAtIso: unixSecondsToIsoString(createdAt)
    };
  }

  private async describeDefaultChangelist(
    options: DescribeChangelistOptions
  ): Promise<P4ChangelistDescription> {
    const openedOptions: GetOpenedFilesOptions = { change: "default" };
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
      files: openedFiles
        .filter((file) => file.depotFile !== null)
        .map((file) => this.toDescribedFileFromOpened(file))
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

    const normalizedChange = normalizeP4Change(metadata.change) ?? change;
    const createdAt = normalizeNullableString(metadata.time);
    const statusValue = normalizeNullableString(metadata.status)?.toLowerCase();

    const description: P4ChangelistDescription = {
      change: normalizedChange,
      user: normalizeNullableString(metadata.user),
      client: normalizeNullableString(metadata.client),
      description: normalizeNullableString(metadata.desc),
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
      if (normalizeNullableString(row.depotFile) !== null) {
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
    const depotFile = this.toDepotPath(row.depotFile);
    const action = this.toFileAction(row.action);
    if (!depotFile || !action) {
      throw new Error(`Unable to parse described file from row: ${JSON.stringify(row)}`);
    }

    return {
      depotFile,
      action,
      type: normalizeNullableString(row.type),
      revision: normalizeNullableNumber(row.rev)
    };
  }

  private toDescribedFileFromOpened(file: P4OpenedFileSummary): P4DescribedFile {
    return {
      depotFile: file.depotFile!,
      action: file.action,
      type: file.type,
      revision: file.revision
    };
  }

  private toPrintResult(requestedDepotFile: string, stdout: string): P4PrintResult {
    const lines = stdout.split(/\r?\n/);
    const headerLine = lines[0] ?? "";
    const header = parseP4PrintHeader(headerLine);
    const contentLines = header ? lines.slice(1) : lines;
    const content = contentLines.join("\n");
    const type = header?.type ?? null;
    const isBinary = isBinaryP4Type(type);

    return {
      depotFile: this.toDepotPath(header?.depotFile ?? requestedDepotFile)!,
      revision: header?.revision ?? null,
      content: isBinary ? "" : content,
      isBinary,
      type
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
    const openedOptions: GetOpenedFilesOptions = { change };
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
    if (items.length === 0) {
      return [];
    }

    const limit = Math.max(1, concurrency);
    const results = new Array<TOutput>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]!);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private toOpenedFileSummary(file: Record<string, unknown>): P4OpenedFileSummary {
    const changelist = normalizeP4Change(file.change) ?? "default";
    const action = this.toFileAction(file.action);
    if (!action) {
      throw new Error(`Unable to parse opened file action from row: ${JSON.stringify(file)}`);
    }

    return {
      depotFile: this.toDepotPath(file.depotFile),
      clientFile: this.toClientPath(file.clientFile),
      localFile: this.toLocalPath(file.path),
      action,
      type: normalizeNullableString(file.type),
      changelist,
      changelistDescription: normalizeNullableString(file.desc),
      user: normalizeNullableString(file.user),
      client: normalizeNullableString(file.client),
      revision: normalizeNullableNumber(file.rev),
      isDefaultChangelist: changelist === "default"
    };
  }

  private toReconcileCandidate(row: Record<string, unknown>): P4ReconcileCandidate {
    const action = normalizeNullableString(row.action);
    if (action !== "add" && action !== "edit" && action !== "delete") {
      throw new Error(`Unsupported reconcile action "${String(row.action)}" in row: ${JSON.stringify(row)}`);
    }

    return {
      depotFile: this.toDepotPath(row.depotFile),
      clientFile: this.toClientPath(row.clientFile),
      localFile: this.toLocalPath(row.path),
      action,
      type: normalizeNullableString(row.type),
      changelist: normalizeP4Change(row.change)
    };
  }

  private toReconcilePreviewResult(rows: Record<string, unknown>[]): P4ReconcilePreviewResult {
    const result: P4ReconcilePreviewResult = {
      added: [],
      edited: [],
      deleted: []
    };

    for (const row of rows) {
      const candidate = this.toReconcileCandidate(row);
      if (candidate.action === "add") result.added.push(candidate);
      else if (candidate.action === "edit") result.edited.push(candidate);
      else result.deleted.push(candidate);
    }

    return result;
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
    return {
      depotFile: this.toDepotPath(row.depotFile),
      clientFile: this.toClientPath(row.clientFile),
      localFile: this.toLocalPath(row.path),
      revision: normalizeNullableNumber(row.rev),
      action: this.toFileAction(row.action),
      fileSize: normalizeNullableNumber(row.fileSize)
    };
  }

  private isSyncErrorRow(row: Record<string, unknown>): boolean {
    const severity = normalizeNullableNumber(row.severity);
    return severity !== null && severity >= 3;
  }

  private toSyncErrorItem(row: Record<string, unknown>): P4SyncErrorItem {
    const data = normalizeNullableString(row.data);
    const clientFile = this.toClientPath(row.clientFile)
      ?? this.toLocalPath(row.path)
      ?? (data ? this.toLocalPath(this.extractFilePathFromSyncErrorData(data)) : null);

    return {
      clientFile,
      depotFile: this.toDepotPath(row.depotFile),
      message: data ?? normalizeNullableString(row.generic) ?? "Perforce sync failed."
    };
  }

  private toDepotPath(value: unknown): P4DepotPath | null {
    const normalized = normalizeNullableString(value);
    return normalized ? normalized as P4DepotPath : null;
  }

  private toClientPath(value: unknown): P4ClientPath | null {
    const normalized = normalizeNullableString(value);
    return normalized ? normalized as P4ClientPath : null;
  }

  private toLocalPath(value: unknown): P4LocalPath | null {
    const normalized = normalizeNullableString(value);
    return normalized ? normalized as P4LocalPath : null;
  }

  private toFileAction(value: unknown): P4FileAction | null {
    const normalized = normalizeNullableString(value);
    return normalized ? normalized as P4FileAction : null;
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
      env: { ...process.env, ...this.env, ...options.env }
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
      commandOptions.timeoutMs = timeoutMs;
    }

    if (options.allowNonZeroExit !== undefined) {
      commandOptions.allowNonZeroExit = options.allowNonZeroExit;
    }

    return commandOptions;
  }

  private async getLocalEnvironment(options: GetEnvironmentOptions): Promise<P4EnvironmentSummary> {
    const cacheKey = this.getSettingsCacheKey(options.settingsSources);
    if (!options.refresh && this.cachedLocalEnvironment?.cacheKey === cacheKey) {
      return this.cachedLocalEnvironment.environment;
    }

    const resolved = await this.resolveLocalSettings(options);
    const environment: P4EnvironmentSummary = {
      hostName: this.configuredHostName ?? getHostName(),
      p4Port: resolved.settings.P4PORT ?? null,
      p4User: resolved.settings.P4USER ?? null,
      p4Client: resolved.settings.P4CLIENT ?? null
    };

    this.cachedLocalEnvironment = { cacheKey, environment };
    return environment;
  }

  private async resolveLocalSettings(
    options: Pick<GetEnvironmentOptions, "refresh" | "settingsSources">
  ): Promise<P4ResolvedSettings> {
    const cacheKey = this.getSettingsCacheKey(options.settingsSources);
    if (!options.refresh && this.cachedResolvedSettings?.cacheKey === cacheKey) {
      return this.cachedResolvedSettings.resolved;
    }

    const cliSettings = await this.readCliSettings(options.settingsSources);
    const resolveOptions = options.settingsSources !== undefined
      ? { sources: options.settingsSources }
      : {};
    const resolved = await resolveP4SettingsWithDetails(cliSettings, resolveOptions);

    this.cachedResolvedSettings = { cacheKey, resolved };
    return resolved;
  }

  private async readCliSettings(sources?: P4SettingsSource[]): Promise<P4CliSettings> {
    if (sources && !sources.includes("cli")) {
      return {};
    }

    const effectiveEnvSettings = this.getEffectiveCliSettings();

    try {
      const result = await this.run(["set", "-q"], { allowNonZeroExit: true });
      const cliSettings = result.exitCode === 0 ? parseP4SetOutput(result.stdout) : {};
      return mergeIncompleteSettings(effectiveEnvSettings, cliSettings);
    } catch {
      return effectiveEnvSettings;
    }
  }

  private getEffectiveCliSettings(): P4CliSettings {
    const effectiveEnv = { ...process.env, ...this.env };
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
    this.cachedEnvironment = null;
    this.cachedWorkspaces = null;
    this.cachedLocalEnvironment = null;
    this.cachedResolvedSettings = null;
  }

  private toCommandError(args: string[], result: P4CommandResult): P4CommandError {
    const details = result.stderr.trim() || result.stdout.trim() || "Unknown error";
    return new P4CommandError(
      `${this.executable} ${args.join(" ")} exited with ${result.exitCode}: ${details}`,
      result
    );
  }

  private tryParseJsonLine(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
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
    const values: T[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<T>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let error: unknown = null;
    let done = false;

    return {
      iterable: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (values.length > 0) {
                return Promise.resolve({ done: false, value: values.shift()! });
              }
              if (error !== null) {
                return Promise.reject(error);
              }
              if (done) {
                return Promise.resolve({ done: true, value: undefined });
              }

              return new Promise<IteratorResult<T>>((resolve, reject) => {
                waiters.push({ resolve, reject });
              });
            }
          };
        }
      },
      push(event: T) {
        if (done || error !== null) return;
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve({ done: false, value: event });
          return;
        }
        values.push(event);
      },
      fail(nextError: unknown) {
        if (done || error !== null) return;
        error = nextError;
        while (waiters.length > 0) {
          waiters.shift()!.reject(nextError);
        }
      },
      finish() {
        if (done || error !== null) return;
        done = true;
        while (waiters.length > 0) {
          waiters.shift()!.resolve({ done: true, value: undefined });
        }
      }
    };
  }
}
