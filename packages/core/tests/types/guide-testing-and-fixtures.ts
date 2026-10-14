// Typechecked examples from packages/www/src/content/docs/guides/testing-and-fixtures.mdx.
import { Effect } from 'effect';
import { P4 } from '../../src/index.js';
import { layerTest } from '../../src/testing/index.js';

const program = Effect.gen(function* () {
  const p4 = yield* P4.asEffect();
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
