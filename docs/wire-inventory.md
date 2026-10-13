# Perforce wire inventory

Inventory begun at `0cea5a1`, reviewed on 2026-10-13 and updated for the validation
changes on this branch. The core package is
`packages/core`. Consumer
files were inspected without modification. Connection identities and captures
from a configured server must never be included in this document.

## Output modes and execution

`P4Client.runTaggedJson` prefixes `-Mj -z tag` unless
`prefixTaggedJsonFlags: false`. The browse methods construct that prefix directly.
`-z tag` and `-ztag` request the same tagged representation; `-Mj` serializes
records as newline-delimited JSON. The library does not issue `-G` (Python marshal).
The validation recorder compares tagged text, tagged JSON and marshal on the
disposable server. Plain output is used for environment/settings, print payloads
and diffs. The constructor's `client` prefixes **every** library command with
global `-c <client>`; this differs from command-local `changes -c`, `opened -C`
and `opened -c` (changelist).

`internal/command.ts` captures UTF-8 stdout/stderr, exit status, watched lines,
timeout and cancellation. It does not parse Perforce records. `settings.ts` also
reads files and runs Windows `reg query`; those are not server commands. Raw
`run`/`watch` and custom tagged arguments allow arbitrary caller-specified commands
and therefore have no finite command inventory or data schema. The production
guard has its own stricter command/flag policy.

## Complete built-in command inventory

Optional arguments are in brackets. `specs` can be one or several filespecs;
`@change`, `#revision`, `#have`, `#none` and `@=shelf` are appended as applicable.
Row schemas are in `internal/rows.ts` unless another location is given.

| API / internal workflow | Command and flags after global options | Mode | Parser / schema |
| --- | --- | --- | --- |
| `getEnvironment` | `info` | plain | `parseP4KeyValueOutput`; no row schema |
| local environment/settings fallback | `set -q` | plain | `parseP4SetOutput`; no row schema |
| `listWorkspaces` | `clients -u user` | tagged JSON | `P4JsonWorkspaceSchema` in `public/schemas.ts` |
| `setClient` / `switchWorkspace` | `set P4CLIENT=name` | plain | exit only; **changes local settings**, disposable testing only |
| `listPendingChangelists` | `changes -s pending [-m limit] [-u user] [-c client] [specs]` | tagged JSON | `ChangelistRow` |
| `listSubmittedChangelists` | `changes -s submitted -l [-u user] [-c client] -m (limit+1) [specs[@beforeChange]]` | tagged JSON | `ChangelistRow`; pagination; each spec receives its own cursor |
| `listShelvedChangelists` | `changes -s shelved -l [-u user] [-c client] -m (limit+1) [specs[@beforeChange]]` | tagged JSON | `ChangelistRow`; same cursor handling |
| `listChangelists` | dispatches to the three preceding commands | tagged JSON | same schemas |
| default changelist synthesis / `getChangelistFiles` | `opened [-u user] [-C client] [-c change/default] [specs]` | tagged JSON | `OpenedRow` |
| `getOpenedFiles` | same `opened` variants | tagged JSON | `OpenedRow` |
| `describeChangelist` (numbered) | `describe -s change` or `describe -S -s change` | tagged JSON | `ChangelistRow`; `depotFileN/actionN/typeN/revN` unpacked into `DescribedFileRow` |
| `describeChangelist` (default) | `opened -c default [-C client]` | tagged JSON | `OpenedRow`; synthesized metadata |
| workspace `diffFile` | `diff -du spec` by default; caller can replace `diffFlags` | plain | unified hunks/counts; no row schema |
| depot/submitted/shelved `diffFile` | `diff2 -du left right` by default; caller can replace `diffFlags` | plain | same; endpoints from `resolveDiffPlan` |
| `getChangelistDiffSummary` | describe, optional opened, optional diff/diff2 per text file | mixed as above | same schemas; bounded Effect traversal |
| `printFile` metadata | `files file#revision` (default `#have`) | tagged JSON | `FileRow`; binary detection |
| `printFile` content | `print -q file#revision` for text files | plain | stdout content; no payload schema |
| `listDepotFilesAtChange` | `files -e -m (maxFiles+1) path@change` | tagged JSON | `FileRevisionRow` |
| `listDepots` | `depots` | tagged JSON | `DepotRow` |
| `listDepotDirs` | `dirs path/*[@change]` | tagged JSON | `DirRow`; client-side result bound |
| `listDepotFiles` | `files [-m (maxResults+1)] path/*[@change]`; `-m` only for `deletedFiles: include` | tagged JSON | `FileRow`; deleted head filtering |
| `statFiles` | `fstat [-m maxResults] [-Ol] [-T "depotFile field field"] specs[@change]` | tagged JSON | `StatRow`; `depotFile` always retained with selected fields; `otherOpenN/otherLockN/isMapped` presence fields |
| `whereFiles` | `where specs` | tagged JSON | `WhereRow`; `unmap` or `-` marks exclusions |
| `getFileHistory` | `filelog -l [-i] [-m maxRevisions] spec` | tagged JSON | path and indexed `HistoryRevisionRow`; integrations use two-dimensional tags |
| `listUsers` | `users [-m maxResults] [users...]` | tagged JSON | `UserRow` |
| `listStreams` | `streams [-m maxResults] [specs]` | tagged JSON | `StreamRow` |
| `annotateFile` | `annotate -q -c [-I] file[#revision or @change]` | tagged JSON | `AnnotationHeaderRow`, `AnnotationRow`; `data` here is **file content** when `upper` is present |
| `materializeDepotFiles` | `print -q -K -o destination file#revision` | plain, file payload on disk | exit only; destination/path validation |
| `previewReconcile` | `reconcile -n [-c change] [-m] [-w] [specs]` | tagged JSON | `OpenedRow` and action grouping; `-m` here means modtime, not a row limit |
| `watchPreviewReconcile` | global `-I`, then preceding reconcile flags; fallback without `-I` | tagged JSON plus possible plain progress | JSON rows and `parseP4ProgressLine`; same result mapper |
| `previewSync` | `sync -n [-f] [-k] [specs]` | tagged JSON | `SyncRow`, message/error mapping |
| `sync` / `watchSync` | `sync [-f] [-k] [specs]` | tagged JSON | `SyncRow`, per-file errors; **writes**, disposable testing only |

