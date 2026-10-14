# p4client-ts 0.13 rearchitecture

## Context

Recent releases (0.10 → 0.12.1) were mostly fixes for drift. The same Perforce row was classified differently by sibling methods: buffered vs watched, preview vs real sync, and `runTaggedJson` vs `runBrowse`. Both embedding apps work around the library:
- **electroswag**: hand-rolls three `-Mj` parsers that re-classify severity, a `-G` print reader, a read-only command guard, and connection/P4CONFIG handling.
- **ue-shed**: wraps the Promise API back into Effect, classifies errors by duck-typing, parses `where`/`filelog` itself, and neutralizes P4CONFIG with a fake path.

Root causes:
1. Errors are classified by English regex in about 5 places, ignoring `code0`/`generic`/`severity`/`fmt0`, which every `-Mj` and `-G` message carries. Bit layout verified against the corpus: `sev<<28 | argc<<24 | generic<<16 | subsystem<<10 | subcode`.
2. Every method hand-builds its own pipeline from positional boolean flags. Streaming variants are separate copies.
3. Hidden mutable state: `setClient` runs `p4 set` (a global registry write), and the internal caches go unused by both apps.
4. Effect is bolted onto a Promise core, with a hand-duplicated service interface and errors that aren't real tagged errors.
5. `messages` is non-enumerable, so it is lost over Electron IPC.

User decisions:
- Effect core is the source of truth, with a generated Promise facade.
- Stateless, immutable client. No caches, no `p4 set`.
- Explicit, enumerable envelopes.
- Close every feature gap the apps worked around.
- Breaking changes are fine. No release until this lands.

Work on a feature branch off `main`. The current 0.12.1 code stays alongside the new code until cutover, so `bun run test` stays green throughout.

## Target architecture (`packages/core/src`)

```
wire/        pure, no I/O
  record.ts     -Mj line | -G marshal dict | plain text → WireRecord { _tag: Data | Message | Text }
  marshal.ts    incremental Python-marshal decoder (resumable across chunks)
  message.ts    code0 → { severity, argc, generic, subsystem, subcode }; builds P4Message
  template.ts   fmt0 compiler: %x%, %'lit'%, [a|b], [ for %x%] → named args extracted from data
  catalog.ts    'subsystem:subcode' → { reason, refine?(args) }; then GENERIC table; then severity default
  fallback.ts   the ONLY place English regexes live: pre-protocol stderr and plain-mode text
  policy.ts     reason → Disposition ('fatal' | 'item' | 'empty' | 'notice'); category derived from reason (total map)
exec/
  Executor.ts   ServiceMap.Service P4Executor { exec(inv): Stream<ProcessEvent, P4SpawnError> }, emits bytes + Exit
  guard.ts      read-only allowlist (ported from scripts/prod-readonly-p4.ts); inspects `-x -` stdin
connection/
  Config.ts     ServiceMap.Service P4Config { connection, cwd, timeoutMs, allowMutation, executable }
  argv.ts       global flags: -p -u -c [-C] -zprog=p4client-ts -zversion=<v>
                isolated mode sets P4CONFIG/P4ENVIRO to sentinels
  resolve.ts    port of settings.ts (env, p4 set -q, P4CONFIG, enviro, P4V XML, registry), all via P4Executor,
                returns per-key sources
  workspace.ts  resolveWorkspaceForPath(dir): clients for user+host, matched on Root/AltRoots
                (win32 case-insensitive + realpath)
engine/
  spec.ts       CommandSpec<O, E, R>: name, mutates, format json|marshal|plain, argv(o), input?(o),
                decode(rec) → E | null, policy overrides, fold { initial, step, finish(state, messages) }
  run.ts        stream(spec, o): Stream<E | P4Message, P4Error>; collect(spec, o) = Stream.runFold
                (buffered IS the stream, collected)
                timeout via Effect.timeout in the engine; partial output attached to P4TimeoutError
commands/     one family per file. Multi-command ops are Effect compositions of specs, not folds.
  environment.ts (info -s via -Mj), workspaces.ts, changelists.ts, opened.ts, describe.ts,
  files.ts (depots/dirs/files/fstat/where), history.ts (filelog + lineage + hasMore),
  print.ts (printFile, printBatch -G -x -, materialize), diff.ts, annotate.ts, users.ts, streams.ts,
  sync.ts, reconcile.ts, raw.ts (runTagged)
ops.ts        registry: each entry is effectOp(spec|program) or streamOp(...)
              the P4 service shape AND the Promise facade types are derived from `typeof ops`
P4.ts         ServiceMap.Service P4; P4.layer; with(patch) = Effect.updateService(P4Config, merge(patch))
errors.ts     Schema.TaggedErrorClass: P4CommandError { reason, category, messages, command(redacted), exitCode },
              P4TimeoutError, P4ParseError, P4SpawnError, P4MaterializationError, P4ReadOnlyError
              + P4ErrorSchema union, encodeP4Error/decodeP4Error (IPC codec)
schemas.ts    existing brands + exported constructors (P4DepotPath.make etc.)
node/         NodeExecutor (port of internal/command.ts: SIGKILL + destroy pipes, stdin EPIPE race,
              windowsHide, timer max), P4.layerNode(config)
promise/      createP4Client(config): ManagedRuntime per client; op(opts & { signal }) → Promise;
              stream ops → { events: AsyncIterable, result: Promise }; with(), dispose()
testing/      replayExecutor(fixtures) with strict normalized-argv matching (nearest-fixture hint on miss),
              recordingExecutor, P4.layerTest(partialOps)
```

