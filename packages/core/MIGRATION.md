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
