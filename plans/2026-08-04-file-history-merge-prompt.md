# Task: fix the file-history merge defect in p4client-ts

Repository: `C:\Users\Ryzen\git\swag\p4-ts` (package `p4client-ts`, in `packages/core`)

Do NOT work in `C:\Users\Ryzen\git\swag\electroswag` — that is the consumer repo, a
different codebase. Read `AGENTS.md` in p4-ts first (it is identical to `CLAUDE.md`).
This repo uses Bun 1.3.10, 2-space indent, single quotes, `.js` extensions on local
imports.

Do not reset, discard, commit, or push anything without explicit approval.

## The defect

`P4Client.getFileHistory()` (`packages/core/src/public/client.ts:842`) builds the command
correctly, including `-i` when `followBranches` is set, then throws away every row but the
first:

```ts
const result = await this.runBrowse(args, options.signal);
const rows = this.selectDataRows(args, result, (row) => normalizeNullableString(row.depotFile) !== null);

const row = rows[0];                          // <-- BUG (client.ts:855)
if (!row) return { depotFile: ..., revisions: [] };
return { depotFile: ..., revisions: this.toFileRevisions(row) };
```

`p4 -Mj -z tag filelog` emits **one JSON row per depot path**, with that path's revisions
flattened into indexed keys (`rev0`, `change0`, `time0`, … — see
`toFileRevisions()` at `client.ts:1868`). Two situations produce more than one row, and
both are broken today:

1. **`-i` (`followBranches: true`)** — one row per depot path in the integration chain.
   Every ancestor path is silently discarded, so `followBranches: true` returns exactly
   what `followBranches: false` returns. The option is inert.
2. **A wildcard file spec** (`depotFile` is documented as a *file spec*, e.g.
   `//depot/main/...`) — one row per matched file, even without `-i`. All but one
   arbitrary file is silently dropped, and `P4FileHistory.depotFile` reports that one
   file's path as if it were the whole result.

### Verified reproduction (real server)

Against `ssl:p4.stairwaygames.work:1666`, `p4 -Mj -z tag filelog -l -i` on
`//ManaBreakPrototype/Research/Config/DefaultEngine.ini` returns two rows:

```
row 1  //ManaBreakPrototype/Research/Config/DefaultEngine.ini
         revs 40..1     changes 202894 .. 170062
row 2  //ManaBreakPrototype/Main/Config/DefaultEngine.ini
         revs 25..1     changes 169480 .. 139058
```

`getFileHistory({ followBranches: true })` returns 40 revisions. It should return 65.

No live server is needed to reproduce or fix this: `packages/core/tests/history.test.ts`
already stubs the `executor`, so a two-row stdout fixture reproduces it as a unit test.

## Facts that constrain the fix

1. **Revision numbers restart per path.** Both rows above run N..1, so `#40` is ambiguous
   across the merged set and sorting the merged revisions by `revision` would interleave
   two unrelated files nonsensically. Order by **changelist descending**.

2. **The measured ranges do not overlap because `filelog -i` truncates each ancestor at
   its branch point** — not because changelists are globally monotonic in some way that
   guarantees chain order. An ancestor path keeps receiving edits after the branch, and
   those later revisions are simply not part of the `-i` output. Do not write code or
   comments that depend on non-overlap; just sort by the key.

3. **`-m N` is applied per path, not globally.** Measured: `filelog -m 51 -i` on the file
   above returns 65 revisions (40 + 25), because neither path individually exceeded 51.
   Keep passing `-m N` to `p4` — it still bounds server work, and the globally newest N
   is necessarily a subset of the per-path newest-N union — but slice the **merged** list
   to `maxRevisions` afterwards.

## Required change

### Merging

- Merge revisions from **all** returned rows, **unconditionally** — not gated on
  `followBranches`. This also fixes the wildcard case above. Consequence to accept and
  document: a wildcard spec now returns the union across matched files rather than one
  arbitrary file's history, disambiguated by the new per-revision `depotFile`.

### Ordering

- Newest-first by **changelist descending**. Fall back to `time` (numeric, descending)
  when `change` is null on both sides being compared.
- Use a **stable** sort and define the ties explicitly: when the comparison key is equal
  or not comparable (equal `change`; one side's `change` null and `time` missing; both
  null), preserve input order. Input order is row order as returned by `p4`, and
  newest-first within each row — `toFileRevisions()` walks `rev0..revN` ascending and
  `rev0` is the newest revision, so per-row order is already correct and a stable sort
  preserves it.

### Deduplication

- Dedup the merged list on `(depotFile, revision)`, keeping the first occurrence. A wide
  integration graph can emit more than two rows and can surface the same depot path in
  more than one row; do not emit the same revision of the same path twice.

### Bounding

- Apply `maxRevisions` to the **merged, sorted, deduped** list, so the option means what
  it says.

### Types

- Extend `P4FileRevision` (`packages/core/src/public/types.ts:1085`) with a required
  `depotFile: P4DepotPath` field, so a consumer can label cross-path ancestry and
  disambiguate repeated revision numbers. Note this is additive for *readers* but
  source-breaking for anything that *constructs* a `P4FileRevision` (test fixtures,
  consumer mocks) — word the CHANGELOG accordingly rather than calling it purely
  additive.
