import { existsSync } from "node:fs";
import { hostname as getHostName } from "node:os";
import { runCommand } from "../internal/command.js";
import { P4CommandError } from "./errors.js";
import {
  isLocalWorkspace,
  parseP4JsonLines,
  parseP4KeyValueOutput,
  unixSecondsToIsoString
} from "./helpers.js";
import type {
  ListWorkspacesOptions,
  P4ClientOptions,
  P4CommandOptions,
  P4CommandResult,
  P4EnvironmentSummary,
  P4JsonWorkspace,
  P4WorkspaceSummary,
  RunTaggedJsonOptions
} from "./types.js";

export class P4Client {
  readonly executable: string;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;

  private readonly executor;
  private readonly pathExists;
  private readonly configuredHostName;
  private cachedEnvironment: P4EnvironmentSummary | null = null;
  private cachedWorkspaces: P4WorkspaceSummary[] | null = null;

  constructor(options: P4ClientOptions = {}) {
    this.executable = options.executable ?? "p4";
    this.cwd = options.cwd;
    this.env = options.env;
    this.configuredHostName = options.hostName;
    this.pathExists = options.pathExists ?? existsSync;
    this.executor = options.executor ?? runCommand;
  }

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

  async getEnvironment(options: { refresh?: boolean } = {}): Promise<P4EnvironmentSummary> {
    if (!options.refresh && this.cachedEnvironment) {
      return this.cachedEnvironment;
    }

    const result = await this.run(["info"]);
    const info = parseP4KeyValueOutput(result.stdout);

    const environment: P4EnvironmentSummary = {
      hostName: info["Client host"] ?? this.configuredHostName ?? getHostName(),
      p4Port: info["Server address"] ?? this.env?.P4PORT ?? process.env.P4PORT ?? null,
      p4User: info["User name"] ?? this.env?.P4USER ?? process.env.P4USER ?? null,
      p4Client: info["Client name"] ?? this.env?.P4CLIENT ?? process.env.P4CLIENT ?? null
    };

    this.cachedEnvironment = environment;
    return environment;
  }

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
          {
            root: workspace.Root,
            host: workspace.Host ?? null
          },
          hostName,
          this.pathExists
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
}
