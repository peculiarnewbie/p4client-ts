# Migrating 0.12 → 0.13

0.13 replaces the cached `P4Client` with a stateless Effect core and an immutable
Promise facade. Install `effect@4.0.0-beta.37` alongside `p4client-ts`.

```ts
import { createP4Client } from 'p4client-ts/promise';

const client = createP4Client({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws', isolated: true },
  cwd: '/work/project',
});
try {
  const opened = await client.listOpenedFiles({});
  console.log(opened.items, opened.messages);
} finally {
  await client.dispose();
}
```

## Entry points and lifecycle

| Old | New |
| --- | --- |
| `new P4Client(options)` from root | `createP4Client(options)` from `/promise` |
| `createP4Service`, manually duplicated service interface | `P4`, registry-derived `P4Service`, `layerNode(options)` from `/node` |
| `executor`, `streamExecutor` callbacks | `P4Executor` layer; `createP4ClientFromLayer(layer, derive, options)` for Promise tests |
| top-level `port`, `user`, `client`, `charset` | `connection: { port, user, client, charset }` |
| `setClient`, `switchWorkspace` | `client.with({ connection: { client } })`; no global registry writes |
| caches, `refresh` | Removed; each call reads current state |
| per-call connection/timeout overrides | Derive a Promise client with `with`, or scope an Effect with `P4.with` |
| raw cancellation handles | `signal` on Promise options; Effect interruption on streams |

Dispose the original client and each derived client. A derived client owns an independent
runtime. Omitted patch fields inherit; explicit `undefined` clears cwd/timeout or individual
connection/environment entries, and resets executable to `p4`.

Every method now takes one options object, including `{}`. Mutation is disabled unless
`allowMutation: true` is set in configuration; it applies to sync and raw mutating commands.
Preview operations work with the default read-only configuration.

## Operation map

The table uses Promise method names. Neutral Effect service methods have the same names;
Node helper methods are exported separately from `/node`.

| 0.12 call | 0.13 call / result change |
| --- | --- |
| `getEnvironment()` | `getEnvironment({})`; `user`, `client`, `port`, `clientHost`; no local fallback; use `resolveConnection` separately |
| `listWorkspaces()` | `listWorkspaces({})`; `.items`; no `isCurrentClient`, compare the configured client |
| `listPendingChangelists(opts)` | `listChangelists({ ...opts, status: 'pending' })` |
| `listSubmittedChangelists(opts)` | `listChangelists({ ...opts, status: 'submitted' })` |
| `listShelvedChangelists(opts)` | `listChangelists({ ...opts, status: 'shelved' })` |
| `listChangelists(opts)` | One status per call; `cursor` replaces `beforeChange` |
| `getOpenedFiles(opts)` | `listOpenedFiles(opts)`; `.items`; `change` replaces `changelist`, use `clientFile` instead of `localFile` |
| `getChangelistFiles(change)` | `listOpenedFiles({ change })` |
| `describeChangelist(change, opts)` | `describeChangelist({ ...opts, change })` |
| `getChangelistDiffSummary(change, opts)` | `getChangelistDiffSummary({ ...opts, change })`; no `patchLoadState`, unloaded line counts are `null` |
| `diffFile({ depotFile, ...opts })` | `diffFile({ file: depotFile, ...opts })`; no process `exitCode` in the result |
| `printFile(depotFile, opts)` | `printFile({ ...opts, file: depotFile })`; head is the default, use `revision: 'have'` explicitly; bytes replace string content |
| `listDepots()` | `listDepots({})`; `.items` |
| `listDepotDirs(opts)`, `listDepotFiles(opts)` | Same methods; `limit` replaces command-specific maximum fields |
| `listDepotFilesAtChange({ depotPath, maxFiles, ...opts })` | `listDepotFilesAtChange({ file: depotPath, limit, ...opts })`; materialization retains `maxFiles` |
| `statFiles(opts)`, `whereFiles(opts)` | `.items`, `.messages`, `.failures`; see exclusions below |
| `getFileHistory({ depotFile, maxRevisions, ...opts })` | `getFileHistory({ file, limit, ...opts })`; `.items` replaces `.revisions`, adds `hasMore` and revision `integrations` |
| `listUsers(opts)`, `listStreams(opts)` | Same methods; `.items`; missing requested users are item failures |
| `annotateFile({ depotFile, ...opts })` | `annotateFile({ file, ...opts })`; lines expose `text` and `line` |
| `previewSync(opts)`, `sync(opts)` | `.items`, `.failures` always present; no `.errors` or `.totalCount`; transfer estimates are `totalFileCount` / `totalFileSize` (nullable) |
| `previewReconcile(opts)` | Same method; candidates retain added/edited/deleted groups; no `-I` fallback |
| `watchSync(opts)`, `watchPreviewReconcile(opts)` | `client.watch.sync(opts)`, `client.watch.previewReconcile(opts)`; every neutral op can be watched |
| `materializeDepotFiles({ files, ...opts })` | `materializeDepotFiles({ fileSpec: files, ...opts })`; `.items.length` replaces total count; Effect export is an operation run with `runOperation` / `watchOperation` |
| `runTaggedJson(args, opts)` | `runTagged({ ...opts, args, schema, policy })`; schema determines item type |
| `run(args)`, raw `watch(args)` | No plain raw facade; use guarded `runTagged` / `watch.runTagged`; custom process code can use `/node` executor |
| `resolveP4Settings*` | Promise `resolveConnection({ sources })`, or Node Effect `resolveConnection`; cwd comes from configuration; returns `{ connection, sources }` |

