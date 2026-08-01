import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const coreRoot = join(repositoryRoot, "packages", "core");
const fixtureRoot = join(repositoryRoot, "packages", "test-stream");
const fixtureUser = "p4ts-e2e";
const fixtureClient = "p4ts_e2e_client";
const fixtureStream = "//p4ts/main";
const fixtureDepot = "p4ts";
const configFileName = ".p4config";
const ignoreFileName = ".p4ignore";
const headOnlyPath = "src/app/head-only.txt";
const commandTimeoutMs = 30_000;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface PlatformBinary {
  readonly name: string;
  readonly sha256: string;
}

interface PlatformBinaries {
  readonly directory: string;
  readonly p4: PlatformBinary;
  readonly p4d: PlatformBinary;
}

interface ResolvedBinaries {
  readonly p4: string;
  readonly p4d: string;
}

interface SubmittedChange {
  readonly change: number;
}

interface FixtureManifest {
  readonly stream: {
    readonly name: string;
  };
  readonly workspace: {
    readonly rootFolderName: string;
  };
  readonly seedRoot: string;
}

interface Fixture {
  readonly environment: NodeJS.ProcessEnv;
  readonly p4Executable: string;
  readonly projectRoot: string;
  readonly baselineChange: number;
  readonly stop: () => Promise<void>;
}

const perforceRelease = "r26.1";
const perforceDownloadRoot = `https://ftp.perforce.com/perforce/${perforceRelease}`;
const platformBinaries: Partial<Record<NodeJS.Platform, PlatformBinaries>> = {
  darwin: {
    directory: "bin.darwin90x86_64",
    p4: {
      name: "p4",
      sha256: "a539b30d5b6ee80685bfb691b17e6c1ef50bfcaa9f1c6c7034301f423ab1224f"
    },
    p4d: {
      name: "p4d",
      sha256: "cfc32bbbe57476fcdd4ff9d0f49ae429e91d46751a16c99dd5ec4c7123882474"
    }
  },
  linux: {
    directory: "bin.linux26x86_64",
    p4: {
      name: "p4",
      sha256: "a539b30d5b6ee80685bfb691b17e6c1ef50bfcaa9f1c6c7034301f423ab1224f"
    },
    p4d: {
      name: "p4d",
      sha256: "cfc32bbbe57476fcdd4ff9d0f49ae429e91d46751a16c99dd5ec4c7123882474"
    }
  },
  win32: {
    directory: "bin.ntx64",
    p4: {
      name: "p4.exe",
      sha256: "1fe2730acda5df7dee244aa4d22d6dfe3698176a2d127eb801ba94a9cf41d9b4"
    },
    p4d: {
      name: "p4d.exe",
      sha256: "025b87752de37047ed1398f31b88c6f6c6d62086e74ca6600fc1617fd24f22e1"
    }
  }
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function report(status: string, message: string): void {
  process.stdout.write(`${status} p4-ts E2E: ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanP4Environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.PWD;
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("P4")) {
      delete environment[key];
    }
  }
  return { ...environment, ...overrides };
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly timeoutMs?: number;
  }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? commandTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const result = {
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8")
      };
      if (result.exitCode === 0) {
        resolvePromise(result);
        return;
      }

      reject(
        new Error(
          `${basename(command)} ${args.join(" ")} failed with ${result.exitCode}${
            signal ? ` (${signal})` : ""
          }: ${result.stderr || result.stdout}`
        )
      );
    });

    if (options.input === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(options.input);
    }
  });
}

function runVisible(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd,
        env,
        stdio: "inherit",
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${basename(command)} exited with ${exitCode ?? -1}${signal ? ` (${signal})` : ""}.`));
    });
  });
}

function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a localhost port for the disposable p4d server."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
    });
  });
}

async function waitForServer(
  p4: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await run(p4, ["info"], { cwd, env: environment, timeoutMs: 1_000 });
      return;
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error("The disposable p4d server did not become ready.", { cause: lastError });
}

