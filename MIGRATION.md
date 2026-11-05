# Migrating

See the complete [package migration guide](packages/core/MIGRATION.md).

- **0.13 → 0.14:** typed changelist, edit, add and revert operations replace raw
  `p4` mutations; `setPersistentWorkspace` replaces an app-owned `p4 set P4CLIENT`;
  `materializeDepotFiles` results gain `bytes`, `method` and `stats`.
- **0.11 / 0.12 → 0.13:** the old → new operation map, envelopes, watches, binary
  printing and view exclusions, the exact `file` / `fileSpec` renames, inclusive
  changelist cursors, and a pnpm recipe for apps whose workspace root still pins a
  beta `effect`.