New methods include `listFiles`, `listHaveFiles`, `getStream`, `printBatch`,
`findWorkspaceForPath`, `workspaceRootExists`. `followMoves` is a pure history helper.
Workspace resolution accepts `{ path, altRoots: true }` and chooses the deepest
matching root, including AltRoots when requested, with Windows case folding and realpath resolution.

## File input names

All operations use `file` for one file spec and `fileSpec` for lists of specs.
Metadata, opened, changelist, stream, sync and reconcile filters retain `fileSpec`;
those accepting `FileSpecs` still allow a single string as shorthand for a list.

- `diffFile({ file })` and the pure `resolveDiffPlan({ file })` helper replace
  `depotFile`. Diff still requires a depot path.
- `listDepotFilesAtChange({ file, change, limit })` replaces `depotPath`. Like
  `getFileHistory({ file })`, it takes one spec that may contain wildcards.
- `printFile`, `annotateFile` and `getFileHistory` retain `file`; they also accept
  client/local syntax where supported by the CLI.
- `printBatch({ fileSpec: ['//depot/a#2', '//depot/b'] })` replaces `files`.
- `materializeDepotFiles({ fileSpec: [{ depotFile: '//depot/a', revision: 2 }],
  directory, maxFiles })` replaces `files`; the list still requires exact revisions.

Directory browsing (`listDepotDirs`, `listDepotFiles`) retains `depotPath` because
it selects a directory. Result records retain `depotFile` and `files`; mapping hints
such as diff's `localFile` are unchanged. No aliases for the renamed inputs remain.

## Envelopes, errors and messages

Messages are enumerable plain data, survive `structuredClone`, and carry `severity`
(`empty`, `info`, `warning`, `failed`, `fatal`), `reason`, `category`, decoded `code`, `template`,
named `args`, `text`, `reasonSource` and `disposition`. Classification prefers protocol
codes, then generic codes, then a text fallback. Reasons are more specific: an empty
reconcile is `nothing_to_reconcile`, an up-to-date sync is `up_to_date`, and denied
access is `permission_denied`.

`P4CommandError` is a tagged Error with `reason`, `category`, `messages`, redacted
`command`/`args`, and `exitCode` directly on the error; there is no old `result` property.
Other tags include spawn, timeout, parse, read-only, invalid-argument and materialization
errors. Use `encodeP4Error` / `decodeP4Error` for IPC; they encode only the explicit schema.

