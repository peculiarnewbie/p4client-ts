import { Effect } from "effect";
import { P4Client } from "./client.js";
import type { P4ClientOptions, P4Service } from "./types.js";

/**
 * Create an Effect-friendly wrapper around {@link P4Client}.
 *
 * The returned service exposes the same read-only and preview-oriented
 * operations as `P4Client`, but each operation resolves to an `Effect`.
 */
export function createP4Service(options: P4ClientOptions = {}): P4Service {
  const client = new P4Client(options);

  return {
    getP4Environment: (refresh = false) =>
      Effect.promise(() => client.getEnvironment({ refresh })),
    listP4Workspaces: (refresh = false) =>
      Effect.promise(() => client.listWorkspaces({ refresh })),
    listPendingChangelists: (serviceOptions) =>
      Effect.promise(() => client.listPendingChangelists(serviceOptions)),
    getOpenedFiles: (serviceOptions) =>
      Effect.promise(() => client.getOpenedFiles(serviceOptions)),
    getChangelistFiles: (change, serviceOptions) =>
      Effect.promise(() => client.getChangelistFiles(change, serviceOptions)),
    previewReconcile: (serviceOptions) =>
      Effect.promise(() => client.previewReconcile(serviceOptions)),
    previewSync: (serviceOptions) =>
      Effect.promise(() => client.previewSync(serviceOptions))
  };
}

const defaultService = createP4Service();

/**
 * Read common Perforce environment values using the default Effect service.
 */
export function getP4Environment(refresh = false) {
  return defaultService.getP4Environment(refresh);
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
 * Preview sync results using the default Effect service.
 */
export function previewSync(options?: Parameters<P4Service["previewSync"]>[0]) {
  return defaultService.previewSync(options);
}