`PreviewSyncOptions.maxFiles` is currently reserved and does not bound the server
query. Narrow filespecs are necessary for validation. `fstat -Ol` can calculate
digests and must not be run against the production server during this audit.

There are no `getProperty`, `getProperties` or `setProperty` methods in this
checkout's library, nor Perforce property calls in the inspected consumer source.
Do not invent schemas or claim coverage for absent APIs. A disposable
`property -l` capture is included as a raw-command shape comparison.

## Electroswag call sites

Source searches covered all of `electroswag/src` for `p4client-ts`, `P4Client` and
the requested method names; the Perforce implementations are concentrated in
`src/main/services/p4/`:

| Consumer file | Library use |
| --- | --- |
| `connection.ts` | Constructs workspace/server clients with explicit connection settings and global client selection; resolves environment/local settings, lists workspaces, retries connection fallback |
| `index.ts` | Pending changelists/opened files, sync preview and watched sync for Get latest, reconcile preview, describe and diff summary, file diff, print, submitted/shelved pagination |
| `topology.ts` | Depots, streams, environment, workspaces for project discovery |
| `inspection.ts` | Depot directories/files and streams, with explorer result bounds |
| `association.ts` | `whereFiles` and `statFiles` for local asset associations |
| `history.ts` | `getFileHistory` including integration/rename ancestry and bounds |
| `review.ts` | Server-side `diffFile` and `getChangelistDiffSummary` |
| `src/main/services/mb-map/workspace-provenance.ts` | Reuses configured `P4Client` for workspace provenance |

The handoff's `patches/p4client-ts@0.11.0.patch` does not exist in the inspected
consumer working tree or nearby Perforce/adoption/publish worktrees. It was found
and read in consumer Git history at `3bea6ca8`. The patch recognizes a row with
`data` and `level` in 0..2 when `severity` and file fields are absent. The reported
shape is reproduced on the disposable server and upstreamed with an independently
recorded regression fixture.
