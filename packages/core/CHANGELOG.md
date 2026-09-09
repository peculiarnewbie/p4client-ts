# Changelog

All notable changes to `p4client-ts` are documented here.

This project follows semantic versioning.

## Unreleased

### Breaking changes

- Typed `parseP4JsonLines` and `runTaggedJson` calls now require an Effect schema;
  the output type is inferred from that decoder. Calls without a schema return
  `Record<string, unknown>[]`. Replace generic-only calls with
  `parseP4JsonLines(output, MySchema)` or `runTaggedJson(args, { schema: MySchema })`.
- Command rows are validated before constructing typed results. Malformed required
  fields and supplied numeric metadata now raise `P4ParseError` instead of being
  silently dropped, truncated, or replaced with null. Additional server tags and
  missing optional metadata remain supported.
- Opened/reconcile/sync `clientFile` fields now include `P4LocalPath` in their
  union, matching CLI output instead of branding local filenames as client paths.
- Changelist normalization rejects fractional, negative, and unsafe integer IDs.
  Integer option guards also reject numbers outside JavaScript's safe range.

### Added

- Shared `P4OperationOptions.signal` support across high-level client operations,
  including nested commands, local settings readers, and concurrent file work.
- Exported Effect schemas for depot/client/local paths, file actions, integer IDs,
  changelists, and workspace rows. Branded path and workspace types derive from
  these schemas.
- Compile-time API contract tests run as part of `bun run typecheck`.

### Fixed

- Effect interruption and early stream exits now cancel and join their owned
  operations without aborting caller signals or unrelated invocations.
- Returning from watched event iteration cancels unfinished work. Abort, timeout,
  and I/O failures wait for the direct child process to close before rejecting.
- Cancelled settings lookups stop fallback resolution and do not cache success.
- Command launch and I/O failures now reach both watched events and the result,
  including synchronous spawn failures and closed stdin. Consuming events before
  awaiting the result no longer leaves a rejected result unobserved.
- Event queues preserve null/undefined failures and release pending values and
  consumers when iteration ends early.
- Timeouts above the runtime timer limit are rejected before launching a process.
- Concurrent materialization and diff work stops scheduling queued operations on
  failure and waits for active operations to settle before rejecting.
- Submitted deletion diffs use the preceding content revision. Submitted branch
  and move actions now have inferred diff endpoints.
- Unified diff counts include changed lines beginning with `++` or `--` without
  confusing them with file headers. Invalid or out-of-range timestamps return null.

### Changed

- The command adapter uses Effect with typed failures while preserving the existing
  Promise API and native process errors. Child console windows are hidden on Windows.
- Buffered commands skip line-event allocation and queue draining.
- Changelist diff summaries index described files once instead of rescanning the
  file list for each diff.

## 0.9.0 - 2026-08-04

### Fixed

- Fixed `getFileHistory({ followBranches: true })` discarding every depot path
  but the first. `p4 filelog` reports one row per path, so following
  integrations returned exactly what not following them returned, making the
  option inert. Revisions from all paths are now merged into one list.
- Fixed `getFileHistory()` dropping paths in two cases that do not involve
  `followBranches` at all, which is why the merge is unconditional: a wildcard
  spec such as `//depot/main/...` returned a single arbitrary matched file, and a
  renamed file lost its pre-rename history because `p4 filelog` reports rename
  ancestry as extra rows even without `-i`. `P4FileHistory.depotFile` is no
  longer whichever path happened to come first in those cases.

### Changed

- `P4FileHistory.revisions` is ordered by changelist descending, falling back to
  submit time when neither side reports a changelist. Revision number is no
  longer the ordering key, because it restarts at 1 on each depot path and would
  interleave unrelated paths. A revision of a given path is reported once even
  when a wide integration graph repeats it.
- `GetFileHistoryOptions.maxRevisions` now bounds the merged total. `p4 filelog
  -m` applies its bound to each path separately, so the option silently
  over-delivered whenever `followBranches` was set — measured as 65 revisions
  returned for `-m 51 -i` across a two-path chain.
- `P4FileHistory.depotFile` remains the requested head path; following
  integrations never repoints it at an ancestor.

### Added

- Added `P4FileRevision.depotFile`, the path a revision belongs to, so callers
  can label cross-path ancestry and disambiguate revision numbers repeated
  across a merged history. This field is additive for readers, but is required
  and therefore a breaking change for code that constructs `P4FileRevision`
  values, such as test fixtures and mocks.

## 0.8.0 - 2026-07-31

### Added

- Added bounded `listDepotFilesAtChange()` snapshot listing with exact revision,
  changelist, action, and file-type metadata.
- Added binary-safe `materializeDepotFiles()` downloads through
  `p4 print -q -K -o`, without syncing or routing payloads through text stdout.
