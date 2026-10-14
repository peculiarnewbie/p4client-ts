# Migrating 0.11 / 0.12 → 0.13

0.13 replaces the cached `P4Client` with a stateless Effect core and an immutable
Promise facade. Install `effect@4.0.4` alongside `p4client-ts`.

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

Use `withP4Client(options, use)` for a scoped request, or dispose the original client and each derived client. A derived client owns an independent
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
| `run(args)`, raw `watch(args)` | No plain raw facade; use guarded `runTagged` / `watch.runTagged`; plain integrations can use `runNodeProcessPromise` from `/node` |
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
codes, then generic codes, then a text fallback. Without a unique code, broad
EV_EMPTY (17) is refined by specific diagnostic text; path subjects are recovered
even when the server omits `fmt0`. Reasons are more specific: an empty
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
a retained incremental cache with missing dist files. Consumer trials exposed the compatibility and behavioral fixes described below.
Repeat app validation with a fresh stable-Effect tarball before release.


## Exported types and field migration

These replacements also apply to 0.11 consumers. Import domain types from the root;
import the Promise client from `/promise` and materialization types from `/node`.

| Old exported symbol | 0.13 replacement |
| --- | --- |
| `P4Client` (instance type) | `P4PromiseClient` from `/promise`; construct with `createP4Client` |
| `P4WorkspaceSummary` | `P4Workspace` |
| `P4EnvironmentSummary` | `P4Environment` |
| `P4ChangelistListSummary` | `P4Changelist`; use `P4Changelist<'submitted'>` for numeric changes |
| `ListSubmittedChangelistsOptions`, pending/shelved list options | `ListChangelistsOptions` with explicit `status` |
| `ListSubmittedChangelistsResult`, pending/shelved list results | `P4ChangelistPage`; `P4ChangelistPage<'submitted'>` narrows numeric changes |
| `P4FileDiffResult` | `P4FileDiff` |
| `ListDepotDirsResult` | `P4DepotDirList` |
| `ListDepotFilesResult` | `P4DepotFileList` |
| `P4DepotFileListing` | `P4DepotFile` |
| `ListDepotFilesAtChangeResult` | `P4DepotFileRevisionList` |
| `P4SyncPreviewResult` | `P4SyncResult` |
| `P4ReconcilePreviewResult` | `P4ReconcilePreview` |
| `isP4ConnectionError` | Inspect `_tag`, then `category` / `reason` on `P4CommandError` |
| `P4OpenedFileSummary`, `GetOpenedFilesOptions` | `P4OpenedFile`, `ListOpenedFilesOptions` |
| `P4PendingChangelistSummary`, `P4SubmittedChangelistSummary`, `P4ShelvedChangelistSummary` | `P4Changelist<'pending'>`, `P4Changelist<'submitted'>`, `P4Changelist<'shelved'>` |
| `P4ChangelistListStatus`, `ListChangelistsResult` | `P4ChangelistStatus`, `P4ChangelistPage` |
| `P4PrintResult` | `P4PrintedFile`; `printedText` supplies UTF-8 text |
| `P4AnnotationResult` | `P4Annotation` |
| `P4SyncResultWithErrors`, `P4SyncErrorItem`, `P4SyncPreviewItem` | `P4SyncResult`, `P4SyncFailure` / `P4ItemFailure`, `P4SyncItem` |
| `PreviewSyncOptions` | `SyncOptions` |
| `P4OperationHandle`, `P4OperationOptions`, `WatchP4CommandOptions` | `P4WatchHandle`, `P4PromiseOptions`, `P4PromiseWatchOptions` from `/promise` |
| `P4ProgressSnapshot`, `P4SyncProgressEvent`, `P4ReconcileProgressEvent` | `P4Progress`, `P4OperationEvent<Item, Result>` |
| `P4CommandExecutor`, `P4StreamingCommandExecutor`, `P4CommandStreamEvent`, `P4CommandStreamSource` | `P4Executor`, `P4ProcessEvent`; stream source is its `_tag` |
| `P4CommandResult` | Plain process output: `P4ProcessResult` from `/node`; domain methods return envelopes |
| `P4CommandOptions` | Configure `P4ClientOptions`; raw reads use `RunTaggedOptions` plus Promise cancellation options |
| `RunTaggedJsonOptions` | `RunTaggedOptions`; `TypedTaggedOptions<A>` requires a schema |
| `GetEnvironmentOptions` | `OpOptions<'getEnvironment'>` (empty options); no local mode |
| `P4CliSettings`, `P4SettingKey`, `P4ResolvedSettings`, `ResolveP4SettingsOptions` | `P4Settings`, `P4SettingField`, `P4ResolvedConnection`, `ResolveConnectionOptions` (last two from `/node`) |
| `P4SettingsContribution` | `P4ResolvedConnection.sources`, a field-to-source record |
| `P4SettingsSource` | Same name, from `/node`; changed source literals |
| `P4ListWorkspaceResult`, `LocalWorkspaceCandidate` | `P4WorkspaceForPath`, `P4WorkspaceMatch` from `/node`; inspect `.match` and `.candidates` |
| `P4MessageReason`, `P4FailureReason`, `P4ErrorCategory`, `P4ServiceError` | `P4Reason`, `P4Reason`, `P4Category`, `P4Error` |
| `P4ClientOperationError` | Narrow `P4Error` tags: command, spawn, timeout, parse, read-only, invalid argument, materialization |
| `P4ResultArray`, `P4MessageCarrier` | Ordinary enumerable result envelopes; use the operation's result type |
| `P4JsonValue`, `P4JsonWorkspace`, `P4JsonWorkspaceSchema` | `unknown` / `Row` for raw rows; `P4Workspace` for decoded workspaces; validate custom raw shapes with Schema |
| `P4MessageRowSchema` | `P4MessageSchema` validates classified messages, not raw CLI rows |
| `ResolvedDiffPlan` | `P4DiffPlan` |
| `SetClientOptions`, `SetClientResult` | Removed; persistent switching stays app-owned |

