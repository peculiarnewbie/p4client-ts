// Typechecked examples from packages/www/src/content/docs/index.mdx.
import { createP4Client } from '../../src/promise/index.js';

const client = createP4Client({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws' },
});
try {
  const pending = await client.listChangelists({ status: 'pending' });
  console.log(pending.items, pending.messages);
} finally {
  await client.dispose();
}
