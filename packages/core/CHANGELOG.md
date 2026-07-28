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
