# Changelog

All notable changes to `p4client-ts` are documented here.

This project follows semantic versioning.

## Unreleased

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
