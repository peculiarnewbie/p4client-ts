// Published guide examples; typechecked by the repository.
import { Effect } from 'effect';
import { P4 } from '../../src/index.js';
import { layerNode } from '../../src/node/index.js';

const program = Effect.gen(function* () {
  const p4 = yield* P4;
  const environment = yield* p4.getEnvironment({});
  const pending = yield* p4.listChangelists({ status: 'pending' });
  return { environment, pending };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(layerNode({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws' },
}))));

const inOtherWorkspace = program.pipe(
  P4.with({ connection: { client: 'review_ws' } }),
  Effect.provide(layerNode({ connection: { port: 'ssl:perforce:1666' } })),
);

import { Stream } from 'effect';

const watched = Effect.gen(function* () {
  const p4 = yield* P4;
  return yield* p4.watch.previewReconcile({ fileSpec: '...' }, {
    progressIntervalMs: 250,
  }).pipe(Stream.runCollect);
});