### Package exports (`packages/core/package.json`)
- `.` is platform-neutral. It must not import `node:child_process`, so Electron renderers can import types, schemas and the error codec.
- `./node`, `./promise`, `./testing`.
- `effect` becomes a `peerDependency` (`^4.0.0-beta.37`), plus an exact devDependency.

### Shape conventions
- Every op takes one options object. No positional `change`/`depotFile` args.
- Every result is an enumerable envelope: `{ ...data, messages }`. Lists are `{ items, messages, hasMore?, nextCursor? }`. Batch ops add `failures: [{ spec, reason, message }]`.
- `P4Message` is plain data: `severity, reason, category, code | null, template | null, args, text, reasonSource ('code' | 'generic' | 'text'), disposition`.
- The client is immutable. `setClient`/`switchWorkspace` and all caches are removed. Mutating commands (`sync`, raw mutating args) need `allowMutation: true` in config. Otherwise they fail with `P4ReadOnlyError`.

### Message and exit policy (one rule set for every command)
- **Default dispositions:**
  - **fatal**: session, connection and auth problems (generic 38/36, text fallback), charset, the session's own unknown client, permission (generic 6), usage (generic 1), and any otherwise-unmapped severity ≥ 3.
  - **empty**: EV_EMPTY (generic 17) warnings.
  - **notice**: anything else with severity ≤ 2.
- **Exit rule:** a nonzero exit is OK only if every severity ≥ 3 message was disposed of as `item` or `empty`. A nonzero exit with no messages, or with any fatal message, fails *after* process exit, with every message attached. This is the same rule whether the op is buffered or streamed, which removes the TJ/BR split.
- **Per-command overrides** (these fix the listed inconsistencies):
  - `where`/`fstat`/`files`: not_in_view → `item`.
  - `sync`/`previewSync`: EV_CLIENT (34) clobber and EV_FAULT (33) OS errors → `item`; `failures` is always present.
  - `describe`: "no such changelist" → `fatal` (`unknown_changelist`); status `'shelved'` when `-S` is used.
  - `printFile`: empty/unknown revision → `fatal`. `printBatch`: → `item`.
  - `users` with ids: missing user → `item`.
  - `listPendingChangelists` always passes `-l`. Default-changelist synthesis and the diff summary share a single `opened -c default`.

