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
