# p4-ts

Typed TypeScript helpers for the Perforce `p4` CLI.

The published package name is `p4client-ts`.

- Run `p4` with a testable client abstraction
- Parse classic tagged output and newline-delimited JSON
- Query current Perforce environment with sensible fallbacks
- List and filter workspaces that are relevant to the local machine
- Provide preview-first Perforce helpers with opt-in mutating sync support
- Optional [Effect](https://effect.website)-based service API

## Scope

This package is intended for inspection, preview-oriented workflows, and explicit `sync()` operations.

In scope:
- Inspect current environment and workspace state
- List relevant workspaces for the current machine
- Inspect pending changelists and opened files
- Preview reconcile operations
- Preview sync operations and apply sync when explicitly requested
- Read file metadata and depot/local path mappings

Out of scope:
- `submit`
- `shelve` or `unshelve`
- `edit`, `add`, `delete`, or other checkout/open-for-edit commands
- `revert`, `lock`, `unlock`, `move`, `integrate`, or `resolve`
- Changelist creation or mutation
- Client or stream spec mutation
- Server administration or other server-mutating workflows

## Install

```bash
npm install p4client-ts
```

## Quick Start

```ts
import { P4Client } from "p4client-ts";

const p4 = new P4Client();

const environment = await p4.getEnvironment();
const workspaces = await p4.listWorkspaces();
const pending = await p4.listPendingChangelists();
const opened = await p4.getOpenedFiles({ change: "default" });
const reconcilePreview = await p4.previewReconcile({
  fileSpec: "C:/work/project/..."
});
const syncPreview = await p4.previewSync({
  fileSpec: "//Project/main/..."
});

if (syncPreview.totalCount > 0) {
  const syncResult = await p4.sync({
    fileSpec: "//Project/main/..."
  });
}

const reconcileOperation = p4.watchPreviewReconcile({
  fileSpec: "C:/work/project/..."
});

for await (const event of reconcileOperation.events) {
  if (event.type === "progress") {
    console.log(event.rawLine);
  }
}

const reconcileWithProgress = await reconcileOperation.result;
```

## Documentation

This repository includes a Starlight docs app in `../www` with authored guides and generated API docs powered by TypeDoc.

Run the docs site locally from the repo root:

```bash
bun run docs:dev
```

Build the static docs site:

```bash
bun run docs:build
```

## Reconcile Progress

`previewReconcile()` remains the simple buffered API. Use
`watchPreviewReconcile()` when you need incremental progress while still
awaiting the final structured reconcile result.

Progress output is best-effort:

- Perforce progress lines are version-dependent and not treated as a stable schema.
- The final structured reconcile preview remains the source of truth.
- When `-I` progress is unsupported, the watcher retries once without `-I` and emits a `progress-unavailable` event.
- When Perforce completes without any progress lines, the watcher emits `progress-unavailable` with reason `not-emitted`.

## Effect Service API

For [Effect](https://effect.website)-based codebases, `createP4Service` returns the same operations as `P4Client` wrapped in `Effect`:

```ts
import { Effect, Stream } from "effect";
import { createP4Service } from "p4client-ts";

const p4 = createP4Service();

const environment = await Effect.runPromise(p4.getP4Environment());
const workspaces = await Effect.runPromise(p4.listP4Workspaces());
const opened = await Effect.runPromise(p4.getOpenedFiles({ change: "default" }));
const reconcilePreview = await Effect.runPromise(p4.previewReconcile());
const reconcileEvents = await Effect.runPromise(
  p4.streamPreviewReconcile().pipe(Stream.runCollect)
);
const syncPreview = await Effect.runPromise(p4.previewSync({ fileSpec: "//Project/main/..." }));

if (syncPreview.totalCount > 0) {
  await Effect.runPromise(p4.sync({ fileSpec: "//Project/main/..." }));
}
```

## Development

```bash
bun install
bun run typecheck
bun run test
bun run test:e2e
bun run build
bun run docs:build
```

## End-to-End Tests

The e2e suite targets a pre-provisioned Perforce fixture workspace seeded from `@p4-ts/test-stream`.

- The suite is manual opt-in and skipped unless `P4_TS_E2E=1`.
- The harness validates the configured fixture target; it does not provision streams, clients, or submit seed content.
- Scenario setup may use local `p4 edit/add/delete`, numbered changelists, `sync`, and `revert`, with cleanup returning the workspace to baseline.

Required env vars:

```bash
P4_TS_E2E=1
P4_TS_E2E_WORKSPACE_ROOT=/absolute/path/to/workspace
P4_TS_E2E_CLIENT=p4ts_e2e_main
P4_TS_E2E_STREAM=//p4ts/main
```

Optional env vars:

```bash
P4_TS_E2E_USER=p4ts-e2e
P4_TS_E2E_HOST=build-host
P4_TS_E2E_P4PORT=ssl:perforce.example.com:1666
P4_TS_E2E_P4CONFIG=.p4config
P4_TS_E2E_ALLOW_OPENED_SCENARIOS=1
P4_TS_E2E_ALLOW_SYNC_PREVIEW=1
```

External prerequisite checklist:

1. Create a dedicated stream matching `packages/test-stream/stream-manifest.json`.
2. Create a dedicated client/workspace for that stream.
3. Seed and submit the contents of `packages/test-stream/seed` outside the test harness.
4. Optionally prepare a behind-head workspace state for sync-preview coverage.
