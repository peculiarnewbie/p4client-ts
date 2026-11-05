# t3code lint rules (vendored)

Four Oxlint rules from [pingdotgg/t3code](https://github.com/pingdotgg/t3code)'s
`oxlint-plugin-t3code`, MIT (see `LICENSE`, copied from the upstream repository root).

- **Source:** `pingdotgg/t3code` at commit `337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`
  (`main` on 2026-11-05).
- **Rules:** `prefer-effect-fn`, `no-inline-schema-compile`, `require-suppression-reason` and
  `no-low-value-comments`, plus `utils.ts`, which `no-inline-schema-compile` imports. The
  plugin is registered as `t3code` in the root `.oxlintrc.json`, with every rule at `error`.
- **Deviations:**
  - Each file starts with a one-line notice naming the source and licence.
  - `index.ts` registers only these four rules.
  - `test/utils.ts` is rewritten for `bun:test`. Upstream's harness uses `@effect/vitest` and
    `vite-plus`; this one writes the same fixture config and runs the installed `oxlint` with
    `spawnSync`. The tests import `describe` from `bun:test` and `assert` from
    `node:assert/strict`; the cases themselves are unchanged.
  - `no-low-value-comments` has no upstream test.
- **Dependencies:** the rules import `effect` and `@oxlint/plugins`, both root dev dependencies.

Run the tests with `bun test ./tools/oxlint/t3code`; `bun run test` includes them.
