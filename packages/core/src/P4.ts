import { Effect, Layer, Option, Context, Stream } from 'effect';
import { taggedOperation } from './commands/raw.js';
import { P4Config, withOptions } from './engine/config.js';
import { P4OperationEvent, runOperation, watchOperation } from './engine/operation.js';
import { P4Executor } from './exec/executor.js';
import { ops } from './ops.js';
import type { Schema } from 'effect';
import type {
  ListChangelistsOptions, P4ChangelistStatus, P4Changelist, P4ChangelistPage,
} from './commands/changelists.js';
import type { P4TaggedResult, RunTaggedOptions } from './commands/raw.js';
import type { P4ResolvedOptions } from './engine/config.js';
import type { P4Operation, P4WatchOptions } from './engine/operation.js';
import type { P4Error } from './errors.js';
import type { OpItem, OpOptions, OpResult, P4Ops } from './ops.js';

/** A tagged command whose records are decoded by the supplied schema. */
export type TypedTaggedOptions<A> = Omit<RunTaggedOptions, 'schema'> & {
  readonly schema: Schema.Decoder<A>;
};

/** Typed and untyped tagged commands. A schema is required for a typed result. */
export interface P4TaggedMethod {
  <A>(options: TypedTaggedOptions<A>): Effect.Effect<P4TaggedResult<A>, P4Error>;
  (options: RunTaggedOptions): Effect.Effect<P4TaggedResult<unknown>, P4Error>;
}

/** Watched tagged commands retain the schema's item and result types. */
export interface P4TaggedWatchMethod {
  <A>(options: TypedTaggedOptions<A>, watch?: P4WatchOptions):
    Stream.Stream<P4OperationEvent<A, P4TaggedResult<A>>, P4Error>;
  (options: RunTaggedOptions, watch?: P4WatchOptions):
    Stream.Stream<P4OperationEvent<unknown, P4TaggedResult<unknown>>, P4Error>;
}

/** Watched methods generated from the operation registry. */
export type P4WatchService = {
  readonly [K in keyof P4Ops]: K extends 'runTagged' ? P4TaggedWatchMethod :
    K extends 'listChangelists' ? <S extends P4ChangelistStatus>(
      options: ListChangelistsOptions & { readonly status: S }, watch?: P4WatchOptions,
    ) => Stream.Stream<P4OperationEvent<P4Changelist<S>, P4ChangelistPage<S>>, P4Error> :
    (options: OpOptions<K>, watch?: P4WatchOptions) =>
      Stream.Stream<P4OperationEvent<OpItem<K>, OpResult<K>>, P4Error>;
};

/** Effect methods generated from the operation registry. */
export type P4Service = {
  readonly [K in keyof P4Ops]: K extends 'runTagged' ? P4TaggedMethod :
    K extends 'listChangelists' ? <S extends P4ChangelistStatus>(
      options: ListChangelistsOptions & { readonly status: S },
    ) => Effect.Effect<P4ChangelistPage<S>, P4Error> :
    (options: OpOptions<K>) => Effect.Effect<OpResult<K>, P4Error>;
} & { readonly watch: P4WatchService };

/** Methods supplied by a test, with optional watched method overrides. */
export type P4TestOps = Partial<Omit<P4Service, 'watch'>> & {
  readonly watch?: Partial<P4Service['watch']>;
};

/** A registered operation with its types erased; every operation in the registry is one. */
type AnyOperation = P4Operation<never, unknown, unknown>;

/** A service method with its types erased; every method of {@link P4Service} is one. */
type AnyMethod = (options: never) => Effect.Effect<unknown, P4Error>;

/** A watched service method with its types erased; every method of {@link P4WatchService} is one. */
type AnyWatch = (options: never, settings?: P4WatchOptions) => Stream.Stream<P4OperationEvent<unknown, unknown>, P4Error>;