function cacheRoot(): string {
  const configured = process.env.P4_TS_E2E_BINARY_CACHE;
  if (configured) {
    return resolve(configured);
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? tmpdir(), "p4-ts", "perforce");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "p4-ts", "perforce");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function resolveCachedBinary(directory: string, binary: PlatformBinary): Promise<string> {
  const destinationDirectory = join(cacheRoot(), perforceRelease, directory);
  const destination = join(destinationDirectory, binary.name);
  await mkdir(destinationDirectory, { recursive: true });

  try {
    await access(destination);
    const actual = await sha256(destination);
    assert(
      actual === binary.sha256,
      `Cached ${binary.name} does not match the pinned SHA-256. Remove ${destination} and retry.`
    );
    report("RUN ", `using hash-verified cached ${binary.name}`);
    return destination;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const url = `${perforceDownloadRoot}/${directory}/${binary.name}`;
  report("RUN ", `downloading pinned ${binary.name} from Perforce`);
  const response = await fetch(url);
  assert(response.ok, `Could not download ${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert(
    actual === binary.sha256,
    `Downloaded ${binary.name} did not match its pinned SHA-256 (${actual}).`
  );
  await writeFile(destination, bytes, { flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(destination, 0o755);
  }
  return destination;
}

async function resolveBinaries(): Promise<ResolvedBinaries> {
  const configuredP4 = process.env.P4_TS_E2E_P4_EXECUTABLE;
  const configuredP4d = process.env.P4_TS_E2E_P4D_EXECUTABLE;
  if (configuredP4 || configuredP4d) {
    assert(
      configuredP4 && configuredP4d,
      "Set both P4_TS_E2E_P4_EXECUTABLE and P4_TS_E2E_P4D_EXECUTABLE."
    );
    await Promise.all([access(configuredP4), access(configuredP4d)]);
    report("RUN ", "using explicitly configured isolated p4 and p4d binaries");
    return { p4: configuredP4, p4d: configuredP4d };
  }

  const platform = platformBinaries[process.platform];
  assert(
    platform !== undefined,
    `No pinned Perforce binary pair is configured for ${process.platform}. Set both explicit executable paths.`
  );
  return {
    p4: await resolveCachedBinary(platform.directory, platform.p4),
    p4d: await resolveCachedBinary(platform.directory, platform.p4d)
  };
}

function readJson(path: string): Promise<unknown> {
  return readFile(path, "utf8").then((contents) => JSON.parse(contents) as unknown);
}

async function loadFixtureManifest(): Promise<{ readonly manifest: FixtureManifest; readonly seedRoot: string }> {
  const value = await readJson(join(fixtureRoot, "stream-manifest.json"));
  assert(typeof value === "object" && value !== null, "stream-manifest.json must contain an object.");
  const record = value as Record<string, unknown>;
  const stream = record.stream;
  const workspace = record.workspace;
  const seedRoot = record.seedRoot;
  assert(typeof stream === "object" && stream !== null, "stream-manifest.json is missing stream metadata.");
  assert(typeof workspace === "object" && workspace !== null, "stream-manifest.json is missing workspace metadata.");
  assert(typeof seedRoot === "string" && seedRoot.length > 0, "stream-manifest.json is missing seedRoot.");
  const streamRecord = stream as Record<string, unknown>;
  const workspaceRecord = workspace as Record<string, unknown>;
  assert(streamRecord.name === fixtureStream, `Fixture stream must be ${fixtureStream}.`);
  assert(
    typeof workspaceRecord.rootFolderName === "string" && workspaceRecord.rootFolderName.length > 0,
    "stream-manifest.json is missing workspace.rootFolderName."
  );
  const manifest: FixtureManifest = {
    stream: { name: fixtureStream },
    workspace: { rootFolderName: workspaceRecord.rootFolderName },
    seedRoot
  };
  return { manifest, seedRoot: resolve(fixtureRoot, seedRoot) };
}

async function runP4(
  p4: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = commandTimeoutMs
): Promise<CommandResult> {
  const result = await run(p4, args, { cwd, env: environment, input, timeoutMs });
  return result;
}

async function latestSubmittedChange(
  p4: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): Promise<SubmittedChange> {
  const result = await runP4(
    p4,
    ["-Mj", "-z", "tag", "changes", "-s", "submitted", "-m", "1"],
    cwd,
    environment
  );
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.length > 0);
  assert(line !== undefined, "Perforce did not return the submitted fixture changelist.");
  const parsed: unknown = JSON.parse(line);
  assert(typeof parsed === "object" && parsed !== null, "Perforce returned an invalid changelist row.");
  const change = Number((parsed as Record<string, unknown>).change);
  assert(Number.isSafeInteger(change) && change > 0, "Perforce returned an invalid changelist number.");
  return { change };
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: entry.isDirectory() });
  }
}

async function createDepot(p4: string, environment: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const specification = [
    `Depot: ${fixtureDepot}`,
    `Owner: ${fixtureUser}`,
    "Description:",
    "\tDisposable p4-ts E2E conformance depot.",
    "Type: stream",
    "StreamDepth: 1",
    "Address: local",
    `Map: ${fixtureDepot}/...`,
    ""
  ].join("\n");
  await runP4(p4, ["depot", "-i"], cwd, environment, specification);
}

async function createStream(p4: string, environment: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const specification = [
    `Stream: ${fixtureStream}`,
    "Update:",
    "Access:",
    `Owner: ${fixtureUser}`,
    "Name: main",
    "Parent: none",
    "Type: mainline",
    "ParentView: inherit",
    "Options: allsubmit unlocked",
    "Description:",
    "\tDisposable p4-ts E2E mainline stream.",
    "Paths:",
    "\tshare ...",
    ""
  ].join("\n");
  await runP4(p4, ["stream", "-i"], cwd, environment, specification);
}

async function createClient(
  p4: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  workspace: string
): Promise<void> {
  const specification = [
    `Client: ${fixtureClient}`,
    `Owner: ${fixtureUser}`,
    `Root: ${workspace}`,
    "Options: allwrite clobber nocompress unlocked nomodtime rmdir",
    "LineEnd: local",
    `Stream: ${fixtureStream}`,
    ""
  ].join("\n");
  await runP4(p4, ["client", "-i"], cwd, environment, specification);
}

async function submitFixture(
  p4: string,
  environment: NodeJS.ProcessEnv,
  workspace: string,
  description: string
): Promise<SubmittedChange> {
  await runP4(p4, ["submit", "-d", description], workspace, environment);
  return latestSubmittedChange(p4, environment, workspace);
}

async function seedFixture(
  p4: string,
  environment: NodeJS.ProcessEnv,
  workspace: string,
  seedRoot: string
): Promise<number> {
  await writeFile(join(workspace, ignoreFileName), `${configFileName}\n${ignoreFileName}\n`, "utf8");
  await copyDirectoryContents(seedRoot, workspace);
  await runP4(p4, ["add", join(workspace, "...")], workspace, environment);
  const baseline = await submitFixture(p4, environment, workspace, "p4-ts E2E fixture baseline");

  const headOnlyFile = join(workspace, headOnlyPath);
  await mkdir(dirname(headOnlyFile), { recursive: true });
  await writeFile(headOnlyFile, "p4-ts isolated E2E head revision\n", "utf8");
  await runP4(p4, ["add", headOnlyFile], workspace, environment);
  await submitFixture(p4, environment, workspace, "p4-ts E2E fixture head revision");
  await writeFile(
    join(workspace, configFileName),
    [
      `P4PORT=${environment.P4PORT}`,
      `P4USER=${fixtureUser}`,
      `P4CLIENT=${fixtureClient}`,
      `P4TICKETS=${environment.P4TICKETS}`,
      `P4TRUST=${environment.P4TRUST}`,
      `P4IGNORE=${ignoreFileName}`,
      "P4CHARSET=none",
      ""
    ].join("\n"),
    "utf8"
  );
  return baseline.change;
}

async function stopServer(
  server: ChildProcess | undefined,
  p4: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): Promise<void> {
  if (server === undefined) {
    return;
  }
  try {
    await runP4(p4, ["admin", "stop"], cwd, environment, undefined, 5_000);
  } catch {
    // The process fallback below is scoped to the disposable operation root.
  }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
  }
  await waitForProcessExit(server);
}

async function startFixture(): Promise<Fixture> {
  const binaries = await resolveBinaries();
  const { manifest, seedRoot } = await loadFixtureManifest();
  const operationRoot = await mkdtemp(join(tmpdir(), "p4-ts-e2e-"));
  const serverRoot = join(operationRoot, "server");
  const workspace = join(operationRoot, manifest.workspace.rootFolderName);
  const tickets = join(operationRoot, "tickets.txt");
  const trust = join(operationRoot, "trust.txt");
  const enviro = join(operationRoot, "p4enviro.txt");
  const port = await getAvailablePort();
  const p4Port = `127.0.0.1:${port}`;
  const environment = cleanP4Environment({
    P4CHARSET: "none",
    P4CLIENT: fixtureClient,
    P4CONFIG: configFileName,
    P4ENVIRO: enviro,
    P4HOST: fixtureClient,
    P4IGNORE: ignoreFileName,
    P4PORT: p4Port,
    P4TICKETS: tickets,
    P4TRUST: trust,
    P4USER: fixtureUser
  });
  let server: ChildProcess | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await stopServer(server, binaries.p4, environment, operationRoot);
    await rm(operationRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
    report("RUN ", "removed the disposable p4d server, client, workspace, and settings");
  };

  try {
    await Promise.all([mkdir(serverRoot), mkdir(workspace), writeFile(enviro, "", "utf8")]);
    const startServer = (): ChildProcess =>
      spawn(
        binaries.p4d,
        ["-r", serverRoot, "-p", p4Port, "-L", join(operationRoot, "p4d.log")],
        { cwd: operationRoot, env: cleanP4Environment(), stdio: "ignore", windowsHide: true }
      );

    report("RUN ", `starting disposable localhost p4d on ${p4Port}`);
    server = startServer();
    await waitForServer(binaries.p4, environment, operationRoot);
    server.kill();
    await waitForProcessExit(server);
    for (const setting of [
      "security=0",
      "dm.user.hideinvalid=0",
      "dm.user.noautocreate=1",
      "dm.user.setinitialpasswd=1"
    ]) {
      await run(binaries.p4d, ["-r", serverRoot, `-cset ${setting}`], {
        cwd: operationRoot,
        env: cleanP4Environment()
      });
    }
    server = startServer();
    await waitForServer(binaries.p4, environment, operationRoot);
    await runP4(
      binaries.p4,
      ["user", "-i"],
      operationRoot,
      environment,
      [
        `User: ${fixtureUser}`,
        "Email: p4-ts-e2e@example.invalid",
        "FullName: p4-ts isolated E2E fixture",
        "Type: standard",
        "AuthMethod: perforce",
        ""
      ].join("\n")
    );
    await createDepot(binaries.p4, environment, operationRoot);
    await createStream(binaries.p4, environment, operationRoot);
    await createClient(binaries.p4, environment, operationRoot, workspace);
    const baselineChange = await seedFixture(binaries.p4, environment, workspace, seedRoot);
    report("RUN ", `seeded ${fixtureStream} with baseline ${baselineChange} and a pending-sync head revision`);

    return {
      environment,
      p4Executable: binaries.p4,
      projectRoot: workspace,
      baselineChange,
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function runE2E(fixture: Fixture): Promise<void> {
  const environment = cleanP4Environment({
    ...fixture.environment,
    P4_TS_E2E_P4_EXECUTABLE: fixture.p4Executable,
    P4_TS_E2E_STREAM: fixtureStream,
    P4_TS_E2E_SYNC_BASE_CHANGE: String(fixture.baselineChange),
    P4_TS_E2E_WORKSPACE_ROOT: fixture.projectRoot
  });
  report("RUN ", "running the canonical E2E scenarios against the disposable fixture");
  await runVisible(process.execPath, ["test", "tests/e2e"], coreRoot, environment);
}

async function main(): Promise<void> {
  const fixture = await startFixture();
  try {
    await runE2E(fixture);
  } finally {
    await fixture.stop();
  }
}

main().catch((error: unknown) => {
  report("FAIL", errorMessage(error));
  process.exitCode = 1;
});