- Added matching Effect service operations and typed materialization failures.
- Added depot-tree browsing primitives for lazy exploration: `listDepots()`
  (`p4 depots`), `listDepotDirs()` (`p4 dirs`, single level), and
  `listDepotFiles()` (`p4 files`, single level at head). Empty or non-existent
  directories resolve to empty listings instead of throwing.
- Added `listDepotFiles({ deletedFiles: "exclude" | "include" | "only" })` with
  exact `hasMore`/completeness when filtering: because `p4 files -m` counts
  head-deleted revisions, the filtering modes list the level and bound
  client-side rather than mixing a server bound with client-side filtering.
- Added `statFiles()` batching wrapper over `p4 fstat` returning rich per-file
  metadata — head/have revisions, type, size/digest (opt-in via
  `includeFileSize`), computed `isOutOfDate`, and concurrent-open/lock state —
  with `-T` field selection and `-m` bounds.
- Added `signal` (`AbortSignal`) to `P4CommandOptions` and the new browse/stat
  options so interactive callers can cancel in-flight commands.
- Added `whereFiles()` (`p4 where`) mapping specs across depot, client, and
  local syntax, flagging exclusionary view rows for "reveal in workspace" and
  "open in editor" actions.
- Added `getFileHistory()` (`p4 filelog -l`) returning newest-first revision
  history with change, action, type, time, author, description, digest, and
  size, plus `followBranches` to trace integrations and renames.
- Added `listUsers()` (`p4 users`) resolving user identifiers to full names and
  emails for changelist and revision attribution.
- Added `listStreams()` (`p4 streams`) returning each stream's `parent` so
  callers can assemble the stream-depot hierarchy without extra queries.
- Added `annotateFile()` (`p4 annotate -q -c`) for line-by-line blame, tagging
  each line with the last modifying changelist, with `followIntegrations` to
  attribute lines to their integration source.
- Added Effect service wrappers and exports for depot browsing, `statFiles()`,
  `whereFiles()`, `getFileHistory()`, `listUsers()`, `listStreams()`, and
  `annotateFile()`.

### Fixed

- Classified Perforce `archive` head actions consistently with delete and purge
  actions when filtering depot listings and computing `isDeletedAtHead`.

## 0.7.0 - 2026-06-15

### Added

- Added `listShelvedChangelists()` and `listChangelists({ status: "shelved" })`
  for paged shelved changelist listing.
- Added `describeChangelist(change, { shelved: true })` for inspection-only
  shelved file rows via `p4 describe -S -s`.
- Added `diffFile()` support for shelved depot-vs-shelf diffs using
  `changelistStatus: "shelved"` and `shelvedChange`.
- Added shelved changelist diff summaries that avoid reviewer workspace opened
  file lookups and can populate line counts through depot-side shelf diffs.
- Added Effect service wrappers and exports for shelved changelist listing.

### Improved

- Improved Effect service error handling by using `Effect.tryPromise()` and a
  tagged `P4ServiceError` union instead of treating rejecting client calls as
  infallible promises.
- Improved tagged JSON parsing with Effect Schema validation and a typed
  `P4ParseError` for malformed Perforce output.
- Improved public result types with branded parsed path/action aliases:
  `P4DepotPath`, `P4ClientPath`, `P4LocalPath`, and `P4FileAction`.
- Clarified mutation scope in docs: `sync()` mutates workspace contents, while
  `setClient()` and `switchWorkspace()` update the local `P4CLIENT` setting.

### Notes

- Shelved changelist inspection is in scope. `shelve`, `unshelve`, and other
  shelf-mutating operations remain out of scope.

## 0.6.0 - 2026-06-15

### Added

- Added `listSubmittedChangelists()` for paged submitted changelist listing with
  stream/depot `fileSpec`, client, user, limit, and `beforeChange` filters.
- Added unified `listChangelists({ status })` for pending and submitted
  changelist views.
- Added `watchSync()` for streaming sync progress with structured per-file
  error rows.
- Added parsed sync error rows to `sync()` results when Perforce emits tagged
  error records.
- Added `setClient()` and `switchWorkspace()` helpers for changing `P4CLIENT`
  while invalidating cached client-derived state.
- Added `workspaceStreamFileSpec()`, `requireWorkspaceStreamFileSpec()`, and
  `workspaceRootFileSpec()` helpers for stream and local-root Perforce file
  specs.
- Added `workspace` sugar to `previewReconcile()` for deriving a local-root
  reconcile file spec when `fileSpec` is omitted.
- Added Effect service wrappers for submitted changelists, unified changelist
  listing, sync streaming, and client switching.

### Notes

- For team submitted-changelist views, prefer a stream/depot `fileSpec` such as
  `//Project/main/...` over `client`, because `client` scopes results to one
  workspace.
- For reconcile workflows, use `workspaceRootFileSpec(workspace)` or the
  `previewReconcile({ workspace })` convenience. Reconcile operates on the
  local workspace tree, not the stream path.
