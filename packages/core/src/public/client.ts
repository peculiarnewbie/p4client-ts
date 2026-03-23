import { hostname as getHostName } from "node:os";
import { runCommand } from "../internal/command.js";
import { P4CommandError } from "./errors.js";
import {
  isLocalWorkspace,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeP4Change,
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
  P4EnvironmentSummary,
  P4JsonWorkspace,
  P4OpenedFileSummary,
  P4ReconcileCandidate,
  P4ReconcilePreviewResult,
  P4SyncPreviewItem,
  P4SyncPreviewResult,
  P4WorkspaceSummary,
  PreviewReconcileOptions,
  PreviewSyncOptions,
  RunTaggedJsonOptions
} from "./types.js";

/**
 * Thin, typed wrapper around the Perforce `p4` CLI.
 *
 * `P4Client` focuses on read-only inspection plus preview-style workflows such
 * as `sync -n` and `reconcile -n`. The instance caches environment and workspace
 * lookups unless a method is called with `refresh: true`.
 */
export class P4Client {
  readonly executable: string;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;

  private readonly executor;
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

    const result = await this.executor(this.executable, args, commandOptions);

    if (result.exitCode !== 0 && !commandOptions.allowNonZeroExit) {
      const details = result.stderr.trim() || result.stdout.trim() || "Unknown error";
      throw new P4CommandError(
        `${this.executable} ${args.join(" ")} exited with ${result.exitCode}: ${details}`,
        result
      );
    }

    return result;
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

    const rows = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
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

  /**
   * Preview sync results using `p4 sync -n`.
   *
   * This method never performs the sync itself. The returned `totalCount`
   * mirrors the number of preview rows emitted by Perforce.
   */
  async previewSync(options: PreviewSyncOptions = {}): Promise<P4SyncPreviewResult> {
    const commandArgs = ["sync", "-n"];
    if (options.force) {
      commandArgs.push("-f");
    }
    this.appendFileSpecs(commandArgs, options.fileSpec);

    const rows = await this.runTaggedJson<Record<string, unknown>>(commandArgs);
    const items = rows.map((row) => this.toSyncPreviewItem(row));

    return {
      items,
      totalCount: items.length
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

  private toSyncPreviewItem(row: Record<string, unknown>): P4SyncPreviewItem {
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
}
