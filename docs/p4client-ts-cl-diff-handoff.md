# Handoff: p4client-ts — changelist diff support for Electroswag

**Created:** 2026-06-12  
**Consumer repo:** `C:\Users\Ryzen\git\swag\electroswag`  
**Target repo:** `p4client-ts` (owned library; clone at developer’s machine — published as `p4client-ts@0.4.0` from `packages/core`)  
**Upstream:** https://github.com/peculiarnewbie/p4client-ts

---

## Mission

Extend **p4client-ts** with typed, test-covered **inspection-only** APIs so **Electroswag** can offer a **codiff-like changelist review experience** for Perforce: select a pending (or submitted) CL, browse changed files, view unified/split diffs with lazy loading.

This handoff covers **library work only**. Electroswag wiring (RPC, Solid UI, `@pierre/diffs`) is a separate follow-up in the consumer repo — but types and method shapes here should be designed with that consumer in mind.

---

## Vision (what “done” looks like)

### User flow (Electroswag, future)

1. User opens Perforce page, sees pending changelists (already works via `listPendingChangelists`).
2. User clicks a CL → file list with action badges (`add` / `edit` / `delete`), +/- line counts.
3. User selects a file → unified diff loads on demand (not all patches upfront).
4. Binary files (`.uasset`, `.umap`, images) show metadata, not a broken text diff.
5. Large CLs stream/batch without blocking the UI.

### UX reference (not VCS reference)

**Codiff** (`C:\Users\Ryzen\git\other\codiff`) is the UX target. Note: codiff is **Git-native** (no Perforce). Steal the **architecture**, not the VCS commands:

| Codiff pattern | Perforce equivalent |
|---|---|
| `ChangedFile[]` + lazy `DiffSection` | `describe` / `opened -c` + per-file `diff` |
| `getDiffSectionContent` on demand | `diff` + `print` + read local workspace file |
| Patch-first, bodies later | Return summary without full patch; fetch `diffFile` per selection |
| Virtualized multi-file scroll | Consumer uses `@pierre/diffs` vanilla API in Solid |

---

## Current p4client-ts state (v0.4.0)

### Package layout (monorepo)

```
p4client-ts/
├── packages/core/          # npm package "p4client-ts"
│   ├── src/public/
│   │   ├── client.ts       # P4Client class
│   │   ├── types.ts        # all public types
│   │   ├── service.ts      # Effect wrappers + createP4Service
│   │   ├── helpers.ts      # parsers (JSON lines, key-value, progress)
│   │   ├── settings.ts     # P4V/registry/CLI resolution
│   │   └── index.ts        # barrel
│   └── tests/
│       ├── *.test.ts       # mocked CLI unit tests
│       └── e2e/            # P4_TS_E2E=1 against test-stream fixture
├── packages/test-stream/   # e2e seed manifest
└── AGENTS.md / CLAUDE.md   # contributor conventions
```

**Tooling:** Bun for tests, `tsc` for build. Follow existing patterns in `client.ts` mappers (`toOpenedFileSummary`, etc.).

### Existing `P4Client` API (relevant)

| Method | CLI | Notes |
|---|---|---|
| `run(args)` | arbitrary | Escape hatch; throws on non-zero exit |
| `watch(args)` | arbitrary | Streaming; used by electroswag for sync |
| `runTaggedJson(args)` | prepends `-Mj -z tag` | NDJSON → typed rows |
| `listPendingChangelists` | `changes -s pending` | Summary only (`change`, `desc`, `time`, …) |
| `getOpenedFiles` | `opened` | Flat rows with `depotFile`, `localFile`, `action`, `revision`, `type` |
| `getChangelistFiles(change)` | `opened -c <change>` | **Exists but unused in electroswag** |
| `previewReconcile` / `previewSync` / `sync` | reconcile/sync | Not diff-related |

### Explicitly out of scope (keep it that way)

`submit`, `shelve`, `edit`/`add`/`delete`, `revert`, `integrate`, `resolve`, changelist mutation, admin. **Diff/print/describe/filelog are inspection — they belong in scope.**

### What’s missing (gaps for codiff-like UX)

| Need | `p4` command | Status |
|---|---|---|
| Full CL spec + file list | `describe -s` | Missing |
| Unified diff (workspace vs depot) | `diff -du` | Missing |
| Depot content at revision | `print` | Missing |
| Revision history | `filelog` | Missing (P2) |
| Have/head metadata | `fstat` / `have` | Missing (P2) |
| Parsed hunks for UI | parse diff stdout | Missing |
| Batched/streaming CL diff | compose opened + diff | Missing |

