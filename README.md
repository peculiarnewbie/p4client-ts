# p4client-ts

Typed helpers for the Perforce `p4` CLI, with an Effect core and an immutable
Promise facade. Requires Node >=18, a local `p4` executable for live commands,
and the Effect peer dependency.

```sh
pnpm add p4client-ts effect@4.0.4
```

```ts
import { createP4Client } from 'p4client-ts/promise';
import { printedText } from 'p4client-ts';

const client = createP4Client({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws', isolated: true },
});
try {
  const opened = await client.listOpenedFiles({});
  const file = await client.printFile({ file: '//depot/main/README.md' });
  console.log(opened.items, opened.messages, printedText(file));
} finally {
  await client.dispose();
}
```

All methods take one options object. Lists return enumerable envelopes;
batch operations add `failures`. `client.watch.<operation>` returns
`{ events, result }`, with items, messages, failures, progress and a final done event.
Pass an AbortSignal to cancel. Dispose every client, including clients from `with`.

Mutation is disabled by default. Preview with `previewSync`, `previewReconcile`,
`previewOpenForEdit`, `previewOpenForAdd` or `previewRevert`; derive a client with
`with({ allowMutation: true })` to sync, create and delete changelists, open files for
edit or add, and revert. There is no submit: the user submits pending changelists.
Clients have no caches and never write `p4 set` implicitly; only the explicit
`setPersistentWorkspace` in `p4client-ts/node` does, and it changes the user's
persistent Perforce settings.

The root entry exports the platform-neutral Effect service, operations, types,
schemas and error codec. Use `p4client-ts/node` for `layerNode` and filesystem helpers,
`p4client-ts/promise` for the Promise facade, and `p4client-ts/testing` for mocks,
strict fixture replay and recording.

See the [guides](https://p4client-ts.peculiarnewbie.com/guides/getting-started/)
and [migration guide](./MIGRATION.md) for upgrading from 0.13 and the breaking 0.13 changes.

The pnpm monorepo contains `packages/core` (library), `packages/test-stream`
(live fixtures) and `packages/www` (Astro guides).
Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, `pnpm docs:check`,
`pnpm build` and `pnpm pack:core` from this directory.