### Feature gaps closed
- `runTagged(args, { schema, policy })` in both APIs, using the shared classifier and the guard.
- `resolveConnection({ cwd, sources })` plus isolated mode; `resolveWorkspaceForPath`. This replaces both apps' P4CONFIG hacks. electroswag's P4V retry becomes a `sources` order.
- `getFileHistory`:
  - `hasMore` (`-m N+1` per path, then merge/sort/slice)
  - `integrations[]` per revision, decoded from `how{n},{m}`/`file{n},{m}`/`srev`/`erev`
  - a `followMoves` lineage helper
- Binary content:
  - `printFile` uses `-G`, returning `content: Uint8Array` plus a `text()` helper.
  - `printBatch` uses `-G -x - print`, streaming `{ file, content }` or item failures.
  - A single `keywords: 'raw' | 'expand'` option (default raw) replaces the inconsistent `-K` use.
- History `hasMore` and `where` exclusions are documented in `MIGRATION.md`, so the apps drop their own parsers.

## Phases

| # | Work | Tests |
|---|---|---|
| 0 Capture | Extend `scripts/capture-wire.ts`: `-Mj info -s`; `-G print` (text/binary/utf16/miss); `-G -x - print` batch with one miss; `-Mj`/`-G` `diff -du`/`diff2 -du` with bodies; multi-spec `where`/`fstat`/`files` with one bad spec; `describe -S` of a submitted change; multi-scope `changes`; real OS sync errors (replacing the synthetic fixtures); large-tree `reconcile -I`. Normalize `args` into each fixture. | Coverage test: every fixture is referenced by a test. The allowlist starts at about 70 and can only shrink. |
| 1 Wire | `src/wire/*` (pure). | `catalog.test.ts` over the whole corpus: decoded sev/generic equal the row fields; every code is in the catalog or on `KNOWN_GENERIC_ONLY`; every fmt0 matches its data; reasons equal the golden `tests/fixtures/wire/_reasons.json` (regenerated by a script; review the diff). Marshal chunk-split tests. A grep test enforces "regexes only in fallback.ts". |
| 2 Exec | `exec/Executor.ts`, `node/NodeExecutor.ts`, `exec/guard.ts`, `exec/legacy.ts` (`fromPromiseExecutor`, to adapt existing fake executors during the port). | Port `command.test.ts`, `cancellation.test.ts`, `prod-readonly-p4.test.ts`. |
| 3 Engine + connection | `engine/*`, `errors.ts`, `connection/*` (settings logic moves into `resolve.ts`; `reg query` goes through the executor). | Port `settings.test.ts`, `errors.test.ts`; engine fold tests on synthetic event streams; buffered vs streamed parity property test. |
| 4 Commands | One family at a time into `commands/*` + `ops.ts`. | Convert the `client.test.ts` argv pins into a table `{ op, options, argv, fixture }`, asserting subcommand argv and global flags separately and replaying via the strict replay executor. Port browse/history/streams/schemas/wire/wire-review/classification. Deliberate behavior changes go in `MIGRATION.md`. |
| 5 Facades | `P4.ts`, `promise/`, `testing/`, `node/` layer, package `exports`, peer dep. | Port `service.test.ts`. A type test checks facade keys equal ops keys. Abort/interrupt tests through the facade. Rewrite `tests/types/schemas.ts`. |
| 6 Cutover | Delete `src/public/{client,service,types,helpers,command-format,settings}.ts`, `src/internal/*` (keep `async-queue` only if the facade needs it). Rewrite `tests/e2e/harness.ts` (assert `-p` equals the isolated port; allow `-x -` only for print) and update the scenarios. Rewrite the `packages/www` guides (index, getting-started, effect-service, testing-and-fixtures). Write `MIGRATION.md` (old → new op map) and the CHANGELOG. Update CLAUDE.md (ServiceMap note, layout). | Full unit + e2e + `docs:check` + `pack:core`. |
| 7 Consumer trial | Pack the tarball and trial-upgrade electroswag and ue-shed on throwaway branches (typecheck + their p4 tests, e.g. electroswag `sync-output.test.ts`). Feed the findings back before release. Nothing is pushed in those repos without asking. | App test suites. |

