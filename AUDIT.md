# Library audit — 2026-09-08

Reviewed the command adapter, event queues, client workflows, parsing helpers,
settings/cache behavior, Effect service boundary, and test/build/package setup.
This is a targeted source audit and regression pass, not an exhaustive guarantee
of correctness across every Perforce version and operating system.

## Implemented fixes

| Area | Finding | Change and evidence |
| --- | --- | --- |
| Process failures | A synchronous `spawn()` exception rejected the result but never terminated the event queue. Writing to closed stdin could emit an unhandled error. | The shared Effect command adapter handles launch and pipe failures, kills failed children, and settles watched events and results. Real child-process regression tests cover both cases. |
| Watched results | Event consumers could encounter an error before attaching a handler to the result Promise. | Both the low-level adapter and `P4Client.watch()` observe result rejection immediately while preserving rejection for callers. |
| Concurrent work | `Promise.all()` rejected as soon as one worker failed, while other workers could keep scheduling file writes or diffs. | `Effect.forEach` bounds concurrency, stops queued work on failure, and waits for already-started Promise operations. A coordinated materialization test checks original error identity, completed active work, and skipped queued work. |
| Queue lifecycle | `null` doubled as the failure sentinel, so `fail(null)` could leave future readers waiting. Early iterator return did not discard buffered values. | Explicit failure state preserves all reasons; iterator return releases values and waiters. Invalid capacities are rejected. |
| Timeouts | Durations above the platform timer maximum were accepted and could become almost immediate timeouts. | Reject values above 2,147,483,647 ms before spawning. Existing positive fractional durations remain accepted. |
| Submitted diffs | Deletes selected the revision representing the deletion as the source content. Branches and moves lacked usable inferred endpoints. | Deletes use the previous revision; branch and move endpoints are handled. Unit tests cover actions, and an isolated real-server test confirms a deleted revision #2 uses source #1. |
| Diff counts | Added/deleted content beginning with `++`/`--` was mistaken for a file header. | Counts now follow unified hunk ranges, including multiple-file patches and empty ranges. |
| Timestamps | Finite but out-of-range numbers threw from `toISOString()`; whitespace became the Unix epoch. | Invalid dates and blank timestamps return `null`; zero still returns the epoch. |

The process behavior was checked against the [Node child-process documentation](https://nodejs.org/api/child_process.html).
Perforce documents nonexistent revision endpoints in its [diff2 reference](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_diff2.html).
The deletion endpoint change was also verified against the disposable server.

## Performance and code quality

- Buffered commands no longer split output into lines, allocate an event queue,
  or run a background drain loop. A 50,000-line regression verifies complete output.
- Changelist line-count summaries build one file lookup map instead of scanning
  the entire described-file array for each item: lookup work changes from O(n²)
  to expected O(n), using O(n) additional map storage.
- Command lifecycle and bounded traversal use the installed Effect v4 beta APIs
  and typed failure channels. Existing Promise signatures and native process
  error identity are preserved at the public boundary.
- Child console windows are hidden on Windows. The streaming test now checks
  ordering within each pipe rather than assuming ordering between stdout/stderr.

These remove identifiable work; no throughput or peak-memory benchmark was run.

## Remaining priorities

1. **Materialization containment.** `getMaterializedFilePath()` checks lexical
   containment. It does not inspect existing symlinks/junctions in the destination,
   which can redirect `p4 print -o` outside that directory. A follow-up should
   define supported destination-link behavior and account for filesystem races.
2. **Output retention and caching.** Watched commands still retain complete stdout
   and stderr for their final result; the event bound does not bound output bytes.
   Consider an explicit capture limit or optional capture mode. Environment and
   workspace caches also do not deduplicate simultaneous misses; an Effect cache
   could do so while retaining refresh and workspace-switch invalidation semantics.

## Schema follow-up

Completed the requested type-safety pass after the initial audit:

- Typed JSON parsers require a schema and infer its decoded type, while raw
  parsers return object fields as `unknown`. This intentionally removes the
  unsafe generic-only overloads; migration examples are in the core README.
- Added row schemas for workspace, depot/directory/file browsing, opened files,
  changelists/descriptions, print metadata, sync/reconcile, history, users, streams,
  and annotation. Known malformed fields raise `P4ParseError` with row context.
  Missing optional fields and additional server tags remain supported.
- Exported validated path/action brands and integer/changelist schemas. Workspace
  and brand types derive from schemas. Removed all unchecked casts and non-null
  assertions from `P4Client` mappings.
- Corrected opened/reconcile/sync `clientFile` types to include local paths.
  Integer parsing rejects fractions and unsafe precision rather than truncating.
- Added compile-time contract tests to the normal typecheck command, plus runtime
  tests for malformed data, decoding transformations, brands, and Effect failures.

These schemas validate wire shapes and selected domain invariants; they do not
verify path existence, validate arbitrary unknown server extensions, or provide
schemas for every public options/result interface.

## Cancellation follow-up

- Client operation options now share `P4OperationOptions.signal`. Signals reach
  nested commands, settings readers, and concurrent materialization/diff work.
  Pre-aborted calls reject before cache hits or new work; cancelled settings
  reads stop fallback resolution and do not populate success caches.
- Each Effect service invocation owns a linked controller. Scoped finalizers
  abort and join its Promise work while leaving caller controllers and other
  invocations alone. Service streams use the same ownership on interruption,
  failure, and partial consumption.
- Returning from watched event iteration cancels and joins unfinished work.
  Event-read and schema failures clean up the producer before surfacing.
- The command adapter terminates the direct child with SIGKILL on cancellation,
  timeout, or I/O failure and waits for closure before rejecting. It explicitly
  closes failed pipes: a regression reproduced Bun/Windows retaining stdout
  when cancellation happened during output delivery, despite process exit.
- Sixteen regression tests cover ownership isolation, cleanup ordering, listener
  disposal, cache/fallback behavior, queued work, stream failure, and real child
  shutdown. Built-package checks also exercise Node cancellation.

Custom adapters must honor their supplied signal and settle after cleanup;
uncooperative adapters can delay interruption indefinitely. Cancellation does
not roll back completed writes or Perforce operations, and direct-child cleanup
does not guarantee termination of arbitrary descendants.

## Validation

- Baseline: 191 unit tests passed.
- After the schema follow-up: 228 unit tests passed; 15 isolated Perforce E2E tests passed.
- After cancellation ownership: 244 unit tests passed; all 15 isolated E2E tests passed again.
- Compile-time contract tests passed as part of the standard typecheck command.
- Strict typecheck and build passed without Effect diagnostics.
- API documentation generation, Astro check, and documentation build passed.
  The build logged an existing missing `docs → 404` entry message.
- npm pack dry run passed; nothing was published.
- Built-package smoke checks passed on Node v26.5.0 for large output, watched
  spawn errors, timeout error identity, closed stdin, external abort, iterator
  return, and partial Effect stream consumption.
- `git diff --check` passed.

Executed on Windows with Bun 1.3.14. The declared Node 18 minimum and other
operating systems were not exercised in this session. E2E tests used only the
repository's disposable localhost server and cleaned it up afterward.
