import { Effect } from "effect";
import { P4Client } from "./client.js";
import type { P4ClientOptions, P4Service } from "./types.js";

export function createP4Service(options: P4ClientOptions = {}): P4Service {
  const client = new P4Client(options);

  return {
    getP4Environment: (refresh = false) =>
      Effect.promise(() => client.getEnvironment({ refresh })),
    listP4Workspaces: (refresh = false) =>
      Effect.promise(() => client.listWorkspaces({ refresh }))
  };
}

const defaultService = createP4Service();

export function getP4Environment(refresh = false) {
  return defaultService.getP4Environment(refresh);
}

export function listP4Workspaces(refresh = false) {
  return defaultService.listP4Workspaces(refresh);
}
