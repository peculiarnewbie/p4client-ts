# @p4-ts/test-stream

Canonical fixture content for seeding a real Perforce stream during `p4-ts` end-to-end testing.

## Purpose

This package is not a runtime dependency. It exists so `p4-ts` can test against a known stream shape and a stable set of files without embedding fixture data directly into the test code.

## What It Contains

- `stream-manifest.json`: the intended stream identity and workspace assumptions
- `scenario-manifest.json`: named e2e scenarios the harness can apply or verify
- `seed/`: the canonical depot file tree to populate into the test stream

## Intended E2E Flow

The repository's E2E runner performs this flow automatically:

```bash
bun run test:e2e
```

It creates a temporary localhost p4d, provisions the stream and workspace, seeds the files in `seed/`, runs the scenarios, and removes the temporary server and workspace.

## Non-goals

- This package does not create or mutate Perforce streams by itself.
- This package does not submit or open files for edit.
- This package only defines fixture content and scenario metadata; the E2E runner owns Perforce provisioning and cleanup.
