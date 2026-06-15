# p4-ts

Typed TypeScript helpers for working with the Perforce `p4` CLI.

The published package name is `p4client-ts`.

## Scope

`p4-ts` is intended to be a preview-first foundation for custom P4 tooling, with opt-in mutating sync support.

In scope:
- Inspect current P4 environment and workspace state
- List local or relevant workspaces
- Inspect pending changelists and opened files
- Preview reconcile operations
- Preview sync operations and apply sync when the caller explicitly opts in
- Read file metadata and depot/local path mappings

Out of scope:
- `submit`
- `shelve` or `unshelve`
- `edit`, `add`, `delete`, or other checkout/open-for-edit flows
- `revert`, `lock`, `unlock`, `move`, `integrate`, or `resolve`
- Changelist creation or mutation
- Server administration or any workflow that mutates server-side state

`sync()` is the only workspace-content mutation currently exposed, and the recommended pattern is still `previewSync()` first, then `sync()`. `setClient()` / `switchWorkspace()` only update the local `P4CLIENT` setting and clear this client's cached environment/workspace state.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`packages/core`](./packages/core) | Runtime library for running and parsing `p4` commands | Available |
| [`packages/test-stream`](./packages/test-stream) | Canonical fixture stream content for end-to-end testing | Available |
| [`packages/www`](./packages/www) | Astro Starlight docs app with generated API reference | Available |

## Install

```bash
npm install p4client-ts
```

## Documentation

The repository includes a Starlight docs site in `packages/www` with authored guides and TypeDoc-generated API pages sourced from `packages/core/src/public/index.ts`.

Run the docs site locally:

```bash
bun run docs:dev
```

Build the static docs site:

```bash
bun run docs:build
```

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
bun run docs:build
```
