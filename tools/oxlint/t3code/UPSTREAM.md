# t3code lint rules (vendored)

Four Oxlint rules from [pingdotgg/t3code](https://github.com/pingdotgg/t3code)'s
`oxlint-plugin-t3code`, MIT (see `LICENSE`, copied from the upstream repository root).

- **Source:** `pingdotgg/t3code` at commit `337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`
  (`main` on 2026-11-05).
- **Rules:** `prefer-effect-fn`, `no-inline-schema-compile`, `require-suppression-reason` and
  `no-low-value-comments`, plus `utils.ts`, which `no-inline-schema-compile` imports. The
  plugin is registered as `t3code` in the root `oxlint.config.ts`, with every rule at `error`.
- **Deviations:**
  - Each file starts with a one-line notice naming the source and licence.
  - `index.ts` registers only these four rules.
  - Imports of `@oxlint/plugins` are rewritten to `vite-plus/lint/plugins`, which re-exports the
    same API from the Oxlint that `vite-plus` bundles.
  - `test/utils.ts` is rewritten. Upstream's harness is Effect code on `@effect/vitest` (patched to
    import `vite-plus/test`); this one writes the same fixture config and runs the Oxlint that
    `vite-plus` installs with `spawnSync`, on `vite-plus/test`. The test cases are unchanged.
  - `no-low-value-comments` has no upstream test.
- **Dependencies:** `effect` and `vite-plus`, both root dev dependencies.

`pnpm test` runs the tests as the `lint-rules` project of the root `vite.config.ts`.