### Reuse
- `internal/command.ts` spawn/kill/pipe logic → `node/NodeExecutor.ts`
- `internal/cancellation.ts` ideas, replaced by Effect interruption
- `internal/rows.ts` row schemas → `commands/*`
- `public/helpers.ts`: diff plan, `summarizeUnifiedDiff`/`parseUnifiedDiff`, `isBinaryP4Type`, timestamps
- `public/settings.ts` parsers → `connection/resolve.ts`
- `scripts/prod-readonly-p4.ts` allowlist → `exec/guard.ts`
- `scripts/test-perforce-e2e.ts` `startFixture` (unchanged)
- `tests/fixtures/wire/*` as the replay corpus

### Risks
- **Effect beta churn:** keep Effect APIs confined to engine/P4/facades.
- **`-G` string values are raw bytes in the client charset** (verify against the utf16 and unicode-server fixtures).
- **Per-row stream overhead on large `describe`/`fstat`:** chunk the rows and benchmark with `describe-large`.
- **Reconcile `-I` may never emit progress through pipes:** verify in Phase 0 before building the event surface.
- **AltRoots require `client -o`.**
- **Both apps must migrate together** (Phase 7).

## Verification
- `bun run typecheck`, `bun run test`, and `bun run test:e2e` (disposable p4d) pass at every phase boundary.
- The corpus catalog test and the fixture-coverage test pass. Grep shows no English regexes outside `wire/fallback.ts`.
- Parity test: for sync, previewSync and previewReconcile fixtures, the buffered result deep-equals the fold of the streamed events.
- IPC check: `structuredClone(result)` and `decodeP4Error(encodeP4Error(err))` round-trip losslessly.
- Root-entry check: importing `p4client-ts` in a bundle with `node:*` marked external pulls no `child_process`.
- `bun run docs:check` and `bun run pack:core`, then the Phase 7 consumer trial typecheck/tests in electroswag and ue-shed.

---

## Progress and handoff (2026-10-14)

Branch `rearch/0.13`, PR #8. Phases 0–3 are done and pushed; Phase 4 has not started.
`bun run typecheck` and `bun run test` (487 tests) pass at `5a65d9d`.

| Phase | Commit | State |
|---|---|---|
| 0 Capture | `760c01c` | Done. 25 new fixtures; `tests/fixture-coverage.test.ts` allowlist may only shrink. |
| 1 Wire | `84cb3ec` | Done. `src/wire/*`, `src/errors.ts`, `src/testing/fixture.ts`, golden `tests/fixtures/wire/_reasons.json`. |
| 2 Exec | `b90ab0c` | Done. `src/exec/{executor,guard}.ts`, `src/node/executor.ts`, `src/connection/argv.ts`, `src/version.ts` (0.13.0). |
| 3 Engine | `5a65d9d` | Done. `src/engine/{command,config}.ts`, `src/connection/settings.ts`, `src/node/connection.ts`, `src/testing/executor.ts`. |
| 4 Commands | — | Next. See below. |

The old code in `src/public` and `src/internal`, and its tests in `tests/*.test.ts`, are untouched and still pass. They are deleted at cutover (Phase 6).

### What exists

- **`wire/`** (pure, no Node imports):
  - `reasons.ts`: the `P4Reason` and `P4Category` literal schemas, `categoryOf`, and severity names.
  - `catalog.ts`: `decodeMessageCode`, and `MESSAGE_CATALOG` keyed by `subsystem:subcode`, covering all 22 codes in the corpus. `GENERIC_REASONS` covers the `EV_*` generic codes.
  - `template.ts`: `fmt0` matching.
  - `message.ts`: `P4MessageSchema`, `toMessage` and `textMessage`. Multi-part messages match `fmt0` against their trailing lines.
  - `fallback.ts`: the only English regexes, enforced by a test.
  - `marshal.ts`: incremental `-G` decoder.
  - `record.ts`: `-Mj` line reader and data/message classification.
  - `policy.ts`: `dispose(message, policy)` returns `'fail' | 'item' | 'empty' | 'notice'`.
