# Changelog

All notable changes to `p4client-ts` are documented here.

This project follows semantic versioning.

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

