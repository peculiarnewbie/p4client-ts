// Typechecked examples from packages/www/src/content/docs/guides/getting-started.mdx.
import { createP4Client } from '../../src/promise/index.js';
import { printedText } from '../../src/index.js';

const client = createP4Client({
  cwd: '/work/project',
  connection: {
    port: 'ssl:perforce:1666',
    user: 'alice',
    client: 'alice_ws',
    isolated: true,
  },
  timeoutMs: 30_000,
});
try {
  const environment = await client.getEnvironment({});
  const opened = await client.listOpenedFiles({});
  const printed = await client.printFile({ file: '//depot/main/README.md' });
  console.log(environment.client, opened.items, printedText(printed));
} finally {
  await client.dispose();
}

const writable = client.with({ allowMutation: true });
try {
  const preview = await client.previewSync({ fileSpec: '//depot/main/...' });
  if (preview.items.length > 0) {
    const synced = await writable.sync({ fileSpec: '//depot/main/...' });
    console.log(synced.items, synced.failures);
  }
} finally {
  await writable.dispose();
}

const controller = new AbortController();
const handle = client.watch.previewSync({
  fileSpec: '//depot/main/...',
  progressIntervalMs: 250,
  signal: controller.signal,
});
for await (const event of handle.events) {
  if (event._tag === 'progress') console.log(event.progress);
  if (event._tag === 'failure') console.log(event.failure);
}
const result = await handle.result;
console.log(result.items);

import { Schema } from 'effect';

const rows = await client.runTagged({
  args: ['files', '//depot/main/...'],
  schema: Schema.Struct({ depotFile: Schema.String }),
});
console.log(rows.items.map((row) => row.depotFile));