Other domain row/option names keep their names, including branded path/action types,
`P4ClientOptions`, `P4Service`, `P4Message`, error classes, diff/changelist summaries,
file stat/mapping/history rows, users, streams and reconcile candidates. Their field
and execution changes still apply; materialization types move to `/node`.

| Old helper / service export | Replacement |
| --- | --- |
| `getP4Environment`, `listP4Workspaces`, `getOpenedFiles`, `getChangelistFiles` | `getEnvironment`, `listWorkspaces`, `listOpenedFiles`, `listOpenedFiles({ change })` |
| `streamSync`, `streamPreviewReconcile` | Service `.watch.sync` / `.watch.previewReconcile`, or `watchOperation` |
| `mergeIncompleteSettings` | `fillMissing`; returns both merged settings and contributed fields |
| `parseP4SetOutput`, `parseP4vConnectionString`, `parseP4vApplicationSettingsXml`, `parseP4vConnectionMapXml` | Same names; return connection-field settings |
| `parseRegQueryOutput` | Removed; `p4` discovery delegates registry resolution to the CLI |
| `classifyP4Error`, `classifyP4Failure` | Shared `toMessage` / `textMessage` classification and tagged operation errors |
| `redactCommandArgs`, `formatCommandArgs` | `redactArgs`; applications own display formatting |
| `buildDepotDiffFilespec`, `resolveDepotDiffRevisions`, `resolveShelvedDiffRevisions` | `fileAtRevision`, `submittedDiffRevisions`, `shelvedDiffRevisions`; check the new object inputs |
| `resolveDiffPlan`, `isBinaryP4Type`, `parseUnifiedDiff`, `summarizeUnifiedDiff` | Same names; diff input uses `file` and plan type is `P4DiffPlan` |
| `parseP4JsonLines`, `parseTaggedJsonLine`, `parseP4PrintHeader`, `parseP4ProgressLine`, `parseP4KeyValueOutput` | Removed public parsing helpers; use operation results, watches and settings parsers |
| `normalizeNullableString`, `normalizeNullableNumber`, `normalizeP4Change`, `unixSecondsToIsoString` | Removed; typed operations decode these fields; custom rows need an app Schema |
| `requirePositiveInteger`, `requireNonNegativeInteger`, `requirePositiveTimeoutMs` | Removed; operations validate arguments; public integer schemas validate custom inputs |
| `isLocalWorkspace`, `workspaceRootFileSpec`, `workspaceStreamFileSpec`, `requireWorkspaceStreamFileSpec` | Removed; `/node` workspace matching/root checks and explicit app-selected `fileSpec` |


