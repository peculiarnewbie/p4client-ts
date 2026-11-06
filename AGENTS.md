# Agent Guidelines for p4-ts

This document provides essential information for AI agents working in the p4-ts repository.

## Project Overview

A TypeScript monorepo providing typed helpers for the Perforce `p4` CLI, built with the
[Vite+](https://viteplus.dev) stack: pnpm, `vp test` (Vitest), Oxlint and `vpx` for scripts.

**Package Manager:** pnpm 12 (`packageManager` in the root `package.json`)  
**Toolchain:** `vite-plus` 1.4.0, on Node.js 22.18+, 24.11+ or 26+  
**Library runtime:** Node.js >= 18  
**Main Package:** `p4client-ts` (in `packages/core`)

## Build/Lint/Test Commands

All commands run from repo root:

```bash
# Install dependencies
pnpm install

# Type checking (strict TypeScript)
pnpm typecheck

# Effect-aware lint (see below)
pnpm lint

# Build the core package
pnpm build

# Run all unit tests (core and the vendored lint rules)
pnpm test

# Run a single test file
pnpm vp test run packages/core/tests/unit/commands/files.test.ts

# Run e2e tests
pnpm test:e2e

# Documentation check (checks and builds the guides)
pnpm docs:check

# Clean build artifacts
pnpm clean

# Pack check for npm publishing
pnpm pack:core
```

Scripts in `packages/core/scripts` run with `vpx <file>.ts`, which strips types and resolves the
`.js` imports to their `.ts` sources. Tests import from `vite-plus/test`, never `vitest`.

### TypeScript and Effect diagnostics

Lint configuration lives in the root `oxlint.config.ts`, which extends the `@effect/tsgo`
recommended preset and is also the `lint` block of `vite.config.ts`. `pnpm lint` and
`pnpm lint:fix` run the Oxlint that `vite-plus` installs through `effect-tsgo oxlint`, which
swaps in the Effect-patched binary and reads `oxlint.config.ts`. Use them, not `vp lint`: stock
Oxlint cannot load the preset's `effecttsgo` plugin, and raw Oxlint cannot load `vite.config.ts`. Correctness errors fail the
gate, which CI runs; suggestions stay warnings. `pnpm lint:fix --fix-suggestions` applies
suggested simplifications. New code must lint without errors; fix findings in code rather
than disabling rules.

The same block enables every rule of anti-slop, vendored from upstream under
`tools/oxlint/anti-slop/` (see its `UPSTREAM.md`), as errors. Fix its findings in code;
where that isn't possible, use a one-line `oxlint-disable-next-line <rule> -- <reason>`
directly above the line. Tests, type tests and scripts each have a `tsconfig.json`, so
they are linted with their own compiler settings.

`pnpm tsrs --noEmit -p packages/core/tsconfig.json` runs the installed Rust compiler.
Builds and `typecheck` keep using `tsc`. `vite-plus` pins `oxlint` and `oxlint-tsgolint`, so
keep `vite-plus`, `@effect/tsgo` and `tsrs` on versions listed together in the
[upstream compatibility table](https://github.com/Effect-TS/tsgo#supported-package-versions)
for the installed `@effect/tsgo` version; upgrade them together, never one alone.

## Code Style Guidelines

### Imports
- Always use `.js` extensions for local imports (e.g., `import { foo } from "./bar.js"`)
- Use `node:` prefix for Node.js built-ins (e.g., `import { spawn } from "node:child_process"`)
- Group imports: external deps first, then internal modules, then types
- Use `import type` for type-only imports

### Formatting
- 2-space indentation
- Single quotes for strings
- Semicolons required
- Max line length: follow existing patterns (~100 chars)

### Types & Naming
- Strict TypeScript enabled (`strict: true`, `noUncheckedIndexedAccess: true`)
- Use `PascalCase` for types, interfaces, and classes
- Use `camelCase` for functions, variables, and properties
- Use `SCREAMING_SNAKE_CASE` for constants
- Prefix private class members with underscore (e.g., `_privateMethod`)
- Avoid `any`; use `unknown` when type is uncertain
- Use explicit return types on public API methods
- No JSDoc tags (`@param`, `@returns`, `@throws`): types and Effect Schemas are the reference

### Error Handling
- Create custom error classes extending `Error` for domain-specific failures
- Include structured error categories for classification (see `P4ErrorCategory`)
- Preserve original error context in error properties
- Use pattern matching for error classification from CLI output

### Testing
- Uses Vitest through `vite-plus/test` (`vp test`), configured in the root `vite.config.ts`
- Test files: `*.test.ts` alongside source or in `tests/` directory
- E2E tests in `tests/e2e/` using test fixtures
- Mock external dependencies (CLI calls) in unit tests
- Use descriptive test names in `describe`/`it` blocks

### Project Structure
```
packages/
  core/           # Main library (p4client-ts)
    src/
      public/     # Public API exports
      internal/   # Implementation details
    tests/
      e2e/        # End-to-end tests
  test-stream/    # Test fixtures
  www/            # Astro Starlight documentation
```

### Key Conventions
- Read-only operations only (no submit, edit, or mutation)
- Preview-first approach (`-n` flag for dry runs)
- **MUST use Effect library** for all async operations and functional patterns
- **MUST use Effect Schema** for runtime validation and data transformation
- JSON output parsing from `p4 -Mj -z tag` commands
- Caching in P4Client instance (respect `refresh` option)
- Always export from `src/public/index.ts` for public API

### Effect Library Guidelines
- Wrap all async operations in `Effect.promise()` or use Effect-based APIs
- Use Effect's error channel for explicit error handling
- Prefer Effect's `pipe()` and `flatMap()` for composable workflows
- Use `Effect.runPromise()` at the application boundary to execute effects

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

Always use the repository wrapper; do not invoke a globally installed `effect-solutions` executable directly on Windows. The wrapper invokes the bundled CLI because the upstream launcher has no Windows target.

1. Run `pnpm effect:solutions list` to see available guides
2. Run `pnpm effect:solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

### Documentation
- There is no generated API reference. The types and Effect Schemas are the reference, and
  the guides in `packages/www` explain how to use them.
- Comments say what the code can't: a constraint, a reason or a failure condition, in 4 lines
  or fewer (`t3code/no-low-value-comments`). No JSDoc tags.
- Keep guide examples practical and relevant to Perforce workflows
