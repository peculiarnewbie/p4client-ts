// Published guide examples; typechecked by the repository.
import { Effect } from 'effect';
import { P4 } from '../../src/index.js';
import { layerTest } from '../../src/testing/index.js';

const program = Effect.gen(function* () {
  const p4 = yield* P4;
  return yield* p4.listOpenedFiles({});
});
const result = await Effect.runPromise(program.pipe(Effect.provide(layerTest({
  listOpenedFiles: () => Effect.succeed({ items: [], messages: [] }),
}))));

import { Layer } from 'effect';
import { configLayer } from '../../src/index.js';
import { readWireFixture, replayExecutor } from '../../src/testing/index.js';

const fixture = readWireFixture('./tests/fixtures/opened-empty.json');
const replayLayer = P4.layer.pipe(Layer.provideMerge(Layer.merge(
  configLayer({}),
  replayExecutor([fixture], { chunkSize: 7 }),
)));
const replayed = await Effect.runPromise(program.pipe(Effect.provide(replayLayer)));

import { createP4ClientFromLayer } from '../../src/promise/index.js';
import type { P4ClientOptions } from '../../src/index.js';

const derive = (options: P4ClientOptions) => P4.layer.pipe(Layer.provideMerge(Layer.merge(
  configLayer(options), replayExecutor([fixture]),
)));
const promiseClient = createP4ClientFromLayer(derive({}), derive);
try {
  const replayedOpened = await promiseClient.listOpenedFiles({});
  console.log(replayedOpened.items, replayedOpened.messages);
} finally { await promiseClient.dispose(); }

import { withP4Client } from '../../src/promise/index.js';

const scopedOpened = await withP4Client({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws' },
}, (scoped) => scoped.listOpenedFiles({}));