---

## Electroswag consumer context (read-only; don’t implement here)

Electroswag already depends on `p4client-ts@^0.4.0`:

- **Service:** `src/main/services/p4-service.ts` — `createWorkspaceClient()` sets `cwd`, `env` (`P4CLIENT`), `timeoutMs: 1500` for snapshots.
- **RPC:** 10 `p4.*` methods in `src/shared/rpc/p4.ts` — no diff methods yet.
- **UI:** `src/mainview/routes/PerforcePage.tsx` — pending CL list is **read-only, not clickable**; opened files grouped by CL, no diff pane.
- **Schemas:** `src/shared/p4.ts` — `P4PendingChangelistSummary`, `P4OpenedFileSummary` exist; no diff types.

**After publishing library changes**, electroswag will add RPC like `p4.describeChangelist`, `p4.getChangelistDiffSummary`, `p4.getFileDiff`, `p4.getFileContent` — mirror the types you export from p4client-ts.

**Link for local dev:**

```json
"p4client-ts": "file:../p4client-ts/packages/core"
```

Run `bun run build` in `packages/core` after changes.

---

## Implementation plan (p4client-ts)

### Phase 1 — MVP (ship this first)

#### 1. `describeChangelist(change, options?)`

```bash
p4 describe -s <change>    # or tagged JSON: -Mj -z tag
```

**Return type `P4ChangelistDescription`:**

```typescript
type P4ChangelistDescription = {
  change: number | "default";
  user: string | null;
  client: string | null;
  description: string | null;
  createdAt: string | null;      // unix seconds as string (match existing conventions)
  createdAtIso: string | null;
  status: "pending" | "submitted";
  files: P4DescribedFile[];
};

type P4DescribedFile = {
  depotFile: string;
  action: string;                // add, edit, delete, branch, integrate, …
  type: string | null;           // text, binary, utf8, …
  revision: number | null;
};
```

**Notes:**

- For pending CLs, `getChangelistFiles` may suffice for file list; `describe` is still needed for submitted CLs and richer metadata. Implement both paths; prefer `describe` when change is a number.
- Default changelist: `opened -c default` fallback if `describe` doesn’t apply (same pattern as `listPendingChangelists`).

#### 2. `diffFile(options)`

```bash
p4 diff -du <depotFile or filespec>
```

**Options:**

```typescript
type DiffFileOptions = {
  depotFile: string;
  localFile?: string;           // informational; not passed to p4
  diffFlags?: string;           // default "-du" (unified)
  allowBinary?: boolean;        // if false, detect binary from type/fstat and skip
};
```

**Return type `P4FileDiffResult`:**

```typescript
type P4FileDiffResult = {
  depotFile: string;
  localFile: string | null;
  unifiedDiff: string;          // empty for binary or delete-with-no-output edge cases
  isBinary: boolean;
  exitCode: number;             // p4 diff returns 1 when diffs exist — use allowNonZeroExit
  additions: number;
  deletions: number;
};
```

**Critical:** `p4 diff` exits **1** when differences exist (not an error). Use `allowNonZeroExit: true` on `run()` and treat exit codes 0/1 as success; 2+ as error. Document this.

**Action-specific behavior:**

| Action | Old side | New side | diff command |
|---|---|---|---|
| `edit` | depot `#have` via print | local file | `p4 diff -du depotFile` |
| `add` | empty | local file | diff may be empty; consumer shows “new file” |
| `delete` | depot | empty | `p4 diff` or `print` + empty new |
| binary | — | — | set `isBinary: true`, skip parsing |

#### 3. `printFile(depotFile, options?)`

```bash
p4 print -q //depot/path#rev
```

**Return type `P4PrintResult`:**

```typescript
type P4PrintResult = {
  depotFile: string;
  revision: string | null;
  content: string;              // UTF-8 text; or base64 for binary (pick one, document)
  isBinary: boolean;
  type: string | null;
};
```

For binary, prefer returning `isBinary: true` with empty content and let consumer decide — or use `Buffer` + document encoding. Match what electroswag RPC can transport (likely base64 string for binary).

#### 4. Helpers in `helpers.ts`

```typescript
parseUnifiedDiff(stdout: string): P4DiffHunk[];
summarizeUnifiedDiff(stdout: string): { additions: number; deletions: number };
isBinaryP4Type(type: string | null | undefined): boolean;
```

`P4DiffHunk` minimal shape:

```typescript
type P4DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];              // raw diff body lines (context + +/-)
};
```