| Old field / behavior | 0.13 field / behavior |
| --- | --- |
| History `time`, `timeIso` | `submittedAt`, ISO string; no raw seconds pair |
| Changelist `createdAtIso` | `createdAt` already contains the ISO value; do not parse it as seconds |
| Workspace raw/ISO time pairs, current-client marker | ISO `updatedAt` / `accessedAt`; compare `workspace.client` to the chosen connection client |
| Diff `diffFlags` string | Array of flag strings, e.g. `['-du']` |
| Printed file metadata | Single `P4PrintedFile` has flattened metadata and `content`; batch items have `{ file, content }` |
| Deferred diff zero line counts / load-state fields | Unloaded counts are `null`; apps own deferred UI state |
| Successful diff process `exitCode` | Removed; success is the resolved domain result, apps can project legacy success code `0` |
| Pending list array | Paged `.items`; follow `.nextCursor` until null |
| Print workspace default | Head; explicitly pass `revision: 'have'` to preserve workspace behavior |

A literal `status: 'submitted'` or `'shelved'` now guarantees numeric `change`
in Promise, native service, operation-runner and watched results. Pending or
union-status results still admit `'default'`.

## Effect compatibility and process boundaries

Development uses stable Effect 4.0.4; the peer contract is `^4.0.0`. Pre-release
beta runtimes are outside that contract. Native layers, services and schemas must
use a compatible stable Effect installation. The old beta.37 `ServiceMap` import
is gone: use `Context.Service`, `Schema.TaggedError`, and `yield* P4` directly.

An app retaining an incompatible Effect version can isolate a stable installation
using its package-manager dependency policy and use `/promise` as its boundary.
The library does not bundle a private Effect runtime. Exchange plain options,
results and AbortSignals; do not pass the app's incompatible schemas or layers.
Call `runTagged` without a schema and validate returned `items` on the app side.
The trial-specific beta.37 peer-removal hooks are obsolete; do not carry them to
stable. A scoped override alone may not isolate a peer: inspect the resolved tree.

For an existing stdout/stderr integration, `/node` exports
`runNodeProcessPromise(invocation, { signal })`, returning
`{ stdout: string, stderr: string, exitCode: number | null }`. It uses the same
process cleanup as the stream executor, accepts stdin, returns nonzero exits, and
rejects spawn failures and cancellation. It is a low-level process executor:
provide all flags/environment yourself; it applies no P4 guard or message policy.
It buffers UTF-8 text; use `printFile` / `printBatch` for binary content.

`runTagged({ args: ['-x', '-', 'diff', '-se'], input: specs.join('\n') + '\n' })`
keeps large read batches off Windows argv. The library adds JSON/global flags and
inspects stdin arguments: option lines and mutating commands still require
`allowMutation`. `taggedOperation` and watched raw commands accept the same input.
Raw tagged results also expose `failures`; a custom item policy requires auditing
both `.items` and `.failures`.

