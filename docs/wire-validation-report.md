# Perforce wire validation

Validation started on 2026-10-13 and completed on 2026-10-14 on Windows with Bun
1.4.2. The recorded CLI is `P4/NTX64/2026.1/3089746`. The inventory is in
[wire-inventory.md](wire-inventory.md).

The corpus contains 112 captures from disposable localhost servers and three
explicitly synthetic fixtures. Each capture records its argument vector, output
mode, charset, exit status, stdout, stderr and JSON data/message row classification.
Private byte-preserving captures are in the ignored `.captures/disposable/` folder;
committed fixtures replace temporary roots and ports with placeholders. Marshal
captures preserve the binary output as base64. No production output is a fixture.

## Reproduction and evidence

Run `bun run wire:capture` to regenerate the disposable corpus. It creates its own
Unicode-enabled server, depot, stream, workspace, second client and authentication
settings; every CLI invocation verifies the fixture endpoint and passes it as an
explicit global `-p`. Cleanup removes the server and its scratch files. The
ordinary `bun run test:e2e` runner uses a separate disposable non-Unicode fixture.
Neither runner uses configured production connection settings.

The original Windows binary pins failed before the server started. Both new pins
were verified against Perforce's published
[Windows SHA256SUMS](https://ftp.perforce.com/perforce/r26.1/bin.ntx64/SHA256SUMS).
Hash verification remains mandatory; mismatching cached/downloaded binaries are
refused. The upstream release directory changes when Perforce publishes updates.

Before/after claims for the identified regressions were checked by replaying
committed disposable captures against a private source snapshot of `origin/main`
at `0cea5a1` and the changed implementation. Normal command families also have
live E2E coverage. The before/after replay never launched `p4`.

| Command / case | What the recorded CLI sends | Before | Now |
| --- | --- | --- | --- |
| `sync -n`, opened file behind head | Two stdout JSON records: `data`/`level: 0`, then `data`/`level: 1`; no `severity` or file fields; exit 0 | `P4ParseError` from the sync file schema | Zero file rows; retained `opened_unchanged` and `resolve_required` messages |
| `sync` / watched sync, same case | Same OutputInfo records | Buffered sync failed; watched sync discarded info | Buffered results retain messages; watched operations emit `message` events and retain final messages |
| `sync -n`, up to date | `severity: 2`, `generic: 17`, `code0`, `fmt0`, `severityformat`; exit 0 | Warning discarded | Empty items with typed `up_to_date` warning |
| `sync`, writable clobber | A file row followed by severity 3 / generic 34 error; exit 1 | Partial items and per-file errors | Same partial-result contract, plus full classified message metadata |
| `sync`, expired ticket | Severity 3 / generic 4 message; exit 1 | Mistakenly returned as a per-file sync error | Fatal `P4CommandError`, category `authentication`, reason `ticket_expired` |
| `changes`, no login / expired login | Distinct password-invalid/unset and session-expired messages | Command error with coarse authentication category | Specific `not_logged_in` / `ticket_expired` reasons |
| `sync -n`, unknown client | Severity 3 / generic 2; exit 1 | Coarse client error | `unknown_client` reason |
| `sync -n` / `where`, invalid namespace or outside view | `must refer to client` or `not in client view` message | View warnings could be silently treated as empty | Typed `not_in_view` failure, including warning-level variants |
| `files`, missing file | Severity 2 / generic 17; exit 0 | Browse returned empty but discarded message; print metadata parsing failed | Empty listing or empty print content with retained warning |
| `files`, bad revision syntax | Severity 3 / generic 1; exit 1 | Coarse command error | Category `revision`, reason `unknown_revision` |
| `files`, nonexistent numeric revision | Severity 2 / generic 17; exit 0 | `P4ParseError` when used as print metadata | Typed `unknown_revision` failure |
| `files @=change`, no files at changelist | Severity 2 / generic 17 | Unhandled in generic typed workflows | Empty data with retained message |
| `describe -s`, unknown changelist | Severity 2 / generic 17; exit 0 | `P4ParseError` from missing `change` | Typed `unknown_changelist` failure |
| `describe -s`, 1001 files | One JSON object with indexed `depotFileN`, `actionN`, `typeN`, `revN` | Indexed representation supported | 1001 validated files; indexed-row failures retain original record and command context |
| `describe -S -s`, shelf / empty shelf | Metadata plus indexed shelved files, or metadata alone | Normal shelves supported | Both forms validated; empty shelf produces no invented file or message |
| `changes -l`, long CRLF description | Full description string with embedded CRLF, over 10,000 characters | Description shape supported | Full interior content preserved and regression checked |
| `changes path @cursor` | Independent query groups, including newer changes and duplicate changelists | Cursor did not constrain `path`; pagination could repeat/skip results | Cursor appended to each filespec; grouped results deduplicated and sorted before paging |
| `opened`, no matches | Empty stdout; exit 0 | Empty result supported | Empty result; no fabricated warning |
| `opened`, reserved filename | Depot/client paths use `%40`, `%23`, `%25`; physical path from `where`/`fstat` is unescaped | Client syntax could be misread as a local UNC path; escapes survived into local filenames | Client/depot syntax retained; derived local path decodes the four Perforce escapes exactly once |
| `fstat -T`, selected fields | Server returns only requested fields | Omitting `depotFile` caused a parse error | Library always includes `depotFile` in field selection |
| `fstat`, exclusive/concurrent open | `otherOpenN`, empty-valued `otherLock` and `otherLockN`, `binary+l` | Presence fields supported | Confirmed against real fixture; empty lock markers retained in derived lock state |
| `fstat`, Unreal asset, server-only context | Head metadata and other-open fields; optional local/have fields absent | Optional fields supported | Guarded real-server record accepted without requesting digest/size computation |
| `filelog -i -l`, move ancestry | Multiple depot records with indexed revisions and integration tags | Ancestry merge supported | Recorded move/delete and move/add lineage accepted |
| `annotate -q -c [-I]` | Header, then content rows with `upper` and `data` containing CRLF | Content rows supported; diagnostics handled separately | Content remains data; warning/error partitioning is shared and unknown rows are rejected with context |
| `dirs`, empty directory | Empty stdout on this CLI | Empty result supported | Empty result without invented message; legacy warning form also supported |
| `users`, unknown user | Severity 2 / generic 17; exit 0 | Silently returned empty array | Typed `unknown_user` failure |
| `depots`, `clients`, `streams`, normal/empty | Tagged data objects or no records | Normal schemas supported | Confirmed by disposable captures and live E2E queries; messages cannot reach data schemas |
| `stream -o`, import paths | Indexed `PathsN` including an import mapping | No built-in stream-spec API | Raw capture documents shape; `listStreams` still returns stream summaries |
| `diff -du`, not opened | Empty stdout, warning on stderr, exit 0 | Warning discarded | Empty diff with retained `not_opened` message |
| `diff2 -du`, invalid revision | Empty stdout, diagnostic on stderr, exit 1 | Returned as a successful empty diff | Typed revision error; exit-one compatibility requires an actual unified patch and empty stderr |
| `print -q`, missing file | Empty stdout, warning on stderr, exit 0 | Metadata failure or successful-looking missing materialization | Empty print result retains warning; materialization raises a typed error instead of claiming a download |
| `print -q`, utf16 | Translated text on stdout; CRLF retained | Text path supported | Confirmed; binary detection does not misclassify utf16 |
| `reconcile -n [-m] [-w]`, clean / changed | Empty warning or add/edit/delete records | Basic actions supported, warnings discarded | Typed empty warning preserved; data grouped after message partitioning |
| `-I ... reconcile -n` | JSON records; this build emits no separate progress in the recorded case | Progress fallback supported | Shared final message validation; old-version unsupported-progress fallback remains covered by existing synthetic tests |
| `status -n` / `have`, empty | Preview/no-client-file diagnostic forms | Raw API only | Captured as raw command shapes; no invented high-level APIs |
| Unicode server, disabled client charset | Severity 3 / generic 36; exit 1 | Generic command failure | Typed `charset` failure |
| Server unreachable with `-Mj` | Empty stdout; plain transport error on stderr | Connection error | Connection category with specific `server_unreachable` reason |
| Timeout | Child killed before completion; partial capture and stop reason | `P4TimeoutError` supported by command adapter | Existing command timeout regressions pass; byte-capture guard records timeout and exit |
| Truly malformed JSON/data/message | Invalid required fields, invalid numeric fields or unknown data rows | Parse failure, usually row only | `P4ParseError` retains offending row, schema cause, executable and redacted arguments |

Normal reserved names, spaces, deleted heads, `binary+l`, `binary+F`, `utf16`,
symlinks, shelves, explicit locks, concurrent clients and resolve-required state
were produced on the disposable server. The collector also records the failed
exclusive edit, although edit is not a built-in read API. No write scenario used
the production server.

## Output-mode differences

| Callback / mode | `-ztag` | `-Mj -z tag` | `-G` |
| --- | --- | --- | --- |
| File data | Text tag records | JSON object; no required `code` field | Marshal dictionary with byte keys/values and `code: stat` |
| OutputInfo | Plain text; level 1 appears with a leading ellipsis | `data` and numeric `level`; no `severity` | `code: info`, numeric `level`, byte `data` |
| Warning/error | Plain diagnostic, often stderr | Stdout JSON `data`, `severity`, `generic`, optional extra message tags | `code: error` even for severity-2 warnings; numeric severity/generic |
| Transport failure | Plain stderr | Still plain stderr, despite JSON mode | Transport diagnostic handling is not guaranteed to become a marshalled record |

The marshal examples were decoded with Python's standard `marshal` module, not
treated as UTF-8 strings. Recorded JSON record separators are LF; plain/tagged
Windows output uses CRLF. Embedded annotate/description line endings are preserved.
Perforce documents the callback distinction in
[OutputInfo](https://help.perforce.com/helix-core/apis/p4api/2024.2/Content/P4API/clientuser.outputinfo.html)
and [Message](https://help.perforce.com/helix-core/apis/p4api/2024.2/Content/P4API/clientuser.message.html).

## Production read audit

The guard was written and its original 75 refusal/allowlist tests passed before
the first production command. It now also tests lock cleanup after launch failure.
All production commands were run through `prod-readonly-p4.ts` with explicit
identity, a temp cwd, isolated config/aliases/enviro, reviewed flags, a shared
cross-process lock, a 30-second deadline and a capture byte limit. The guard
permits `-c` only on the approved workspace-dependent command families. Print
destinations must be inside scratch and pass physical-parent/link checks.

The private log has **11 starts, 11 exits, zero overlaps and zero forbidden
commands**: info (1), client spec reads (3), opened (2), clients (2), fstat (1),
changes (1), describe (1). Two early reads recorded a charset mismatch before
the connection charset was corrected. There were no production sync commands,
no whole-depot metadata queries and no digest queries. A single real asset stat
and a one-file real describe were confirmed. Every command is in the private
scratch log and its ignored `.captures/production-commands.jsonl` copy.

Reproduce the audit without executing p4:

```powershell
bun packages/core/scripts/audit-prod-readonly-log.ts packages/core/.captures/production-config.json
```

The auditor revalidates every logged argument vector through the current guard,
including preview/spec flags, bounds and output paths. The additional forbidden
command grep over the copied log returned no matches:

```powershell
rg '"command":"(submit|edit|add|delete|move|copy|integrate|merge|resolve|revert|shelve|unshelve|lock|unlock|reopen|change|changelist|fix|label|labelsync|tag|obliterate|archive|restore|retype|undo|cherry-pick|group|protect|triggers|typemap|branch|job|counter|key|admin|configure|flush|clean|login|logout|passwd|trust)"' packages/core/.captures/production-commands.jsonl
```

## Consumer migration and gaps

- Electroswag can remove its historical OutputInfo patch after consuming a release
  containing this change. This task does not publish that release or modify the
  consumer repository.
- Read `result.messages` and handle the new watched-sync `message` event. Show
  resolve-required notices separately from completed file counts. The inspected
  consumer loop currently handles only `progress` events and per-file failures.
- Array results carry non-enumerable `messages` metadata. Extract it before
  JSON/RPC serialization or `map`/spread operations; object results include an
  enumerable `messages` field when non-empty. Update consumer schemas if they
  discard unknown object fields.
- Error switches should account for the new categories and use `reason` for
  specific cases. `whereFiles` now raises `not_in_view` instead of treating that
  failure as a silently empty mapping. `runTaggedJson` returns data rows with
  message metadata; raw `run` plus `parseP4JsonLines` remains available when a
  caller needs the original mixed record stream.
- Changelist pagination now attaches a cursor to each filespec. Combining
  `beforeChange` with an already revision-qualified filespec is rejected rather
  than constructing an ambiguous query.
- No matching local stream workspace was found by the bounded production client
  query or its host-name filter. Production `sync -n` was therefore not attempted;
  the exact opened-file case is recorded and exercised live on the disposable
  server. A large production changelist was not identified in the bounded read;
  the 1001-file case is fully disposable.
- Direct non-ASCII pathname arguments and wildcard add attempts failed on this
  Windows CLI, including with a Unicode-enabled server. Unicode path validation
  is covered by an explicitly synthetic fixture. The system locale was not
  changed. Literal asterisk filenames cannot be seeded on this Windows filesystem;
  `%2A` is likewise synthetic. The other three reserved characters are recorded.
- A derived opened-file local path still assumes an explicitly supplied `cwd` is
  the workspace root. For cross-client queries, subdirectory cwd, or authoritative
  UNC resolution, use `whereFiles` and its physical `path` instead of treating that
  derivation as a server-provided path.
- There are no built-in property APIs in this checkout. `property -l` is recorded
  as a raw empty query. Host-setting mutations through `setClient` are unit mocked;
  changing a localhost server does not isolate Windows registry writes.
- Other platforms, other CLI/server versions, external diff tools, custom broker
  messages, LDAP/SSO and every possible protection/plugin configuration were not
  exhaustively reproduced. Unknown valid messages are retained; malformed data
  remains an error. Existing materialization symlink-containment and output/cache
  priorities in `AUDIT.md` are outside this protocol change.

## Final checks and privacy

- Strict typecheck, including script and new fixture-test types: passed.
- Unit tests: 363 passed; guard tests and recorded-fixture regressions included.
- Disposable E2E tests: 17 passed, including live OutputInfo and cursor regressions.
- Core build, generated API/site documentation check, package dry run and `git diff --check`: passed.
- Production log replay and forbidden-command grep: zero violations.
- Before each commit, the staged diff was scanned for the handoff's six private
  identifiers/endpoint markers. The history check below also returned zero
  matches. Regex character classes spell the same patterns without putting the
  literal private markers in this public report:

```powershell
$privatePattern = '(?i)s[t]airway|c[h]knpig|M[a]naBreak|A[r]if|ss[l]:|16[6]6'
git diff --cached | rg -n $privatePattern
git log -p origin/main..HEAD | rg -n $privatePattern
```

All private capture/config/log directories are ignored and untracked. Public fixtures
contain only disposable identities or explicitly invented synthetic values.
No npm publication, production mutation or direct push to main was performed.