- **`errors.ts`:** Schema tagged errors (`P4CommandError`, `P4TimeoutError`, `P4ParseError`, `P4SpawnError`, `P4ReadOnlyError`, `P4InvalidArgumentError`, `P4MaterializationError`), plus the `P4ErrorSchema` union and `encodeP4Error`/`decodeP4Error`.
- **`exec/`:**
  - `P4Executor` service: `run(invocation) → Stream<stdout | stderr | exit>`, with `exit` always last.
  - `checkCommand(args, input)`: the read-only guard.
- **`engine/command.ts`:**
  - `streamCommand(spec)` gives data, message and failure events.
  - `runCommand(spec)` is that stream folded.
  - `runPlainCommand(spec)` handles plain-text commands.
  - All three share one exit rule, add the global args, `-zprog=p4client-ts` and `-zversion`, apply the guard and handle timeouts.
- **`engine/config.ts`:** the `P4Config` service, `configLayer(options)`, `withOptions(patch)`, and `P4ClientOptions` (`executable`, `connection`, `cwd`, `env`, `timeoutMs`, `allowMutation`).
- **`node/`:** `NodeP4Executor` and `runNodeProcess`; `resolveConnection` (sources: `p4` set, `p4v-app-settings`, `p4v-connection-map`).
- **`testing/`:**
  - `readWireFixtures` and `fixtureStdout`.
  - `scriptedExecutor`.
  - `replayExecutor`: strict on command args plus stdin, ignoring `-p/-u/-c/-C/-H/-zprog/-zversion`.
  - `recordingExecutor`.

### Decisions made while implementing (beyond the plan)

- **What fails by default:**
  - Errors (severity ≥ failed) and these reasons fail regardless of severity: session/connection/auth, charset, permission, configuration, `unknown_client`, `not_in_view`, `unknown_changelist`, `unknown_user`. Batch operations override the last three to `item`.
  - EV_EMPTY warnings and the empty reasons are `empty`.
  - Everything else is `notice`.
- **Non-zero exits:** fail only if no message was emitted at all, or the plain spec's `acceptExit` rejects it.
- **Plain-text stderr:**
  - A header plus tab-indented lines is one message (for example "Perforce client error:" followed by "Connect to server failed…").
  - Severity: known empty-result notices are warnings; otherwise the message is `failed` when the exit code is non-zero.
- **Commands per format:**
  - `-Mj diff` returns the body in `data` rows.
  - `-Mj`/`-G` `diff2` return only a header, so `diff2` stays plain.
  - `info` uses `-Mj info -s`.
  - `print` and `printBatch` use `-G`. `-Mj print` puts bytes in a JSON string, which isn't binary-safe.
- **Reconcile progress:** `reconcile -I` emits no progress through a pipe, even over 2,000 files (fixture `reconcile-progress-large`). Drop the `-I` fallback machinery; stream reconcile items instead.
- **`describe -S`** on a submitted change reports `status: submitted` (fixture `describe-submitted-shelved-flag`).
- **Sync OS errors** are code `0:1`, generic 33, template `%operation%: %arg%: %errmsg%`; the file is `args.arg`.
- **The registry settings source is dropped:** `p4 set -q` already reports registry values. `resolveConnection` lives in `p4client-ts/node` because it reads P4V files.
- **Executor environment:** `env` holds changes on top of `process.env`, and `undefined` removes a variable. A broken stdin pipe only fails the run when `p4` exits 0.
- **Replay collisions:** `info-json`, `server-unreachable` and `command-timeout` share command args (`-Mj -z tag info`), so replay them individually, never as a whole-corpus map.

### Streaming and progress (requested during Phase 3, design for Phase 4)

The requirement is that every operation can report progress, not just sync.

- **Every operation is a program:** `(sink) => Effect<Result, P4Error, P4Executor | P4Config>`. The sink receives `item`, `message`, `failure` and `progress` updates.
  - `watch(op)` wraps the program in a `Stream` of `P4OperationEvent<Item, Result>`: `item | message | failure | progress | done(result)`.
  - `run(op)` runs the same program with a sink that discards events.
  - Both forms execute one code path, so they cannot drift.