Keep parser tolerant — Perforce unified diff format is close to unified diff standard.

#### 5. Effect layer mirror (`service.ts`)

Add to `P4Service` interface and standalone exports (match existing `getOpenedFiles`, `previewSync` pattern):

- `describeChangelist`
- `diffFile`
- `printFile`
- `getChangelistDiffSummary` (compose helper — see below)

#### 6. `getChangelistDiffSummary(change, options?)` (high-level compose)

Single call electroswag can use for CL file tree without loading patches:

```typescript
type P4ChangelistDiffSummary = {
  changelist: P4ChangelistDescription;
  files: P4ChangelistDiffFileSummary[];
};

type P4ChangelistDiffFileSummary = {
  depotFile: string;
  localFile: string | null;
  action: string;
  type: string | null;
  isBinary: boolean;
  additions: number | null;      // null if not computed yet
  deletions: number | null;
  patchLoadState: "deferred";  // always deferred in summary
};
```

Implementation: `describeChangelist` or `getChangelistFiles` + `fstat`/type for binary detection. **Do not** run full diff for every file in summary — too slow for large CLs. Optional `includeLineCounts: true` runs diff with concurrency limit (default off).

---

### Phase 2 — streaming and scale

#### `watchDiffFile` / `diffChangelistStream`

For large files or CLs, expose:

```typescript
watchDiffFile(options): P4OperationHandle<...>  // stream stdout chunks
diffChangelistStream(change, { concurrency?: 3 }): AsyncIterable<P4FileDiffResult>
```

Pattern: copy `watchPreviewReconcile` / electroswag’s `client.watch(["sync", ...])` usage.

#### `fstat(fileSpec)` (P2)

Returns `headRev`, `haveRev`, `fileSize` — helps UI show “diff against #have”.

#### `filelog(depotFile, { max? })` (P2)

For submitted CL history / future “diff between two revs” via `diff2`.

---

### Phase 3 — `diff2` (P3, optional)

```bash
p4 diff2 -du //depot/file#1 //depot/file#2
```

For comparing two depot revisions (submitted CL review across versions). Lower priority than pending CL workspace diffs.

---

## Testing requirements

### Unit tests (`packages/core/tests/client.test.ts`)

Mock `executor` / `streamExecutor` on `P4Client` (existing pattern). Add cases for:

1. `describeChangelist` — parse tagged JSON and plain output
2. `diffFile` — exit code 0 (no diff) and 1 (has diff); binary skip
3. `printFile` — text content; binary flag
4. `parseUnifiedDiff` / `summarizeUnifiedDiff` — fixture strings in test file
5. `getChangelistDiffSummary` — does not call diff when `includeLineCounts` false

### E2E (`packages/core/tests/e2e/`, `P4_TS_E2E=1`)

Add scenario against `packages/test-stream` seed:

1. Open a file for edit in seeded workspace
2. `describeChangelist` returns expected file
3. `diffFile` returns non-empty unified diff after workspace edit
4. `printFile` returns depot content at have rev

Follow naming: `scenarios.diff.test.ts` or extend existing scenario files.

### Regression

Run before PR:

```bash
cd packages/core
bun run typecheck
bun test tests/*.test.ts
# optional:
P4_TS_E2E=1 bun test tests/e2e
bun run build
```

---

## API design constraints

1. **Read-only** — no mutating p4 commands in new methods.
2. **Tagged JSON vs plain text** — use `runTaggedJson` for `describe`, `fstat`, `filelog`; use `run`/`watch` for `diff`/`print` (plain text).
3. **Exit codes** — document `p4 diff` exit 1; use `allowNonZeroExit`.
4. **Timeouts** — inherit `timeoutMs` from client; recommend electroswag use **30_000+** for diff ops (their snapshot timeout is 1500ms).
5. **Concurrency** — if batching diffs, default `concurrency: 3` (codiff preloads 3 sections).
6. **Types** — export everything from `packages/core/src/public/index.ts` and `types.ts`.
7. **Docs** — TypeDoc on new public methods; Starlight page if www package documents API surface.
8. **Version** — bump minor version (0.5.0) for new API; electroswag will bump dependency.

---

## Suggested implementation order (checklist)

