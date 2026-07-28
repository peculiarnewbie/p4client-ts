# Deep code-quality audit — 2026-07-13

- **Repository:** `p4-ts` / published package `p4client-ts`
- **Audited commit:** `5740cc5`
- **Scope:** all handwritten TypeScript source, unit and e2e tests, package/release configuration, authored documentation, dependency posture, and relevant current Perforce command semantics.
- **Source changes:** none in the original audit. Follow-up implementation (same day) addressed findings **1–11** and **13–16**; finding **12** is partial (optional pending `limit` only); Astro/Vite advisory upgrades remain deferred.

## Verification performed

| Command | Result |
| --- | --- |
| `bun run typecheck` | Passed. |
| `bun run test` | Passed: 131 tests. |
| `bun run test:e2e` | Process passed but ran 0 tests because no opt-in fixture was configured. |
| `bun run docs:check` | Passed; emitted a non-failing `Entry docs → 404 was not found` diagnostic. |
| `bun run pack:core` | Passed. |
| `bun audit` | Reported 27 advisories, including 12 high severity. |

Live Perforce e2e scenarios were not run because no explicitly opted-in fixture target was configured.

## Findings

### 1. Make `setClient()` switch the effective client

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/client.ts:281` persists `P4CLIENT` through `p4 set`; `packages/core/src/public/client.ts:1369` then rebuilds every command environment from `process.env` and the immutable constructor `env` object. The configured/default environment therefore overrides the value written by `p4 set`.
- **Impact:** A client created with `env: { P4CLIENT: 'old-client' }` reports success from `setClient({ client: 'new-client' })` but continues executing subsequent commands as `old-client`. `P4CONFIG` can cause the same problem. This is especially problematic because the API calls the operation `setClient`/`switchWorkspace` and returns `newClient`.
- **Confidence:** HIGH — reproduced with an injected executor.
- **Effort:** M
- **Fix risk:** MED — defining whether the operation is per-instance (`p4 -c`/internal state) or persistent local configuration changes public semantics.
- **Fix sketch:** Establish one explicit contract: either apply an instance-local client override to every command, or expose persistent `p4 set` as a separately named operation. Add tests for explicit `env` and `P4CONFIG` precedence.
- **Reference:** Perforce setting precedence puts config and environment above values written by `p4 set`: <https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_set.html>.

### 2. Make Effect streams lazy and repeatable

- **Category:** Correctness / Effect
- **Evidence:** `packages/core/src/public/service.ts:70` and `packages/core/src/public/service.ts:79` call `client.watchPreviewReconcile()` / `client.watchSync()` while constructing `Stream.fromAsyncIterable`.
- **Impact:** Constructing `service.streamSync()` starts a `p4` operation before the caller runs or subscribes to the Effect stream. Re-running an already-created stream does not execute a fresh command because it reuses one operation handle and queue.
- **Confidence:** HIGH — reproduced by injecting an executor and observing one invocation immediately after `service.streamSync()` construction.
- **Effort:** M
- **Fix risk:** MED — proper deferral must preserve cancellation and error-channel behavior.
- **Fix sketch:** Defer construction of the operation handle until stream materialization using the current Effect Stream API, and test that construction has no side effect while each materialization starts one command.

### 3. Correct the `printFile()` contract and binary handling

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/client.ts:559` invokes `p4 print -q`; `packages/core/src/public/client.ts:1096` expects and parses a header. `packages/core/tests/client.test.ts:1770` supplies a header even though the asserted command includes `-q`.
- **Impact:** Real `printFile()` calls cannot populate the promised `revision` or `type` from output. Binary bytes are converted to UTF-8 strings before the implementation can discard them, increasing memory use and risking content corruption.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** MED — the chosen solution must preserve the public text/binary contract across Perforce versions.
- **Fix sketch:** Decide between parsing an unsuppressed, correctly parsed header or obtaining metadata separately before a quiet content call. Do not decode a binary payload as UTF-8 merely to decide it is binary. Add fixture-backed tests using actual CLI output.
- **Reference:** `p4 print -q` suppresses the one-line header: <https://help.perforce.com/helix-core/server-apps/cmdref/current/content/CmdRef/p4_print.html>.

### 4. Avoid `p4 opened` for submitted diff summaries

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/client.ts:573` calls `getOpenedFileLookup()` for every non-shelved changelist, including a changelist whose parsed status is `submitted`.
- **Impact:** Submitted changelist diff summaries can fail or add an invalid lookup before returning depot-side metadata, because `p4 opened -c` is for pending changelists.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** LOW
- **Fix sketch:** Request opened-file metadata only for pending/default changelists. Submitted and shelved summaries should initialize empty local-file lookup data. Add submitted summary regressions with and without line counts.
- **Reference:** Perforce documents `p4 opened -c` as listing files in a pending changelist: <https://help.perforce.com/helix-core/server-apps/cmdref/current/content/CmdRef/p4_opened.html>.

### 5. Compute pagination metadata correctly

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/client.ts:923` requests exactly `limit` records, then `packages/core/src/public/client.ts:937` sets `hasMore` whenever `items.length >= limit`.
- **Impact:** A final page containing exactly `limit` records is reported as having a next page even when the next request is empty.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** LOW
- **Fix sketch:** Request `limit + 1` records, return at most `limit`, and derive `hasMore` from whether an extra valid result was received. Test exact-full-final-page and invalid-row filtering cases.

