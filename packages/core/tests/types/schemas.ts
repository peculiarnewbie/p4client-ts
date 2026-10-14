import { Schema } from 'effect';
import { Effect, Stream } from 'effect';
import { P4, P4ClientPathSchema, P4DepotPathSchema, P4LocalPathSchema } from '../../src/index.js';
import { createP4Client } from '../../src/promise/index.js';
import type { P4ClientPath, P4DepotPath, P4LocalPath, P4TaggedResult } from '../../src/index.js';
import type { P4Error } from '../../src/errors.js';

// This file is compiled by typecheck, not executed by the unit test runner.
const Row = Schema.Struct({ revision: Schema.NumberFromString });
const client = createP4Client();
const commandRows: Promise<P4TaggedResult<{ readonly revision: number }>> = client.runTagged({
  args: ['files', '//depot/...'], schema: Row,
});
const rawCommand: Promise<P4TaggedResult<unknown>> = client.runTagged({ args: ['info'] });
// @ts-expect-error Raw fields remain unknown without a decoder.
const unsafeRaw: Promise<P4TaggedResult<{ revision: number }>> = rawCommand;
// @ts-expect-error The result contains decoded numbers, not encoded strings.
const encoded: Promise<P4TaggedResult<{ revision: string }>> = commandRows;
// @ts-expect-error Typed commands require a schema.
client.runTagged<{ revision: number }>({ args: ['files'] });
// @ts-expect-error Typed commands cannot infer a narrower type than the schema produces.
client.runTagged<{ revision: string }>({ args: ['files'], schema: Row });

const watch = client.watch.runTagged({ args: ['files'], schema: Row });
const watchedResult: Promise<P4TaggedResult<{ readonly revision: number }>> = watch.result;
const controller = new AbortController();
client.watch.runTagged({ args: ['files'], schema: Row, signal: controller.signal, progressIntervalMs: 100 });

const serviceResult: Effect.Effect<P4TaggedResult<{ readonly revision: number }>, P4Error, P4> =
  Effect.flatMap(P4.asEffect(), (p4) => p4.runTagged({ args: ['files'], schema: Row }));
const serviceWatch = Stream.unwrap(Effect.map(P4.asEffect(), (p4) => {
  // @ts-expect-error A typed service command requires a runtime schema.
  const invalid = p4.runTagged<{ revision: number }>({ args: ['files'] });
  void invalid;
  return p4.watch.runTagged({ args: ['files'], schema: Row });
}));

const revisionNumber = async () => {
  for await (const event of watch.events) {
    if (event._tag === 'item') {
      const revision: number = event.item.revision;
      // @ts-expect-error Watched items are decoded, not encoded.
      const revisionString: string = event.item.revision;
      void [revision, revisionString];
    }
  }
};

const depot: P4DepotPath = Schema.decodeUnknownSync(P4DepotPathSchema)('//depot/file');
const workspace: P4ClientPath = Schema.decodeUnknownSync(P4ClientPathSchema)('//workspace/file');
const local: P4LocalPath = Schema.decodeUnknownSync(P4LocalPathSchema)('file.txt');
// @ts-expect-error Strings require runtime validation before becoming branded paths.
const unvalidated: P4DepotPath = '//depot/file';
// @ts-expect-error Client and depot paths have different semantic identities.
const mixed: P4DepotPath = workspace;
// @ts-expect-error A local path is not a Perforce client-syntax path.
const localAsClient: P4ClientPath = local;

void [unsafeRaw, encoded, commandRows, rawCommand, depot, unvalidated, mixed, localAsClient,
  watchedResult, serviceResult, serviceWatch, revisionNumber];
