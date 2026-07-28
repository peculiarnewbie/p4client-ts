import { Effect, Stream } from "effect";
import { P4Client } from "./client.js";
import {
  P4ClientOperationError,
  P4CommandError,
  P4MaterializationError,
  P4ParseError,
  P4TimeoutError
} from "./errors.js";
import type { GetEnvironmentOptions, P4ClientOptions, P4Service } from "./types.js";
import type { P4ServiceError } from "./errors.js";

function normalizeGetEnvironmentOptions(options?: boolean | GetEnvironmentOptions): GetEnvironmentOptions {
  if (typeof options === "boolean") {
    return { refresh: options };
  }

  return options ?? {};
}

function toServiceError(error: unknown): P4ServiceError {
  if (
    error instanceof P4CommandError
    || error instanceof P4TimeoutError
    || error instanceof P4ParseError
    || error instanceof P4MaterializationError
    || error instanceof P4ClientOperationError
  ) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new P4ClientOperationError(message, error);
}

function tryClientPromise<T>(promise: () => Promise<T>) {
  return Effect.tryPromise({
    try: promise,
    catch: toServiceError
  });
}

/**
 * Create an Effect-friendly wrapper around {@link P4Client}.
 *
 * The returned service exposes the same typed inspection, preview, and sync
 * operations as `P4Client`, but each operation resolves to an `Effect`.
 */
export function createP4Service(options: P4ClientOptions = {}): P4Service {
  const client = new P4Client(options);

  return {
    getP4Environment: (options) =>
      tryClientPromise(() => client.getEnvironment(normalizeGetEnvironmentOptions(options))),
    listP4Workspaces: (refresh = false) =>
      tryClientPromise(() => client.listWorkspaces({ refresh })),
    listPendingChangelists: (serviceOptions) =>
      tryClientPromise(() => client.listPendingChangelists(serviceOptions)),
    listSubmittedChangelists: (serviceOptions) =>
      tryClientPromise(() => client.listSubmittedChangelists(serviceOptions)),
    listShelvedChangelists: (serviceOptions) =>
      tryClientPromise(() => client.listShelvedChangelists(serviceOptions)),
    listChangelists: (serviceOptions) =>
      tryClientPromise(() => client.listChangelists(serviceOptions)),
    getOpenedFiles: (serviceOptions) =>
      tryClientPromise(() => client.getOpenedFiles(serviceOptions)),
    getChangelistFiles: (change, serviceOptions) =>
      tryClientPromise(() => client.getChangelistFiles(change, serviceOptions)),
    previewReconcile: (serviceOptions) =>
      tryClientPromise(() => client.previewReconcile(serviceOptions)),
    streamPreviewReconcile: (serviceOptions) =>
      Stream.unwrap(
        Effect.sync(() =>
          Stream.fromAsyncIterable(
            client.watchPreviewReconcile(serviceOptions).events,
            toServiceError
          )
        )
      ),
    previewSync: (serviceOptions) =>
      tryClientPromise(() => client.previewSync(serviceOptions)),
    sync: (serviceOptions) =>
      tryClientPromise(() => client.sync(serviceOptions)),
    streamSync: (serviceOptions) =>
      Stream.unwrap(
        Effect.sync(() =>
          Stream.fromAsyncIterable(
            client.watchSync(serviceOptions).events,
            toServiceError
          )
        )
      ),
    setClient: (serviceOptions) =>
      tryClientPromise(() => client.setClient(serviceOptions)),
    switchWorkspace: (clientName) =>
      tryClientPromise(() => client.switchWorkspace(clientName)),
    describeChangelist: (change, serviceOptions) =>
      tryClientPromise(() => client.describeChangelist(change, serviceOptions)),
    diffFile: (serviceOptions) =>
      tryClientPromise(() => client.diffFile(serviceOptions)),
    printFile: (depotFile, serviceOptions) =>
      tryClientPromise(() => client.printFile(depotFile, serviceOptions)),
    listDepotFilesAtChange: (serviceOptions) =>
      tryClientPromise(() => client.listDepotFilesAtChange(serviceOptions)),
    materializeDepotFiles: (serviceOptions) =>
      tryClientPromise(() => client.materializeDepotFiles(serviceOptions)),
    getChangelistDiffSummary: (change, serviceOptions) =>
      tryClientPromise(() => client.getChangelistDiffSummary(change, serviceOptions))
  };
}

const defaultService = createP4Service();

/**
 * Read common Perforce environment values using the default Effect service.
 */
export function getP4Environment(options?: boolean | GetEnvironmentOptions) {
  return defaultService.getP4Environment(options);
}

