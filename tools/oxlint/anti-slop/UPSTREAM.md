# anti-slop (vendored)

Oxlint rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), MIT (see `LICENSE`).
Upstream ships no package; this copy is owned and maintained here.

- **Source:** `dmmulroy/anti-slop` at commit `13909c9e07590f5a85d93c62712259fe14a883f7`
  (`main` on 2026-11-05).
- **Installed with:** that commit's `skills/install-anti-slop/scripts/install.mjs`, which copies
  `skills/install-anti-slop/assets/anti-slop/` here. Those assets are identical to upstream `src/`
  at the same commit, without its `*.test.ts` files.
- **Paths:** `index.ts` (generic plugin, `anti-slop`) and `effect/index.ts` (Effect plugin,
  `anti-slop-effect`), registered in the root `oxlint.config.ts` with every rule at `error`.
- **Deviations:** `LICENSE` copied from the upstream repository root; the skill's assets don't
  include it. Imports of `@oxlint/plugins` are rewritten to `vite-plus/lint/plugins`, which
  re-exports the same API from the Oxlint that `vite-plus` bundles; rule logic is unchanged.
- **Dependencies:** none of its own; `vite-plus` provides Oxlint and its plugin API.

To update, follow upstream's `skills/install-anti-slop/references/update.md` from the commit
above, and update this file.
