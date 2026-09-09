import { Effect, Stream } from "effect";
import { createCancellationScope, settleOperation } from '../internal/cancellation.js';
import { P4Client } from "./client.js";
import {
  P4ClientOperationError,
  P4CommandError,
  P4MaterializationError,
  P4ParseError,
  P4TimeoutError
} from "./errors.js";
import type { GetEnvironmentOptions, P4ClientOptions, P4OperationHandle, P4Service } from "./types.js";
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

function tryClientPromise<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal
): Effect.Effect<T, P4ServiceError> {
  return Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(
      Effect.sync(() => createCancellationScope(parent)),
      (scope) => Effect.sync(scope.dispose)
    );
    const result = yield* Effect.acquireRelease(
      Effect.try({ try: () => operation(scope.signal), catch: toServiceError }),
      (result) => Effect.sync(scope.abort).pipe(Effect.andThen(settleOperation(result)))
    );
    return yield* Effect.tryPromise({ try: () => result, catch: toServiceError });
  }));
}

function streamClientOperation<TEvent, TResult>(
  operation: (signal: AbortSignal) => P4OperationHandle<TEvent, TResult>,
  parent?: AbortSignal
): Stream.Stream<TEvent, P4ServiceError> {
  return Stream.unwrap(Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(
      Effect.sync(() => createCancellationScope(parent)),
      (scope) => Effect.sync(scope.dispose)
    );
    const handle = yield* Effect.acquireRelease(
      Effect.try({ try: () => operation(scope.signal), catch: toServiceError }),
      (handle) => Effect.sync(scope.abort).pipe(Effect.andThen(settleOperation(handle.result)))
    );
    // The final result can fail even when a custom event source finishes normally.
    return Stream.fromAsyncIterable(handle.events, toServiceError).pipe(
      Stream.concat(Stream.fromEffect(
        Effect.tryPromise({ try: () => handle.result, catch: toServiceError })
      ).pipe(Stream.drain))
    );
  }));
}

/**
 * Create an Effect-friendly wrapper around {@link P4Client}.
 *
 * The returned service exposes the same typed inspection, preview, and sync
 * operations as `P4Client`, but each operation resolves to an `Effect`.
 * Interruption cancels that invocation and waits for its owned work to settle.
 * Ending a stream early also cancels and joins the underlying operation.
 */