- **`P4Progress`:** `{ completed, total | null, unit, bytesCompleted | null, bytesTotal | null, elapsedMs }`.
  - **Determinate:**
    - sync and preview sync: the first row carries `totalFileCount`/`totalFileSize`, giving files and bytes
    - printBatch and materialize: the input list
    - diff summary: the file list
    - paged changelists: the limit
  - **Indeterminate** (running count, `total: null`): reconcile, describe, fstat, filelog and the other lists.
- **`progressIntervalMs` (heartbeat):** emits a progress snapshot with `elapsedMs` while `p4` prints nothing, so UIs never sit silent. Implement it as a ticker merged with `haltStrategy: 'left'`.
- **`Stream.callback` gotcha:** a *failing* effect inside `Stream.callback` hangs the stream instead of failing it (verified in beta.37). The watch runner must catch the program's cause and call `Queue.failCauseUnsafe(queue, cause)`, and call `Queue.endUnsafe` after `done`.
- **Promise facade:** `client.sync(opts)` resolves to the result; `client.watch.sync(opts)` (or `watchSync`) returns `{ events: AsyncIterable, result: Promise }`. Both are generated from the op registry.

### Phase 4 checklist

1. **Runner:** `src/engine/operation.ts` with the program/sink, `watch`/`run`, the heartbeat, and a forwarding helper that takes `streamCommand` events into the sink.
2. **Commands:** `src/commands/*.ts`, one family at a time, each with its policy from the plan's per-command overrides:
   - environment (`info -s`)
   - workspaces
   - changelists (pending with `-l`, plus default synthesis sharing one `opened -c default`; submitted/shelved paging)
   - opened
   - describe
   - files (depots/dirs/files/fstat/where, with `not_in_view → item`)
   - history (`hasMore` via `-m N+1`, integrations from `how{n},{m}`/`file{n},{m}`)
   - print (`printFile -G`, `printBatch -G -x -`, materialize `-o`)
   - diff (`-Mj diff`, plain `diff2`)
   - annotate, users (ids: `unknown_user → item`), streams
   - sync/previewSync (clobber, filesystem, fault, client_fault and not_in_view → item; `failures` always present)
   - reconcile
   - raw `runTagged(args, { schema, policy })`
3. **Branded constructors:** reuse `src/public/schemas.ts` (move it to `src/schemas.ts`) and row schemas from `src/internal/rows.ts`; mappers port from `client.ts` `to*` methods.
4. **Tests:** turn the `client.test.ts` argv pins into a table `{ op, options, argv, fixture }` replayed strictly. Shrink the fixture-coverage allowlist as fixtures get used. Record deliberate behaviour changes in `MIGRATION.md`.
5. **Workspace for a directory:** `findWorkspaceForPath` in `src/node/workspace.ts`, built on the workspaces op (win32 case-insensitive and realpath; AltRoots via `client -o`).

### Working notes

- **Effect 4.0.0-beta.37:**
  - Use `ServiceMap.Service<Self, Shape>()('key')`; there is no `Context` module, and the effect-solutions docs assume a newer beta.
  - `Stream.runCollect` returns an array.
  - `Effect.runPromise(e, { signal })` rejects an abort with a generic "All fibers interrupted" error, so the Promise facade must rethrow `signal.reason`.
  - Tagged errors are real `Error`s and survive `runPromise` rejection.
- **Tests:**
  - `bun run test` runs `tests/*.test.ts` and `tests/unit/`; e2e is excluded.
  - New tests are typechecked through `tsconfig.scripts.json`, which includes `tests/unit/**` and `tests/support/**`.
- **Captures:**
  - `bun run wire:capture` rebuilds every fixture against a disposable `p4d`. Binaries are cached in `%LOCALAPPDATA%\p4-ts\perforce` on Windows and `~/.cache/p4-ts/perforce` elsewhere.
  - Then run `bun run wire:reasons` and review the diff of `_reasons.json`.
  - Marshal captures are not path-normalized, so don't capture commands whose `-G` output contains local paths (that is why `diff-opened-marshal` was dropped).
- **Editing:** scripted Python edits mangled `\n`/`\s` inside heredocs. Edit files directly when replacements contain escapes.