- Keep `P4FileHistory.depotFile` (`types.ts:1113`) as the requested/head path; don't
  repoint it at an ancestor. **Keep the existing derivation** —
  `this.toDepotPath(rows[0].depotFile) ?? this.toDepotPath(options.depotFile)!`
  (`client.ts:861`). `rows[0]` is the argument's own path under `-i`, and taking it from
  `p4` rather than from `options.depotFile` is what translates a client or local path (or
  a revision spec) into a depot path. Do not "simplify" this to `options.depotFile`.
- Preserve the empty-rows early return, including its requested-path fallback.

### JSDoc

Update `GetFileHistoryOptions.followBranches`, `GetFileHistoryOptions.maxRevisions`,
`P4FileRevision` (the new field), and `P4FileHistory.revisions` (currently "as emitted by
`p4 filelog`", which will no longer be true) to state: the merge across all rows, the
changelist-descending ordering key and why it is not `revision`, and that `maxRevisions`
bounds the merged total.

## Why it matters to the consumer

Electroswag ships a "Follow branches and renames" toggle backed by this method
(`src/main/services/p4/history.ts`). It requests `maxRevisions: limit + 1` and uses the
extra sentinel row to report truncation truthfully. Because ancestry is dropped and `-m`
is per-path, that truncation signal is wrong in follow mode. This is the single item
blocking Plan 013 in the Electroswag repo — see its
`plans/013-perforce-server-exploration.md`, "Known p4client-ts 0.8.0 gaps", fourth entry.

## Tests

Unit — `packages/core/tests/history.test.ts`:

- A two-row `-i` fixture asserting merged count, changelist-descending order, correct
  per-revision `depotFile`, and that `maxRevisions` bounds the merged total.
- A tie case: two revisions with equal `change`, or with `change: null`, proving stable
  input order is preserved.
- A dedup case: the same `(depotFile, revision)` present in two rows appears once.
- A `followBranches: false` single-row case proving unchanged behavior for the ordinary
  non-wildcard path — this is the main regression risk.
- A `followBranches: false` **wildcard** case asserting the new merged behavior (this one
  is a deliberate change, not a regression).
- The existing `"follows integrations when requested"` test (`history.test.ts:149`) only
  asserts argv. Extend or complement it — do not delete it.
- Preserve the existing empty-history and permission-error cases.

E2E — `packages/core/tests/e2e/scenarios.catalog.test.ts`:

- Add a real integration-chain case. The disposable-p4d harness already does `p4 add` +
  `p4 submit` in `seedFixture()` (`packages/core/scripts/test-perforce-e2e.ts:473`), so
  `p4 edit` → `p4 move` → `p4 submit` on a seeded file yields a genuine two-row
  `filelog -i` chain in a few lines. No branch spec, `p4 populate`, or second client is
  required. This case is expected, not optional.

## This is a behavior change

Bump the minor version to `0.9.0` and add a `packages/core/CHANGELOG.md` entry covering
all three semantic changes:

- the merge fix for `followBranches: true`,
- `maxRevisions` now bounding the merged total rather than being applied per path by `p4`,
- the wildcard-spec change (previously one arbitrary matched file, now the union), plus
  the new required `P4FileRevision.depotFile` field.

## Verify

```
bun run typecheck
bun run test
bun run build
bun run docs:check      # public API surface changed, so this must pass
```

Generated API markdown (`packages/core/.typedoc/api`,
`packages/www/src/content/docs/api`) is not committed, so there is no doc-regeneration
bookkeeping beyond making `docs:check` pass.

## Implementation note (added after the work landed)

The E2E case turned up one fact this plan got wrong: `p4 filelog` reports rename ancestry
as **extra rows even without `-i`**. A `p4 move` target returns three revisions across two
paths in plain, non-wildcard, non-follow mode. So "byte-identical when
`followBranches: false`" was never achievable for renamed files either — reading only
`rows[0]` silently dropped pre-rename history — which further supports making the merge
unconditional. The E2E assertions and the CHANGELOG record this behavior.

## Out of scope

Two other gaps, both re-verified as still present in 0.8.0. Neither blocks the consumer
today; **do not bundle them into this change.**

- `listStreams()` (`client.ts:894`) returns a bare `P4Stream[]` with no completeness
  indicator. Measurement demoted this from a prerequisite to optional hardening: the
  widest depot-scoped enumeration on the real server is 36 streams (142 total across 22
  depots), so the consumer uses an unbounded depot-scoped call and reports completeness
  truthfully.
- `ListDepotFilesAtChangeOptions` (`types.ts:798`) and `MaterializeDepotFilesOptions`
  (`types.ts:1238`) have no `signal` field, so `listDepotFilesAtChange()` and
  `materializeDepotFiles()` cannot be cancelled. No consumer code path calls either
  method yet, but cancellation must land before bounded historical snapshot
  materialization ships.
