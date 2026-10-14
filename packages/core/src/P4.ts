import { Effect, Layer, Option, Context, Stream } from 'effect';
import { taggedOperation } from './commands/raw.js';
import { P4Config, withOptions } from './engine/config.js';
import { runOperation, watchOperation } from './engine/operation.js';
import { P4Executor } from './exec/executor.js';
import { ops } from './ops.js';
import type { Schema } from 'effect';
import type {
  ListChangelistsOptions, P4ChangelistStatus, P4Changelist, P4ChangelistPage,
} from './commands/changelists.js';
import type { P4TaggedResult, RunTaggedOptions } from './commands/raw.js';
import type { P4ResolvedOptions } from './engine/config.js';
import type { P4Operation, P4OperationEvent, P4WatchOptions } from './engine/operation.js';
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

// The cast is confined to heterogeneous registry traversal. Public methods retain each op's types.
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
  const methods: Record<string, unknown> = {};
  const watch: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(ops)) {
    const op = entry as P4Operation<unknown, unknown, unknown>;
    methods[name] = (options: unknown) => provide(runOperation(op, options));
    watch[name] = (options: unknown, settings?: P4WatchOptions) =>
      provideStream(watchOperation(op, options, settings));
  }
  methods.runTagged = (options: RunTaggedOptions) => provide(runOperation(
    options.schema === undefined ? ops.runTagged : taggedOperation(options.schema), options,
  ));
  watch.runTagged = (options: RunTaggedOptions, settings?: P4WatchOptions) => provideStream(watchOperation(
    options.schema === undefined ? ops.runTagged : taggedOperation(options.schema), options, settings,
  ));
  return Object.freeze({ ...methods, watch: Object.freeze(watch) }) as P4Service;
}

/** Perforce operations as a service. Provide an executor and config to build {@link P4.layer}. */
export class P4 extends Context.Service<P4, P4Service>()('p4client-ts/P4') {
  /** Bind every operation to the supplied executor and configuration. */
  static readonly layer: Layer.Layer<P4, never, P4Config | P4Executor> = Layer.effect(P4,
    Effect.gen(function* () {
      return makeP4Service(yield* P4Config, yield* P4Executor);
    }));

  /**
   * Provide only the operations a test expects; an unspecified call dies with its name.
   * @param partialOps Effect methods and optional watch overrides.
   * @returns A layer without CLI dependencies. Default watches emit the mock's result as done.
   */
  static layerTest(partialOps: P4TestOps): Layer.Layer<P4> {
    return Layer.sync(P4, () => {
      const methods: Record<string, unknown> = {};
      const watch: Record<string, unknown> = {};
      for (const name of Object.keys(ops)) {
        const method = (partialOps as Record<string, unknown>)[name] as
          ((options: unknown) => Effect.Effect<unknown, unknown>) | undefined;
        const run = method ?? (() => Effect.die(new Error(`Unmocked P4 operation: ${name}`)));
        methods[name] = run;
        watch[name] = (partialOps.watch as Record<string, unknown> | undefined)?.[name] ??
          ((options: unknown) => Stream.fromEffect(run(options).pipe(
            Effect.map((result) => ({ _tag: 'done' as const, result })),
          )));
      }
      return Object.freeze({ ...methods, watch: Object.freeze(watch) }) as P4Service;
    });
  }

  /**
   * Run a program with patched configuration, including calls on an already obtained P4 service.
   * @param patch Connection fields and environment entries merge individually.
   * @returns A transformation scoped to this program; siblings keep their original configuration.
   */
  static readonly with = withOptions;
}
