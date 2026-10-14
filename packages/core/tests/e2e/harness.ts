import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll } from 'bun:test';
import { Effect, Layer, Stream } from 'effect';
import { P4, P4Executor, configLayer, globalArgs, connectionEnv } from '../../src/index.js';
import { runNodeProcess } from '../../src/node/index.js';
import { createP4ClientFromLayer } from '../../src/promise/index.js';
import { captureProcess } from '../support/process.js';
import type { P4ClientOptions, P4Invocation, SyncOptions } from '../../src/index.js';
import type { P4PromiseClient } from '../../src/promise/index.js';
import type { E2EConfig } from "./config.js";
import { assertSeededWorkspace, type E2EFixture, type FixtureSentinel } from "./fixture.js";

const CONFIG_PATH = "src/app/config.json";
const GUIDE_PATH = "docs/guide/getting-started.md";
const NEW_FEATURE_PATH = "src/app/new-feature.txt";
const RENAME_SOURCE_PATH = "history/chain-source.txt";
const RENAME_TARGET_PATH = "history/chain-renamed.txt";

export class P4E2EHarness {
  readonly client: P4PromiseClient;
  private readonly _clients: P4PromiseClient[] = [];

  constructor(
    readonly config: E2EConfig,
    readonly fixture: E2EFixture
  ) {
    this.client = this.createWorkspaceClient(config.workspaceRoot);
    afterAll(async () => {
      for (const client of this._clients) await client.dispose();
    });
  }

  /**
   * A library client for a disposable workspace, with the same localhost isolation checks.
   * Pass `client` to target a workspace other than the fixture's `P4CLIENT`.
   */
  createWorkspaceClient(cwd: string, client?: string): P4PromiseClient {
    const config = this.config;
    const options: P4ClientOptions = {
      executable: config.p4Executable,
      cwd,
      env: config.p4Env,
      connection: { port: config.p4Port, user: config.user,
        client: client ?? config.client, isolated: true },
      allowMutation: true,
    };
    const executor = Layer.succeed(P4Executor, {
      run: (invocation) => Stream.unwrap(Effect.sync(() => {
        this.assertIsolated(invocation);
        return runNodeProcess(invocation);
      })),
    });
    const derive = (patch: P4ClientOptions) => P4.layer.pipe(
      Layer.provideMerge(Layer.merge(configLayer(patch), executor)),
    );
    const created = createP4ClientFromLayer(derive(options), derive, options);
    this._clients.push(created);
    return created;
  }

  private assertIsolated(invocation: P4Invocation): void {
    const args = invocation.args;
    const ports = args.flatMap((arg, index) => arg === '-p' ? [args[index + 1]] :
      arg.startsWith('-p') ? [arg.slice(2)] : []);
    const batches = args.flatMap((arg, index) => arg === '-x' ? [index] :
      arg.startsWith('-x') ? [-1] : []);
    if (ports.length !== 1 || ports[0] !== this.config.p4Port ||
      this.config.p4Port !== process.env.P4_TS_E2E_ISOLATED_PORT ||
      !/^127\.0\.0\.1:\d+$/.test(this.config.p4Port) ||
      batches.some((index) => index < 0 || args[index + 1] !== '-' || args[index + 2] !== 'print')) {
      throw new Error('Refusing command outside the disposable localhost server.');
    }
  }

  getPath(relativePath: string) {
    return join(this.config.workspaceRoot, relativePath);
  }

  getSeedSentinel(relativePath: string): FixtureSentinel {
    const sentinel = this.fixture.sentinels.find((entry) => entry.relativePath === relativePath);
    if (!sentinel) {
      throw new Error(`Unknown fixture sentinel: ${relativePath}`);
    }
    return sentinel;
  }

  async validateSeededWorkspace() {
    await this.cleanupWorkspace();
    assertSeededWorkspace(this.fixture);
  }

  async cleanupWorkspace() {
    await this.revertKnownPaths();
    this.removeLocalOnlyArtifacts();
    this.restoreSentinel(CONFIG_PATH);
    this.restoreSentinel(GUIDE_PATH);
    await this.syncWorkspace();
    await this.revertKnownPaths();
    this.removeLocalOnlyArtifacts();
  }

  async syncWorkspace() {
    await this.run(["sync", "..."]);
  }

  async previewSync() {
    return this.client.previewSync({ fileSpec: "..." });
  }

  async sync(options: SyncOptions = {}) {
    return this.client.sync({ fileSpec: "...", ...options });
  }

  async prepareBehindHeadWorkspace() {
    await this.run(["sync", `@${this.config.syncBaseChange}`]);
  }

  async assertCleanWorkspace() {
    const openedFiles = await this.client.listOpenedFiles({});
    if (openedFiles.items.length > 0) {
      throw new Error(`Workspace is not clean; found ${openedFiles.items.length} opened file(s).`);
    }

    const reconcilePreview = await this.client.previewReconcile({ fileSpec: "..." });
    if (
      reconcilePreview.added.length > 0 ||
      reconcilePreview.edited.length > 0 ||
      reconcilePreview.deleted.length > 0
    ) {
      throw new Error("Workspace has reconcile candidates after cleanup.");
    }
  }

  async createNumberedChangelist(description: string): Promise<number> {
    const template = await this.run(["change", "-o"]);
    const input = rewriteChangelistTemplate(template.stdout, description);
    const result = await this.run(["change", "-i"], { input });
    const match = /Change\s+(\d+)\s+created\./i.exec(result.stdout);

    if (!match) {
      throw new Error(`Unable to parse created changelist number from output: ${result.stdout}`);
    }

    return Number(match[1]);
  }