- [ ] Read `AGENTS.md` / `CLAUDE.md` in repo root
- [ ] Add types to `types.ts`
- [ ] Implement `describeChangelist` in `client.ts`
- [ ] Implement `printFile` in `client.ts`
- [ ] Implement `diffFile` in `client.ts` (handle exit code 1)
- [ ] Add `parseUnifiedDiff` / `summarizeUnifiedDiff` / `isBinaryP4Type` to `helpers.ts`
- [ ] Implement `getChangelistDiffSummary` compose method
- [ ] Mirror in `service.ts` (Effect layer)
- [ ] Export from `index.ts`
- [ ] Unit tests with mocked CLI
- [ ] E2E scenario (if fixture supports edit + diff)
- [ ] Bump version, build, `npm pack --dry-run`
- [ ] Publish / link into electroswag for integration PR (separate agent)

---

## Electroswag integration contract (for downstream agent)

Once p4client-ts 0.5.x is available, electroswag should:

| RPC method | p4client-ts call |
|---|---|
| `p4.describeChangelist` | `describeChangelist(change, { client })` |
| `p4.getChangelistDiffSummary` | `getChangelistDiffSummary(change, { client })` |
| `p4.getFileDiff` | `diffFile({ depotFile, localFile })` |
| `p4.getDepotFileContent` | `printFile(depotFile, { revision: "have" })` |

Schemas in `src/shared/p4.ts` should **reuse or mirror** library types (avoid drift).

UI: click CL in `PerforcePage.tsx` → route or panel → `@pierre/diffs` vanilla `VirtualizedFileDiff` in Solid wrapper (see OpenCode `packages/ui/src/pierre/index.ts` for precedent).

---

## Perforce command reference (quick)

```bash
p4 opened -c 12345                    # files in pending CL
p4 describe -s 12345                  # CL metadata + files (submitted too)
p4 diff -du //depot/path.cpp          # workspace vs have rev
p4 print -q //depot/path.cpp#have     # depot content at opened rev
p4 print -q //depot/path.cpp#3        # specific rev
p4 fstat //depot/path.cpp             # headRev, haveRev, type, size
p4 filelog -m 10 //depot/path.cpp     # history
p4 diff2 -du //depot/a#1 //depot/a#3  # depot vs depot
```

**Binary detection:** `type` field contains `binary` or `xb` — common for UE assets.

---

## Open questions (resolve in implementation)

1. **Submitted vs pending CLs** — does `describe -s` work for all pending CLs on your server, or only `opened -c`? Test both; document fallback.
2. **Binary content transport** — base64 in JSON RPC vs “binary not supported, metadata only”. Recommend metadata-only for MVP.
3. **Character encoding** — non-UTF8 text files: return bytes as base64 or replacement chars? Match existing library string handling.
4. **Shelved changelists** — `describe -S` out of scope unless explicitly requested later.

---

## Suggested skills

Invoke these skills in the p4client-ts workspace session:

| Skill | Path | When |
|---|---|---|
| **quality-code** | `~/.claude/skills/quality-code/SKILL.md` | Writing types, parsers, tests |
| **tdd** | `~/.claude/skills/tdd/SKILL.md` | Red-green for `parseUnifiedDiff`, `diffFile` exit codes |
| **handoff** | `~/.claude/skills/handoff/SKILL.md` | When done — hand back to electroswag agent for RPC/UI |
| **diagnose** | `~/.claude/skills/diagnose/SKILL.md` | If e2e diff scenarios fail against real p4d |

---

## References

| Resource | Location |
|---|---|
| Codiff UX reference (Git) | `C:\Users\Ryzen\git\other\codiff` |
| Electroswag P4 service | `C:\Users\Ryzen\git\swag\electroswag\src\main\services\p4-service.ts` |
| Electroswag P4 RPC | `C:\Users\Ryzen\git\swag\electroswag\src\shared\rpc\p4.ts` |
| Electroswag P4 UI | `C:\Users\Ryzen\git\swag\electroswag\src\mainview\routes\PerforcePage.tsx` |
| @pierre/diffs docs | https://diffs.com/docs |
| p4client-ts repo | https://github.com/peculiarnewbie/p4client-ts |
| Installed types (v0.4.0) | `C:\Users\Ryzen\git\swag\electroswag\node_modules\p4client-ts\dist\public\` |

---

## Success criteria

**p4client-ts PR is done when:**

1. `describeChangelist`, `diffFile`, `printFile`, `getChangelistDiffSummary` are public, typed, documented.
2. Unit tests cover diff exit code 1, binary skip, and unified diff parsing.
3. Effect layer exports match `P4Client` methods.
4. Package builds and version bumped (0.5.0).
5. README or AGENTS.md lists new inspection APIs and `p4 diff` exit-code behavior.

Electroswag end-to-end CL diff UI is **out of scope** for this handoff but unblocked once the above ships.