Item failures have `{ spec, reason, message }`; their messages live on the failure,
not in the result's notice-only `messages`. Connection/auth/permission failures fail
the whole operation. Mixed `files`, `fstat`, `where`, batch print and sync requests
preserve valid items alongside failures. Sync outside-view specs now become item
failures. `printFile` and materialize still fail for missing files or revisions.

## Watches

Events use `_tag`, replacing `type`: `item`, `message`, `failure`, `progress`, `done`.
A failure event carries the same `.failure` as the result; `done` carries `.result`.
Promise watches execute eagerly once, return `{ events, result }`, and have one event
consumer. Leaving iteration cancels; `result` settles even without a consumer.
The 10,000-event default buffer can be overridden with `maxBuffered`; overflow fails
iteration while the result continues. Effect watches are lazy Streams. Heartbeat
options are a second argument for Effect methods, part of the options object for Promise.

## Printing, history and mappings

`printFile` and `printBatch` use binary-safe Python marshal (`-G`). `content` is a
`Uint8Array`; `printedText(result)` decodes UTF-8. Use a `TextDecoder` with the
appropriate encoding directly for other charsets. `keywords: 'raw' | 'expand'`
defaults to raw (`-k`, compatible with older CLI versions). Results have no methods,
so they remain cloneable. Batch print uses stdin (`-x -`) and can omit retained content
with `keepContent: false`; consume item events to receive those bytes.

History requests ask for one extra revision per path, then merge/sort/slice globally.
`hasMore` reports that the requested limit omitted revisions. Integrations retain
relationships and revision ranges; moves can span multiple depot paths. Revision
numbers alone do not identify items: pair them with `depotFile`.

`whereFiles` preserves exclusion rows as `isExcluded: true`, strips the leading `-`
from paths, and retains `.localFile`. Exclusions unmap a path; do not treat them as
usable mappings. Unmapped specs produce `.failures` instead of discarding valid rows.

Brand constructors (`P4DepotPath.make`, `P4ClientPath.make`, `P4LocalPath.make`,
`P4FileAction.make`) validate values through Effect Schema. Do not replace decoder
validation with casts when consuming untrusted CLI or IPC data.

## Other field and filtering changes

- Timestamps are ISO 8601 strings, replacing raw Unix-second fields.
- Workspace listing without `user` now lists every workspace. `host` includes
  hostless workspaces; root existence checking is a separate Node helper.
- Pending changes always read full descriptions (`-l`); the default changelist is
  synthesized only on the first page. `nextBeforeChange` becomes `nextCursor`.
  Cursors are inclusive upper bounds; pass the returned cursor, which is already
  one below the last returned change. Revision-bearing file specs cannot be combined with a cursor.
- Opened `changeDescription` replaces `changelistDescription`; compare
  `change === 'default'` instead of `isDefaultChangelist`. Use `whereFiles` to map
  opened client paths to local paths; they are no longer guessed from cwd.
- `describe` removes `contentSource`. Shelved pending changes have `status: 'shelved'`;
  a submitted change remains `submitted` even when requested with the shelved flag.
- Depot/file row `changelist` becomes `change`; `maxResults` becomes `limit`.
- Reconcile candidates use `clientFile` instead of `localFile` and `change` instead
  of `changelist`. Workspace options need only `{ root }`. Moves group into added/deleted.
- Message `disposition` uses `fail | item | empty | notice`, rather than the plan's
  proposed `fatal` spelling for a failing outcome.

## Package verification

`bun run pack:core` validates npm's dry-run file list against every declared runtime
and declaration entry, including all four subpaths. It fails if the current build is
incomplete or an entry is excluded from packing. It does not build: run
`bun run clean` and `bun run build` before retrying after missing output. This catches
a retained incremental cache with missing dist files. Phase 7 still needs an actual
tarball pack and consumer trial installation.