const OPERATIONS: ReadonlyArray<readonly [string, AnyOperation]> = Object.entries(ops);

/** Freeze per-name methods into a service. */
function toService(methods: Record<string, AnyMethod>, watch: Record<string, AnyWatch>): P4Service {
  // SAFETY: both maps hold one method per registry name, each built from (or mocking) the operation
  // registered under that name, plus the runTagged overloads; P4Service is exactly that mapping.
  // TypeScript cannot follow a per-key correlation through a loop over the registry.
  return Object.freeze({ ...methods, watch: Object.freeze(watch) }) as P4Service;
}

/** @internal Build a service bound to one immutable configuration and executor. */
function makeP4Service(config: P4ResolvedOptions, executor: P4Executor['Service']): P4Service {
  // Read config at execution time so a service obtained before P4.with also sees its patch.
  // When the providing layer hides P4Config, the captured config keeps methods self-contained.
  const provide = <A, E>(effect: Effect.Effect<A, E, P4Config | P4Executor>) =>
    Effect.flatMap(Effect.serviceOption(P4Config), (current) => effect.pipe(
      Effect.provideService(P4Config, Option.getOrElse(current, () => config)),
      Effect.provideService(P4Executor, executor),
    ));

  const provideStream = <A, E>(stream: Stream.Stream<A, E, P4Config | P4Executor>) =>
    Stream.unwrap(Effect.map(Effect.serviceOption(P4Config), (current) => stream.pipe(
      Stream.provideService(P4Config, Option.getOrElse(current, () => config)),
      Stream.provideService(P4Executor, executor),
    )));

  const methods: Record<string, AnyMethod> = {};
  const watch: Record<string, AnyWatch> = {};

  for (const [name, op] of OPERATIONS) {
    methods[name] = (options) => provide(runOperation(op, options));
    watch[name] = (options, settings) => provideStream(watchOperation(op, options, settings));
  }

  methods.runTagged = (options: RunTaggedOptions) => provide(runOperation(
    options.schema === undefined ? ops.runTagged : taggedOperation(options.schema), options,
  ));
  watch.runTagged = (options: RunTaggedOptions, settings?: P4WatchOptions) => provideStream(watchOperation(
    options.schema === undefined ? ops.runTagged : taggedOperation(options.schema), options, settings,
  ));

  return toService(methods, watch);
}

/** Perforce operations as a service. Provide an executor and config to build {@link P4.layer}. */
export class P4 extends Context.Service<P4, P4Service>()('p4client-ts/P4') {
  /** Bind every operation to the supplied executor and configuration. */
  static readonly layer: Layer.Layer<P4, never, P4Config | P4Executor> = Layer.effect(P4,
    Effect.gen(function* () {
      return makeP4Service(yield* P4Config, yield* P4Executor);
    }));

  /** Provide only the operations a test expects; an unspecified call dies with its name. */
  static layerTest(partialOps: P4TestOps): Layer.Layer<P4> {
    return Layer.sync(P4, () => {
      const { watch: watchOverrides = {}, ...methodOverrides } = partialOps;
      const mocked = new Map<string, AnyMethod | undefined>(Object.entries(methodOverrides));
      const mockedWatch = new Map<string, AnyWatch | undefined>(Object.entries(watchOverrides));
      const methods: Record<string, AnyMethod> = {};
      const watch: Record<string, AnyWatch> = {};

      for (const [name] of OPERATIONS) {
        const run: AnyMethod = mocked.get(name) ?? (() => Effect.die(new Error(`Unmocked P4 operation: ${name}`)));
        methods[name] = run;
        watch[name] = mockedWatch.get(name) ?? ((options) => Stream.fromEffect(run(options).pipe(
          Effect.map((result) => P4OperationEvent.done({ result })),
        )));
      }

      return toService(methods, watch);
    });
  }

  /** Run a program with patched configuration, including calls on an already obtained P4 service. */
  static readonly with = withOptions;
}
