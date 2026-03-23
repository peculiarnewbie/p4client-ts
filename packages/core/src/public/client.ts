import { hostname as getHostName } from "node:os";
import { runCommand, watchCommand } from "../internal/command.js";
import { P4CommandError } from "./errors.js";
import {
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeP4Change,
  parseP4ProgressLine,
  parseP4JsonLines,
  parseP4KeyValueOutput,
  unixSecondsToIsoString
} from "./helpers.js";
import type {
  GetOpenedFilesOptions,
  ListWorkspacesOptions,
  ListPendingChangelistsOptions,
  P4PendingChangelistSummary,
  P4ClientOptions,
  P4CommandOptions,
  P4CommandResult,
  P4CommandStreamEvent,
  P4OperationHandle,
  P4ReconcileProgressEvent,
  P4EnvironmentSummary,
  P4JsonWorkspace,
  P4OpenedFileSummary,
  P4ReconcileCandidate,
  P4ReconcilePreviewResult,
  P4SyncItem,
  P4SyncResult,
  P4SyncPreviewItem,
  P4SyncPreviewResult,
  P4WorkspaceSummary,
  PreviewReconcileOptions,
  PreviewSyncOptions,
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

  private readonly executor;
  private readonly streamExecutor;
  private readonly configuredHostName;
  private cachedEnvironment: P4EnvironmentSummary | null = null;
  private cachedWorkspaces: P4WorkspaceSummary[] | null = null;

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
  async getEnvironment(options: { refresh?: boolean } = {}): Promise<P4EnvironmentSummary> {
    if (!options.refresh && this.cachedEnvironment) {
      return this.cachedEnvironment;
    }

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
      p4Port: effectiveEnv.P4PORT ?? info["Server address"] ?? null,
      // "User name" and "Client name" from p4 info are authoritative — the
      // server resolved them from tickets, env, and client specs.  Env vars
      // are only a last-resort fallback when the server doesn't report them.
      p4User: info["User name"] ?? effectiveEnv.P4USER ?? null,
      p4Client: info["Client name"] ?? effectiveEnv.P4CLIENT ?? null
    };

    this.cachedEnvironment = environment;
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
    const rows = await this.runTaggedJson<Record<string, unknown>>(
      this.getSyncCommandArgs(options, false)
    );

    return this.toSyncResult(rows);
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

  private toOpenedFileSummary(file: Record<string, unknown>): P4OpenedFileSummary {
    const changelist = normalizeP4Change(file.change) ?? "default";
    const action = normalizeNullableString(file.action);
    if (!action) {
      throw new Error(`Unable to parse opened file action from row: ${JSON.stringify(file)}`);
    }

    return {
      depotFile: normalizeNullableString(file.depotFile),
      clientFile: normalizeNullableString(file.clientFile),
      localFile: normalizeNullableString(file.path),
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
      depotFile: normalizeNullableString(row.depotFile),
      clientFile: normalizeNullableString(row.clientFile),
      localFile: normalizeNullableString(row.path),
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
    const items = rows.map((row) => this.toSyncItem(row));

    return {
      items,
      totalCount: items.length
    };
  }

  private toSyncItem(row: Record<string, unknown>): P4SyncItem {
    return {
      depotFile: normalizeNullableString(row.depotFile),
      clientFile: normalizeNullableString(row.clientFile),
      localFile: normalizeNullableString(row.path),
      revision: normalizeNullableNumber(row.rev),
      action: normalizeNullableString(row.action),
      fileSize: normalizeNullableNumber(row.fileSize)
    };
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
    this.appendFileSpecs(commandArgs, options.fileSpec);
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

    if (options.allowNonZeroExit !== undefined) {
      commandOptions.allowNonZeroExit = options.allowNonZeroExit;
    }

    return commandOptions;
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
