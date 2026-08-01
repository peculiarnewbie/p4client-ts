# p4-ts

Typed TypeScript helpers for the Perforce `p4` CLI.

The published package name is `p4client-ts`.

- Run `p4` with a testable client abstraction
- Parse classic tagged output and newline-delimited JSON
- Query current Perforce environment with sensible fallbacks
- Resolve local Perforce settings from `p4 set`, P4V, and the Windows registry
- List and filter workspaces that are relevant to the local machine
- Provide preview-first Perforce helpers with opt-in mutating sync support
- Apply command timeouts across raw and higher-level APIs
- Optional [Effect](https://effect.website)-based service API

## Scope

This package is intended for inspection, preview-oriented workflows, explicit `sync()` operations, and local `P4CLIENT` switching.

In scope:
- Inspect current environment and workspace state
- List relevant workspaces for the current machine
- Inspect pending, submitted, and shelved changelists
- Inspect opened files
- Describe changelists and build lazy-load diff summaries, including shelved
  file rows via `p4 describe -S -s`
- Diff workspace files against depot revisions (`p4 diff`)
- Diff shelved files against their depot base without unshelving (`p4 diff2`
  with `@=<change>`)
- Print depot file content at a revision (`p4 print`)
- List exact depot revisions at a submitted changelist and materialize a
  bounded set outside the workspace (`p4 files` plus `p4 print -o`)
- Preview reconcile operations
- Preview sync operations and apply sync when explicitly requested
- Read file metadata and depot/local path mappings

Out of scope:
- `submit`
- `shelve` or `unshelve` mutations
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
const localEnvironment = await p4.getEnvironment({ mode: "local" });
const workspaces = await p4.listWorkspaces();
const pending = await p4.listPendingChangelists();
const shelved = await p4.listShelvedChangelists({
  fileSpec: "//Project/main/..."
});
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

## Changelist Diff Inspection

Use `describeChangelist()` for changelist metadata and file rows, then load
patches on demand with `diffFile()`:

```ts
const description = await p4.describeChangelist(12345);
const file = description.files[0];

if (file && !isBinaryP4Type(file.type)) {
  const summary = await p4.getChangelistDiffSummary(12345);
  const fileSummary = summary.files.find((entry) => entry.depotFile === file.depotFile);

  const diff = await p4.diffFile({
    depotFile: file.depotFile,
    localFile: fileSummary?.localFile ?? undefined,
    action: file.action,
    revision: file.revision,
    changelistStatus: description.status,
    type: file.type,
    allowBinary: false
  });

  console.log(diff.source, diff.unifiedDiff);
}

const depotContent = await p4.printFile("//Project/main/foo.txt", {
  revision: "have"
});
```

`diffFile()` is the single entrypoint:

- Pending changelists compare the workspace against depot `#have` via `p4 diff`.
- Submitted changelists compare two depot revisions via `p4 diff2`, inferred
  from `action`/`revision` or supplied through `fromRevision`/`toRevision`.
- Shelved changelists compare depot base revisions against shelf revisions via
  `p4 diff2`. Describe the shelf first, then pass `changelistStatus: "shelved"`
  and `shelvedChange`.

```ts
const shelvedDescription = await p4.describeChangelist(12345, { shelved: true });
const shelvedFile = shelvedDescription.files[0];

if (shelvedFile && !isBinaryP4Type(shelvedFile.type)) {
  const diff = await p4.diffFile({
    depotFile: shelvedFile.depotFile,
    action: shelvedFile.action,
    revision: shelvedFile.revision,
    changelistStatus: "shelved",
    shelvedChange: 12345,
    type: shelvedFile.type,
    allowBinary: false
  });

  console.log(diff.source, diff.unifiedDiff);
}
```

`p4 diff` and `p4 diff2` exit with code `1` when differences exist. `diffFile()`
treats exit codes `0` and `1` as success and only throws for exit code `2` or
higher. Use a higher `timeoutMs` for diff operations on large files.

## Historical Depot Materialization

Use `listDepotFilesAtChange()` to resolve the files that existed under a depot
path at a submitted changelist. The required `maxFiles` bound also reports
`hasMore` when the result is truncated:

```ts
const snapshot = await p4.listDepotFilesAtChange({
  depotPath: "//Project/main/Content/...",
  change: 12345,
  maxFiles: 100
});
```

Materialize a selected, bounded set into an existing temporary directory:

```ts
const materialized = await p4.materializeDepotFiles({
  files: snapshot.items.filter((file) => file.type.startsWith("binary")),
  directory: temporaryDirectory,
  maxFiles: 25,
  concurrency: 4
});
```

Files are written beneath `<directory>/<depot>/<path>` using their exact
numeric revisions. `materializeDepotFiles()` uses `p4 print -q -K -o`, so
binary payloads bypass the text-based command result and `printFile()` remains
compatible. It does not run `p4 sync` or modify the active workspace.

## Local Settings Resolution

`resolveP4Settings()` resolves `P4PORT`, `P4USER`, and `P4CLIENT` from local
sources without contacting the server:

```ts
import {
  resolveP4Settings,
  resolveP4SettingsWithDetails
} from "p4client-ts";

const settings = await resolveP4Settings(
  { P4CLIENT: "Project_Main" },
  {
    sources: ["p4v-app-settings", "p4v-connection-map", "cli", "registry"]
  }
);

const detailed = await resolveP4SettingsWithDetails({}, {
  sources: ["cli", "registry"]
});
```

`getEnvironment({ mode: "local" })` uses the same resolver and skips `p4 info`.

## Timeouts

Set `timeoutMs` on `P4Client` to apply a process timeout to raw commands and
higher-level helpers:

```ts
import { P4Client, P4TimeoutError } from "p4client-ts";

const p4 = new P4Client({ timeoutMs: 1500 });

try {
  await p4.previewSync({ fileSpec: "//Project/main/..." });
} catch (error) {
  if (error instanceof P4TimeoutError) {
    console.error(error.timeoutMs);
  }
}
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

`bun run test:e2e` is the canonical E2E command. It downloads or reuses hash-verified Perforce `p4`/`p4d` binaries, creates a disposable localhost server, stream, client, and workspace from `@p4-ts/test-stream`, runs all scenarios, and cleans up the temporary fixture. The first run requires network access. Binaries are cached outside the repository.
