# Migrating to p4client-ts 0.13

0.13 rebuilds p4client-ts on an Effect core. This file records deliberate behaviour changes as
they land; the full old-to-new method map is completed at cutover.

## Every operation

- Each operation takes one options object. Positional arguments such as `describeChangelist(change)`
  are now options (`{ change }`).
- Results are plain enumerable objects. Lists are `{ items, messages }`, so `messages` survives
  `structuredClone` and Electron IPC.
- Every operation can be watched: it reports items, messages, per-item failures and progress while
  it runs, then its result. Progress has `completed`, `total` (or `null` when unknown), `unit`,
  optional byte counts and `elapsedMs`.
- Timestamps are ISO 8601 strings. The raw Unix-seconds fields (`createdAt` as seconds,
  `accessedAt` as seconds) are gone; `createdAt` now holds the ISO string.

## Environment

- `getEnvironment` runs `p4 info -s` and reports what the server resolved: `user`, `client`
  (`null` when unknown), `clientHost`, `serverAddress`, `serverVersion`, `unicode` and
  `caseInsensitive`. `port` is the configured `P4PORT`.
- Removed: the `local` mode, `resolveSettings` and the per-client cache. Use `resolveConnection`
  from `p4client-ts/node` to read local settings.

## Workspaces

- `setClient` and `switchWorkspace` are removed; they wrote `P4CLIENT` to the global registry.
  Pass `connection.client` in the client options, or use `withOptions` for part of a program.
- `listWorkspaces` no longer looks up the current user: without `user` it lists every workspace.
  `host` keeps workspaces restricted to that host plus hostless ones. Checking that a hostless
  workspace's root exists on disk moves to `p4client-ts/node`.
- `isCurrentClient` is removed; compare `client` with your configured workspace.
- New: `stream` filter (`clients -S`).

## Changelists

- `listPendingChangelists`, `listSubmittedChangelists`, `listShelvedChangelists` and
  `listChangelists` are one operation, `listChangelists({ status })`, returning
  `{ items, messages, hasMore, nextCursor }` for every status.
- Pending changelists now read full descriptions (`changes -l`), like submitted and shelved ones.
- `beforeChange`/`nextBeforeChange` are renamed `cursor`/`nextCursor`.
- Shelved changelists report `status: 'shelved'`.
- Pending changelists page like the others (default limit 50); the default changelist is
  synthesized only on the first page.

## Opened files

- `getOpenedFiles` and `getChangelistFiles` are `listOpenedFiles`.
- `changelist`/`changelistDescription`/`isDefaultChangelist` are `change`/`changeDescription`;
  compare `change === 'default'`.
- `localFile` is removed: it was guessed from the working directory, which is wrong unless that is
  the workspace root. Map client paths with `where`.
- New: `haveRevision`, `movedFile` (the other half of a move), `locked`, and `allClients` (`-a`).

## Describe

- `describeChangelist({ change, shelved })`. `status` is `shelved` when shelved files of a pending
  changelist are requested; `contentSource` is removed.
- A changelist that does not exist fails with `P4CommandError` reason `unknown_changelist`,
  even though `p4` exits zero.
- Files carry `digest` and `fileSize` when Perforce reports them.

## Per-item failures

- Batch operations (`listFiles`, `statFiles`, `whereFiles`, `listHaveFiles`, `listUsers`, `printBatch`,
  `sync`, `previewSync`, `runTagged`) return `failures: { spec, reason, message }[]`, always present.
  `spec` is what the message is about, read from its arguments rather than its text, or `null`.
- Watching reports each failure as a `failure` event carrying the message.
- Every message carries `disposition`: `fail`, `item`, `empty` or `notice`, saying what the
  operation did with it under its policy.

## Files and depots

- `maxResults`/`maxFiles` are `limit` everywhere; `changelist` fields on file rows are `change`.
- `listDepotFiles` with `deletedFiles: 'exclude'` (the default) filters on the server (`files -e`),
  so `-m limit+1` paging is exact.
- `statFiles`: `headTime` is ISO 8601 (`headTimeIso` removed), `openChangelist` is `openChange`;
  new `openType` and `isUnresolved`.
- `whereFiles` no longer throws for a spec outside the view: it is a failure, although `p4` exits 1.
- New: `listFiles` (general multi-spec `files`, replacing `runTaggedJson(['files', …])`) and
  `listHaveFiles`. `P4Depot` gains `createdAt`; depot files gain `submittedAt`.

## History and annotate

- `getFileHistory({ file, limit, followBranches })`: the result is `{ depotFile, items, messages,
  hasMore }`. Revisions use `submittedAt` (ISO) and carry `integrations[]` (`how`, `file`,
  `startRevision`, `endRevision`). `hasMore` comes from `-m limit+1` per path. With no match,
  `depotFile` is `null`.
- New `followMoves(history)` follows a file back across renames.
- `annotateFile({ file, revision, followIntegrations })`: line `data` is `text`; each line's
  `change` is now the change that introduced it (`lower`), not the last change it survived (`upper`).

## Users and streams

- `listUsers({ users, limit })`: `accessedAt` is ISO; a requested user that does not exist is a failure.
- `listStreams({ fileSpec, limit })` adds `options`, `accessedAt`, `updatedAt`. New `getStream`.

## Print and diff

- `printFile({ file, revision, keywords })` uses `-G` and returns `content` as bytes for every file
  type; decode with `printedText()`. It prints the head revision by default (was `#have`). A
  missing file or revision fails.
- `keywords: 'raw' | 'expand'` (default `raw`) applies to every print. Raw prints pass `-k`, which
  every server accepts; 2022.1 renamed it `-K` and kept `-k` as an alias.
- New `printBatch` prints many files in one `p4 -x -` process, streaming each file. Pass
  `keepContent: false` when watching a large batch: content then reaches only the events, and the
  result lists the files in `printed`.
- `diffFile`: `diffFlags` is `string[]`; `exitCode` is removed. Workspace diffs come from `-Mj diff`,
  so `unifiedDiff` holds the hunks without `---`/`+++` header lines.
- `getChangelistDiffSummary({ change, … })`: `patchLoadState` removed, `revision` added; the default
  changelist runs one `opened -c default`.
- `materializeDepotFiles` moves to `p4client-ts/node`; `totalCount` is removed.

## Sync and reconcile

- `sync` requires `allowMutation: true` and otherwise fails with `P4ReadOnlyError`.
- `errors` is `failures`, always present. Clobbered files, OS errors and specs outside the view are
  failures, not thrown errors, and a non-zero exit they explain is accepted.
- `totalCount` is replaced by Perforce's announced `totalFileCount`/`totalFileSize`, which also
  drive determinate progress.
- `watchSync` is `watch(sync)`: `item`/`failure`/`message`/`progress`/`done` events.
- `previewReconcile`: `changelist` is `change`; `workspace` needs only `{ root }`; `localFile` is
  removed (`clientFile` is the local path); `move/add`/`move/delete` group into added/deleted.
  The `-I` progress request, `progress-unavailable` and the retry are removed: reconcile emits no
  progress through a pipe, so it streams candidates with a running count.
- `runTaggedJson(args, opts)` is `runTagged({ args, schema, policy })`; `allowNonZeroExit` is
  replaced by `policy`, and mutating commands pass through the read-only guard. For records typed
  by a schema, run `taggedOperation(schema)` instead.