### 6. Fail streamed operations on malformed tagged JSON

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/client.ts:816` drops unparseable stdout lines in `watchSync()`; `packages/core/src/public/client.ts:677` treats an unparseable reconcile stdout line as progress.
- **Impact:** Buffered APIs throw `P4ParseError`, while streaming APIs can report successful but incomplete result sets. A malformed tagged record was reproduced as a successful empty `watchSync()` result.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** LOW
- **Fix sketch:** Treat JSON-looking stdout records that cannot be parsed or validated as typed parse failures. Preserve documented non-JSON progress lines separately and share parsing behavior between buffered and streaming APIs.

### 7. Honor workspace-locality configuration and documented fallback behavior

- **Category:** Correctness / docs
- **Evidence:** `packages/core/src/public/types.ts:123` documents `hostName` as an override, but `packages/core/src/public/client.ts:209` prefers `p4 info` output. `packages/core/src/public/client.ts:231` claims locality can use the workspace root, but `packages/core/src/public/client.ts:259` passes only `Host` to an exact-match helper.
- **Impact:** The advertised host override is ineffective in server mode; client specs without a Host field are always omitted despite being usable from any host. Users can fail to discover their usable workspaces.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** MED — root existence checks and hostless workspace treatment need a documented policy, especially for shared/network roots.
- **Fix sketch:** Give explicit host override precedence. Implement and document the intended hostless/root-exists policy; add tests for an override and a hostless workspace.
- **Reference:** A client spec with no Host restriction is accessible from any host: <https://help.perforce.com/helix-core/server-apps/cmdref/current/content/CmdRef/p4_client.html>.

### 8. Protect cached state from mutation and invalidation races

- **Category:** Correctness
- **Evidence:** Cached values are stored and returned by reference at `packages/core/src/public/client.ts:195`, `:221`, `:242`, and `:271`. Cache invalidation at `:1466` has no version/generation check for operations already in flight.
- **Impact:** A consumer can mutate an environment or workspace result and corrupt later cached results. An earlier in-flight environment/workspace fetch can complete after `setClient()` and repopulate an invalidated cache with stale state.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** LOW
- **Fix sketch:** Return defensive copies or immutable snapshots, and use an epoch/generation check so pre-invalidation operations cannot write cache entries after a switch.

### 9. Validate numeric options at runtime

- **Category:** Correctness / type safety
- **Evidence:** `packages/core/src/public/client.ts:1153` passes public `concurrency` directly to `Array.from`. With `NaN`, `mapWithConcurrency()` creates no workers and returns holes rather than mapped summaries. `limit`, cursors, and timeouts have similarly unchecked numeric boundaries.
- **Impact:** Values commonly derived from configuration or JSON can cause invalid `p4` arguments or structurally corrupt return values despite TypeScript signatures.
- **Confidence:** HIGH — `concurrency: Number.NaN` was reproduced as a one-element hole array.
- **Effort:** M
- **Fix risk:** MED — validation introduces explicit errors for inputs that were previously accepted accidentally.
- **Fix sketch:** Add runtime schemas/guards for positive finite integer limits and concurrency, non-negative changelist values, and valid timeout durations. Add boundary tests.

### 10. Recognize all binary-like Perforce file types

- **Category:** Correctness
- **Evidence:** `packages/core/src/public/helpers.ts:178` classifies a file as binary only when its type contains `binary` or `xb`.
- **Impact:** Perforce `apple` and `resource` types are handled as text, allowing the library to request diffs or print content that should be treated as non-text.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** LOW
- **Fix sketch:** Define the supported non-text base types explicitly and test the full set, including type modifiers.
- **Reference:** Perforce describes `apple` as resource+data and `resource` as a resource fork: <https://help.perforce.com/helix-core/apis/p4api.net/current/p4api.net_reference/html/T_Perforce_P4_BaseFileType.htm>.

### 11. Bound streaming buffers and remove quadratic queue draining

- **Category:** Performance / architecture
- **Evidence:** Both `packages/core/src/internal/command.ts:17` and `packages/core/src/public/client.ts:1517` retain every unconsumed event in an array and use `Array.shift()` to dequeue.
- **Impact:** Large sync/reconcile operations can retain all events when consumers subscribe late or not at all. Draining a large completed queue is O(n²). The queue implementation is duplicated in two places.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** MED — a bounded-buffer/drop/backpressure/cancellation policy must be explicit in the public streaming contract.
- **Fix sketch:** Extract one queue implementation with O(1) dequeue behavior and an explicit maximum-buffer/cancellation policy. Add stress tests that consume events late and never consume them.

### 12. Bound pending changelist listings

- **Category:** Performance
- **Evidence:** `packages/core/src/public/client.ts:310` runs `p4 changes -s pending` without a `-m` limit, cursor, user, or client default.
- **Impact:** A shared server can return every visible pending changelist, creating unbounded CLI output, parsing work, and UI payloads. Submitted and shelved lists already offer pagination, making the pending surface asymmetric.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** MED — introducing defaults/pagination changes caller expectations.
- **Fix sketch:** Add a paged pending-list result or a clear safe default limit, then retain an explicit opt-in for exhaustive listing.

### 13. Commit the lockfile and update vulnerable toolchain dependencies

- **Category:** Supply chain / DX
- **Evidence:** `bun.lock` is ignored by `.gitignore:5` and is not tracked. The local `bun audit` reported 27 vulnerabilities, 12 high severity, mainly in Astro/Vite documentation tooling.
- **Impact:** Clean installs resolve different dependency trees, making builds and security audits non-reproducible. The project cannot reliably know which package graph it releases or deploys.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** LOW
- **Fix sketch:** Track `bun.lock`; update same-major Astro/Starlight/TypeDoc dependencies first; rerun audit and docs checks; separately assess remaining runtime-reachable Effect dependency advisories.

### 14. Make verification gates meaningful

- **Category:** Test coverage / release process
- **Evidence:** `bun run test:e2e` returned success with 0 tests run without fixture variables. `packages/core/tests/e2e/scenarios.sync.test.ts:32` and `scenarios.sync-preview.test.ts:28` return successfully when the workspace is already at head. No CI configuration exists. `packages/core/package.json:49` omits tests from `prepublishOnly`.
- **Impact:** CI or release automation can report green without exercising e2e behavior, and unit-test regressions can ship if publish is the only gate.
- **Confidence:** HIGH
- **Effort:** M
- **Fix risk:** LOW
- **Fix sketch:** Split fixture-dependent tests into an explicitly named manual suite that fails on missing required configuration when selected; make the default suite report skipped tests clearly; add CI for typecheck, unit tests, docs, pack, and audit policy; include unit tests in release verification.

### 15. Redact credential-like raw command arguments from surfaced errors/events

- **Category:** Security
- **Evidence:** `packages/core/src/public/client.ts:1473` builds errors from `args.join(' ')`; `packages/core/src/public/errors.ts:102` does the same for timeouts; command start events preserve the raw args.
- **Impact:** If a caller uses a Perforce command-line credential argument, a failure, timeout, or streamed event can copy that credential into application logs or telemetry.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** MED — preserve enough diagnostic context while redacting sensitive values consistently in messages, results, and events.
- **Fix sketch:** Introduce a centralized command-display formatter that redacts sensitive global options and document environment/ticket-based credential handling as the preferred path.

### 16. Repair documentation drift and invalid examples

- **Category:** Documentation
- **Evidence:** `packages/www/src/content/docs/index.mdx:51` says client mutation is out of scope, while the public API and `guides/getting-started.mdx:64` document `setClient()` and `switchWorkspace()`. `packages/core/README.md:103` references `opened.localFile`, but `opened` is neither declared in that example nor a file row.
- **Impact:** Users receive contradictory scope guidance and cannot copy the npm README diff example into a typechecked project.
- **Confidence:** HIGH
- **Effort:** S
- **Fix risk:** LOW
- **Fix sketch:** Choose and document the exact local-setting mutation policy once across README, site, and API docs. Correct and typecheck the README example as part of docs verification.

## Architecture observation

`packages/core/src/public/client.ts` is 1,572 lines and currently owns process orchestration, cache state, command construction, parsing, streaming, error policy, and domain mapping. This should not be a speculative first refactor. Use the behavior fixes above to extract, in order:

1. A shared internal event queue/channel.
2. Command argument builders.
3. Command-specific Effect Schema decoders/mappers.
4. Cache state and invalidation logic.

The current generic `parseP4JsonLines<T>()` only validates that a value is an object, then casts it to `T`; command-specific required fields are not validated at runtime. This is a cross-cutting contributor to findings 6 and 9.

## Recommended execution order

1. Add characterization tests for findings 1–7 and 9 before changing behavior.
2. Fix `setClient`, Effect stream laziness, `printFile`, submitted summaries, and pagination.
3. Harden streamed parsing, runtime validation, caching, and binary classification.
4. Improve performance boundaries and extract the shared queue.
5. Commit the lockfile, update dependencies, and add CI/release gates.
6. Reconcile user-facing documentation with the resulting API contract.