/**
 * List workspaces using the default Effect service.
 */
export function listP4Workspaces(refresh = false) {
  return defaultService.listP4Workspaces(refresh);
}

/**
 * List pending changelists using the default Effect service.
 */
export function listPendingChangelists(options?: Parameters<P4Service["listPendingChangelists"]>[0]) {
  return defaultService.listPendingChangelists(options);
}

/**
 * List submitted changelists using the default Effect service.
 */
export function listSubmittedChangelists(options?: Parameters<P4Service["listSubmittedChangelists"]>[0]) {
  return defaultService.listSubmittedChangelists(options);
}

/**
 * List shelved changelists using the default Effect service.
 */
export function listShelvedChangelists(options?: Parameters<P4Service["listShelvedChangelists"]>[0]) {
  return defaultService.listShelvedChangelists(options);
}

/**
 * List pending, submitted, or shelved changelists using the default Effect service.
 */
export function listChangelists(options: Parameters<P4Service["listChangelists"]>[0]) {
  return defaultService.listChangelists(options);
}

/**
 * List opened files using the default Effect service.
 */
export function getOpenedFiles(options?: Parameters<P4Service["getOpenedFiles"]>[0]) {
  return defaultService.getOpenedFiles(options);
}

/**
 * List files for a specific changelist using the default Effect service.
 */
export function getChangelistFiles(
  change: Parameters<P4Service["getChangelistFiles"]>[0],
  options?: Parameters<P4Service["getChangelistFiles"]>[1]
) {
  return defaultService.getChangelistFiles(change, options);
}

/**
 * Preview reconcile results using the default Effect service.
 */
export function previewReconcile(options?: Parameters<P4Service["previewReconcile"]>[0]) {
  return defaultService.previewReconcile(options);
}

/**
 * Stream reconcile preview progress events using the default Effect service.
 */
export function streamPreviewReconcile(options?: Parameters<P4Service["streamPreviewReconcile"]>[0]) {
  return defaultService.streamPreviewReconcile(options);
}

/**
 * Preview sync results using the default Effect service.
 */
export function previewSync(options?: Parameters<P4Service["previewSync"]>[0]) {
  return defaultService.previewSync(options);
}

/**
 * Perform sync using the default Effect service.
 *
 * Call {@link previewSync} first when you want a preview-first workflow.
 */
export function sync(options?: Parameters<P4Service["sync"]>[0]) {
  return defaultService.sync(options);
}

/**
 * Stream sync progress using the default Effect service.
 */
export function streamSync(options?: Parameters<P4Service["streamSync"]>[0]) {
  return defaultService.streamSync(options);
}

/**
 * Set the active Perforce client using the default Effect service.
 */
export function setClient(options: Parameters<P4Service["setClient"]>[0]) {
  return defaultService.setClient(options);
}

/**
 * Switch the active Perforce workspace using the default Effect service.
 */
export function switchWorkspace(client: Parameters<P4Service["switchWorkspace"]>[0]) {
  return defaultService.switchWorkspace(client);
}

/**
 * Describe a changelist using the default Effect service.
 */
export function describeChangelist(
  change: Parameters<P4Service["describeChangelist"]>[0],
  options?: Parameters<P4Service["describeChangelist"]>[1]
) {
  return defaultService.describeChangelist(change, options);
}

/**
 * Diff a depot file against the workspace using the default Effect service.
 */
export function diffFile(options: Parameters<P4Service["diffFile"]>[0]) {
  return defaultService.diffFile(options);
}

/**
 * Print depot file content using the default Effect service.
 */
export function printFile(
  depotFile: Parameters<P4Service["printFile"]>[0],
  options?: Parameters<P4Service["printFile"]>[1]
) {
  return defaultService.printFile(depotFile, options);
}

/**
 * List exact depot revisions at a submitted changelist using the default
 * Effect service.
 */
export function listDepotFilesAtChange(
  options: Parameters<P4Service["listDepotFilesAtChange"]>[0]
) {
  return defaultService.listDepotFilesAtChange(options);
}

/**
 * Materialize exact depot revisions using the default Effect service.
 */
export function materializeDepotFiles(
  options: Parameters<P4Service["materializeDepotFiles"]>[0]
) {
  return defaultService.materializeDepotFiles(options);
}

/**
 * Build a changelist diff summary using the default Effect service.
 */
export function getChangelistDiffSummary(
  change: Parameters<P4Service["getChangelistDiffSummary"]>[0],
  options?: Parameters<P4Service["getChangelistDiffSummary"]>[1]
) {
  return defaultService.getChangelistDiffSummary(change, options);
}