  async deleteChangelistIfEmpty(change: number) {
    await this.run(
      ["change", "-d", String(change)],
      { allowNonZeroExit: true }
    );
  }

  async openOpenedFilesScenario(change: number) {
    await this.run(["edit", "-c", String(change), this.getPath(CONFIG_PATH)]);
    appendFileSync(this.getPath(CONFIG_PATH), "\n", "utf8");
    await this.run(["delete", "-c", String(change), this.getPath(GUIDE_PATH)]);
    writeFileSync(this.getPath(NEW_FEATURE_PATH), "p4-ts e2e opened-file fixture\n", "utf8");
    await this.run(["add", this.getPath(NEW_FEATURE_PATH)]);
  }

  createReconcilePreviewScenario() {
    writeFileSync(
      this.getPath(CONFIG_PATH),
      JSON.stringify(
        {
          name: "p4-ts-fixture",
          environment: "test",
          features: {
            reconcilePreview: true,
            syncPreview: true,
            mutatedByE2E: true
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    rmSync(this.getPath(GUIDE_PATH), { force: true });
    writeFileSync(this.getPath(NEW_FEATURE_PATH), "p4-ts e2e reconcile fixture\n", "utf8");
  }

  /**
   * Submit a two-revision file and then rename it, so `p4 filelog -i` on the
   * renamed path reports an integration chain of two depot paths.
   *
   * Re-running against a server that already carries the chain is a no-op, so
   * the scenario stays usable outside the disposable-p4d runner.
   */
  async seedRenameChain(): Promise<{ sourceDepotFile: string; targetDepotFile: string }> {
    const sourceDepotFile = `${this.config.stream}/${RENAME_SOURCE_PATH}`;
    const targetDepotFile = `${this.config.stream}/${RENAME_TARGET_PATH}`;
    if (await this.depotFileExists(targetDepotFile)) {
      return { sourceDepotFile, targetDepotFile };
    }

    const source = this.getPath(RENAME_SOURCE_PATH);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "p4-ts rename chain revision 1\n", "utf8");
    await this.run(["add", source]);
    await this.run(["submit", "-d", "p4-ts E2E rename chain add"]);

    await this.run(["edit", source]);
    appendFileSync(source, "p4-ts rename chain revision 2\n", "utf8");
    await this.run(["submit", "-d", "p4-ts E2E rename chain edit"]);

    await this.run(["edit", source]);
    await this.run(["move", source, this.getPath(RENAME_TARGET_PATH)]);
    await this.run(["submit", "-d", "p4-ts E2E rename chain move"]);

    if (!(await this.depotFileExists(targetDepotFile))) {
      throw new Error(`Seeding the rename chain did not submit ${targetDepotFile}.`);
    }

    return { sourceDepotFile, targetDepotFile };
  }

  /** Exit codes vary by message severity, so key on tagged output instead. */
  async depotFileExists(depotFile: string): Promise<boolean> {
    const result = await this.run(["-Mj", "-z", "tag", "files", depotFile], {
      allowNonZeroExit: true
    });
    return result.stdout.includes("\"depotFile\"");
  }

  async revertRenameChain() {
    await this.run(
      ["revert", this.getPath(RENAME_SOURCE_PATH), this.getPath(RENAME_TARGET_PATH)],
      { allowNonZeroExit: true }
    );
  }

  async revertKnownPaths() {
    await this.run(
      [
        "revert",
        this.getPath(CONFIG_PATH),
        this.getPath(GUIDE_PATH),
        this.getPath(NEW_FEATURE_PATH)
      ],
      { allowNonZeroExit: true }
    );
  }

  removeLocalOnlyArtifacts() {
    rmSync(this.getPath(NEW_FEATURE_PATH), { force: true });
  }

  restoreSentinel(relativePath: string) {
    const sentinel = this.getSeedSentinel(relativePath);
    mkdirSync(dirname(sentinel.workspacePath), { recursive: true });
    copyFileSync(sentinel.seedPath, sentinel.workspacePath);
  }

  async run(args: string[], options: { input?: string; allowNonZeroExit?: boolean } = {}) {
    const connection = { port: this.config.p4Port, user: this.config.user,
      client: this.config.client, isolated: true };
    const invocation: P4Invocation = {
      executable: this.config.p4Executable,
      args: [...globalArgs(connection), ...args],
      cwd: this.config.workspaceRoot,
      env: { ...this.config.p4Env, ...connectionEnv(connection) },
      input: options.input,
    };
    this.assertIsolated(invocation);
    const result = await Effect.runPromise(captureProcess(invocation));
    if (result.exitCode !== 0 && !options.allowNonZeroExit) {
      throw new Error(`Fixture command failed: ${args.join(' ')}\n${result.stderr}${result.stdout}`);
    }
    return result;
  }
}

function rewriteChangelistTemplate(template: string, description: string): string {
  const lines = template.split(/\r?\n/);
  const output: string[] = [];
  let skippingDescription = false;

  for (const line of lines) {
    if (line.startsWith("Change:")) {
      output.push("Change:\tnew");
      continue;
    }

    if (line.startsWith("Description:")) {
      output.push("Description:");
      output.push(`\t${description}`);
      skippingDescription = true;
      continue;
    }

    if (skippingDescription) {
      if (line.startsWith("\t")) {
        continue;
      }

      skippingDescription = false;
    }

    output.push(line);
  }

  return `${output.join("\n").trimEnd()}\n`;
}