export function createP4Service(options: P4ClientOptions = {}): P4Service {
  const client = new P4Client(options);

  return {
    getP4Environment: (options) =>
      tryClientPromise(
        (signal) => client.getEnvironment({ ...normalizeGetEnvironmentOptions(options), signal }),
        normalizeGetEnvironmentOptions(options).signal
      ),
    listP4Workspaces: (refresh = false) =>
      tryClientPromise((signal) => client.listWorkspaces({ refresh, signal })),
    listPendingChangelists: (serviceOptions) =>
      tryClientPromise((signal) => client.listPendingChangelists({ ...serviceOptions, signal }), serviceOptions?.signal),
    listSubmittedChangelists: (serviceOptions) =>
      tryClientPromise((signal) => client.listSubmittedChangelists({ ...serviceOptions, signal }), serviceOptions?.signal),
    listShelvedChangelists: (serviceOptions) =>
      tryClientPromise((signal) => client.listShelvedChangelists({ ...serviceOptions, signal }), serviceOptions?.signal),
    listChangelists: (serviceOptions) =>
      tryClientPromise((signal) => client.listChangelists({ ...serviceOptions, signal }), serviceOptions?.signal),
    getOpenedFiles: (serviceOptions) =>
      tryClientPromise((signal) => client.getOpenedFiles({ ...serviceOptions, signal }), serviceOptions?.signal),
    getChangelistFiles: (change, serviceOptions) =>
      tryClientPromise((signal) => client.getChangelistFiles(change, { ...serviceOptions, signal }), serviceOptions?.signal),
    previewReconcile: (serviceOptions) =>
      tryClientPromise((signal) => client.previewReconcile({ ...serviceOptions, signal }), serviceOptions?.signal),
    streamPreviewReconcile: (serviceOptions) =>
      streamClientOperation(
        (signal) => client.watchPreviewReconcile({ ...serviceOptions, signal }),
        serviceOptions?.signal
      ),
    previewSync: (serviceOptions) =>
      tryClientPromise((signal) => client.previewSync({ ...serviceOptions, signal }), serviceOptions?.signal),
    sync: (serviceOptions) =>
      tryClientPromise((signal) => client.sync({ ...serviceOptions, signal }), serviceOptions?.signal),
    streamSync: (serviceOptions) =>
      streamClientOperation(
        (signal) => client.watchSync({ ...serviceOptions, signal }),
        serviceOptions?.signal
      ),
    setClient: (serviceOptions) =>
      tryClientPromise((signal) => client.setClient({ ...serviceOptions, signal }), serviceOptions?.signal),
    switchWorkspace: (clientName) =>
      tryClientPromise((signal) => client.switchWorkspace(clientName, { signal })),
    describeChangelist: (change, serviceOptions) =>
      tryClientPromise((signal) => client.describeChangelist(change, { ...serviceOptions, signal }), serviceOptions?.signal),
    diffFile: (serviceOptions) =>
      tryClientPromise((signal) => client.diffFile({ ...serviceOptions, signal }), serviceOptions?.signal),
    printFile: (depotFile, serviceOptions) =>
      tryClientPromise((signal) => client.printFile(depotFile, { ...serviceOptions, signal }), serviceOptions?.signal),
    listDepotFilesAtChange: (serviceOptions) =>
      tryClientPromise((signal) => client.listDepotFilesAtChange({ ...serviceOptions, signal }), serviceOptions?.signal),
    materializeDepotFiles: (serviceOptions) =>
      tryClientPromise((signal) => client.materializeDepotFiles({ ...serviceOptions, signal }), serviceOptions?.signal),
    getChangelistDiffSummary: (change, serviceOptions) =>
      tryClientPromise((signal) => client.getChangelistDiffSummary(change, { ...serviceOptions, signal }), serviceOptions?.signal),
    listDepots: (serviceOptions) =>
      tryClientPromise((signal) => client.listDepots({ ...serviceOptions, signal }), serviceOptions?.signal),
    listDepotDirs: (serviceOptions) =>
      tryClientPromise((signal) => client.listDepotDirs({ ...serviceOptions, signal }), serviceOptions?.signal),
    listDepotFiles: (serviceOptions) =>
      tryClientPromise((signal) => client.listDepotFiles({ ...serviceOptions, signal }), serviceOptions?.signal),
    statFiles: (serviceOptions) =>
      tryClientPromise((signal) => client.statFiles({ ...serviceOptions, signal }), serviceOptions?.signal),
    whereFiles: (serviceOptions) =>
      tryClientPromise((signal) => client.whereFiles({ ...serviceOptions, signal }), serviceOptions?.signal),
    getFileHistory: (serviceOptions) =>
      tryClientPromise((signal) => client.getFileHistory({ ...serviceOptions, signal }), serviceOptions?.signal),
    listUsers: (serviceOptions) =>
      tryClientPromise((signal) => client.listUsers({ ...serviceOptions, signal }), serviceOptions?.signal),
    listStreams: (serviceOptions) =>
      tryClientPromise((signal) => client.listStreams({ ...serviceOptions, signal }), serviceOptions?.signal),
    annotateFile: (serviceOptions) =>
      tryClientPromise((signal) => client.annotateFile({ ...serviceOptions, signal }), serviceOptions?.signal)
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

/**
 * List top-level depots using the default Effect service.
 */
export function listDepots(options?: Parameters<P4Service["listDepots"]>[0]) {
  return defaultService.listDepots(options);
}

/**
 * List immediate subdirectories of a depot path using the default Effect service.
 */
export function listDepotDirs(options: Parameters<P4Service["listDepotDirs"]>[0]) {
  return defaultService.listDepotDirs(options);
}

/**
 * List immediate files of a depot path using the default Effect service.
 */
export function listDepotFiles(options: Parameters<P4Service["listDepotFiles"]>[0]) {
  return defaultService.listDepotFiles(options);
}

/**
 * Resolve rich per-file metadata using the default Effect service.
 */
export function statFiles(options: Parameters<P4Service["statFiles"]>[0]) {
  return defaultService.statFiles(options);
}

/**
 * Map file specs across depot, client, and local syntax using the default
 * Effect service.
 */
export function whereFiles(options: Parameters<P4Service["whereFiles"]>[0]) {
  return defaultService.whereFiles(options);
}

/**
 * Read a file's revision history using the default Effect service.
 */
export function getFileHistory(options: Parameters<P4Service["getFileHistory"]>[0]) {
  return defaultService.getFileHistory(options);
}

/**
 * Resolve Perforce users using the default Effect service.
 */
export function listUsers(options?: Parameters<P4Service["listUsers"]>[0]) {
  return defaultService.listUsers(options);
}

/**
 * List streams using the default Effect service.
 */
export function listStreams(options?: Parameters<P4Service["listStreams"]>[0]) {
  return defaultService.listStreams(options);
}

/**
 * Annotate a file's lines using the default Effect service.
 */
export function annotateFile(options: Parameters<P4Service["annotateFile"]>[0]) {
  return defaultService.annotateFile(options);
}