`with({ connection: { client } })` affects only the new client. An intentional
persistent active-workspace action must remain app-owned; the library adds no
persistent `p4 set` switching API.

## Settings resolution and project binding

The old settings source `cli` is now `p4`. The separate `registry` source disappears:
`p4 set -q` includes Windows registry, environment, P4CONFIG and P4ENVIRO resolution.
Old `P4PORT` / `P4USER` / `P4CLIENT` / `P4CHARSET` fields become
`port` / `user` / `client` / `charset`. Contribution arrays become a field-to-source
record, for example `{ port: 'p4', client: 'p4v-app-settings' }`.
Sources are consulted in order and only fill missing values; resolution may stop
once port, user and client are known. Use the returned record for diagnostics.

`cwd` is client configuration. Discovery reads local settings without server info;
`getEnvironment({})` contacts the server and reports configured connection fields,
so its `port` may be null when selected only through environment. There is no
`getEnvironment({ mode: 'local' })` fallback. Retain explicit offline app state or
resolve only P4V sources when the CLI is unavailable. Unreadable P4V files contribute
nothing; the `p4` source can reject (spawn, timeout or command failure), rather than
silently skipping to P4V. Catch that rejection before an app-selected fallback.

See the Getting Started guide for a complete recipe: configure project cwd,
resolve settings, derive an explicit connection, get server info, filter clients
by user, find the project-bound workspace, and derive its isolated runtime.
Never choose an arbitrary first workspace from the unfiltered server list.

## Ownership, partial results and materialization

Opened files no longer promise local filesystem paths. Run `whereFiles` on their
`clientFile` values, inspect mapping failures and remove exclusions. Reject missing
or ambiguous mappings before doing filesystem work. The Getting Started guide
shows that recipe and a preview that refuses partial sync evidence.

Materialization preserves caller metadata generically:
`P4MaterializeResult<YourSnapshotRow>.items[].file` retains action, change and type
when supplied, including watched items. Inputs still require exact positive
revision numbers. Missing revisions fail with `P4CommandError`; deleted revisions
that print no output fail with `P4MaterializationError` / `missing_output`.
Each output is staged, checked as a regular file, then moved to its final path;
an existing output is preserved when that revision prints nothing. Empty files
are valid. Temporary output is cleaned on completion, failure and interruption.
The batch is not transactional: other files may already have been written when
one fails. No success item or progress increment is emitted for absent output.

## Constructing and mapping errors

The positional constructor becomes an object:

```ts
import { P4CommandError } from 'p4client-ts';

const error = new P4CommandError({
  message: 'Workspace configuration is unavailable.',
  reason: 'server_config',
  category: 'configuration',
  command: 'p4',
  args: ['info'],
  exitCode: 1,
  messages: [],
  stderr: 'Check P4PORT.',
});
if (error._tag === 'P4CommandError' && error.category === 'configuration') {
  console.log(error.reason); // select the recovery action using the reason
}
```

| Old category | New category / detail |
| --- | --- |
| `server_config`, `client`, `user`, `charset` | `configuration` for configuration diagnostics such as `server_config`, `misconfigured`, `charset`; missing named clients/users use `not_found` with `unknown_client` / `unknown_user` |
| Connection errors | `connection`, e.g. `server_unreachable` |
| Authentication errors | `authentication`, e.g. `not_logged_in`, `ticket_expired` |
| Permission errors | `permission`, e.g. `permission_denied` |

The full public category set is `connection`, `authentication`, `configuration`,
`permission`, `usage`, `not_found`, `not_in_view`, `notice`, `conflict`,
`filesystem`, `fault`, `limit`, `unknown`. Non-command errors
have their own tags and fields; narrow `_tag` before accessing category.

Stable Schema removes the beta `onExcessProperty: 'preserve'` option. A supplied
Struct decoder returns its declared fields; declare all fields you need or use an
appropriate record/rest schema. Untyped `runTagged` retains the original row.
