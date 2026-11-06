import { Effect, Layer, ManagedRuntime, Predicate, Stream } from 'effect';
import { P4 } from '../P4.js';
import { resolveOptions, mergeOptions } from '../engine/config.js';
import { createAsyncEventQueue } from '../internal/async-queue.js';
import {
  layerNode, resolveConnection, findWorkspaceForPath, workspaceRootExists, materializeDepotFiles,
  setPersistentWorkspace,
} from '../node/index.js';
import { runOperation, watchOperation } from '../engine/operation.js';
import { OPERATION_NAMES } from '../ops.js';
import type { ResolveConnectionOptions, P4ResolvedConnection } from '../node/connection.js';
import type { P4Workspace } from '../commands/workspaces.js';
import type {
  MaterializeDepotFilesOptions, P4MaterializeSpec, P4MaterializeResult, P4MaterializedFile,
} from '../node/materialize.js';
import type {
  ListChangelistsOptions, P4ChangelistStatus, P4ChangelistPage, P4Changelist,
} from '../commands/changelists.js';
import type { P4Ops } from '../ops.js';
import type { TypedTaggedOptions } from '../P4.js';
import type { P4TaggedResult, RunTaggedOptions } from '../commands/raw.js';
import type { P4ClientOptions } from '../engine/config.js';
import type {
  P4Context, P4Operation, P4OperationEvent, P4Sink, P4WatchOptions,
} from '../engine/operation.js';
import type { P4Error, P4InvalidArgumentError } from '../errors.js';

const nodeOps = { findWorkspaceForPath, materializeDepotFiles, setPersistentWorkspace };

/**
 * What one facade method runs, with its types erased. Each method receives its operation's options
 * together with the {@link P4PromiseWatchOptions} fields, which operations ignore.
 */
interface FacadeOperation {
  readonly run: (input: P4PromiseWatchOptions) => Effect.Effect<AnyResult, P4Error, P4 | P4Context>;
  readonly watch: (input: P4PromiseWatchOptions) =>
    Stream.Stream<P4OperationEvent<AnyItem, AnyResult>, P4Error, P4 | P4Context>;
}

/** The result of any facade operation. */
type AnyResult = { [K in keyof P4PromiseOps]: Effect.Success<ReturnType<P4PromiseOps[K]['program']>> }[keyof P4PromiseOps];

/** An item any facade operation reports. */
type AnyItem = {
  [K in keyof P4PromiseOps]: Parameters<P4PromiseOps[K]['program']>[1] extends P4Sink<infer I> ? I : never;
}[keyof P4PromiseOps];

type ErasedRun = (input: P4PromiseWatchOptions) => Effect.Effect<AnyResult, P4Error>;

type ErasedWatch = (input: P4PromiseWatchOptions, settings: P4WatchOptions) =>
  Stream.Stream<P4OperationEvent<AnyItem, AnyResult>, P4Error>;

type ErasedOperation = P4Operation<P4PromiseWatchOptions, AnyItem, AnyResult>;

// Each facade method is only ever called with the options of the operation it is named after, plus
// P4PromiseWatchOptions fields the operation ignores, and P4PromiseClient gives each method that
// operation's own types. Erasing to that input lets one loop over the registry build every method,
// because TypeScript cannot correlate a name with its operation's types inside the loop.
const serviceOperation = (name: keyof P4Ops): FacadeOperation => ({
  run: (input) => Effect.flatMap(P4, (service) =>
    // SAFETY: P4[name] takes that operation's options; see above for why the input is erased.
    (service[name] as ErasedRun)(input)),
  watch: (input) => Stream.unwrap(Effect.map(P4, (service) =>
    // SAFETY: P4.watch[name] takes that operation's options; see above for why the input is erased.
    (service.watch[name] as ErasedWatch)(input, input))),
});

const nodeOperation = (operation: ErasedOperation): FacadeOperation => ({
  run: (input) => runOperation(operation, input),
  watch: (input) => watchOperation(operation, input, input),
});

/** Every facade method by name; a Node operation replaces a registry one of the same name. */
const FACADE_OPERATIONS = new Map<string, FacadeOperation>([
  ...OPERATION_NAMES.map((name) => [name, serviceOperation(name)] as const),
  ...Object.entries(nodeOps).map(([name, operation]) => [
    name,
    // SAFETY: nodeOps[name] is only called through the facade method of the same name; see above.
    nodeOperation(operation as ErasedOperation),
  ] as const),
]);

/** Neutral and Node operations exposed as Promise and watch methods. */
export type P4PromiseOps = P4Ops & {
  readonly findWorkspaceForPath: typeof findWorkspaceForPath;
  readonly materializeDepotFiles: typeof materializeDepotFiles;
  readonly setPersistentWorkspace: typeof setPersistentWorkspace;
};

/** Cancellation options accepted by every Promise method. */
export interface P4PromiseOptions {
  /** Aborting rejects with this signal's reason after releasing command resources. */
  readonly signal?: AbortSignal | undefined;
}

/** One eagerly started operation, with a single consumer event iterable and its result. */
export interface P4WatchHandle<I, R> {
  /** Consume once. Leaving iteration early cancels the operation. */
  readonly events: AsyncIterable<P4OperationEvent<I, R>>;
  /** Settles even when events are not consumed. */
  readonly result: Promise<R>;
}

/** Watch heartbeat and event buffering options. */
export interface P4PromiseWatchOptions extends P4PromiseOptions, P4WatchOptions {
  /** Maximum queued events (default 10,000). Overflow fails event iteration; the result still completes. */
  readonly maxBuffered?: number | undefined;
}

/** Tagged Promise commands preserve the supplied schema's decoded type. */
export interface P4PromiseTaggedMethod {
  <A>(options: TypedTaggedOptions<A> & P4PromiseOptions): Promise<P4TaggedResult<A>>;
  (options: RunTaggedOptions & P4PromiseOptions): Promise<P4TaggedResult<unknown>>;
}

/** Tagged watch commands preserve both decoded items and the final result. */
export interface P4PromiseTaggedWatchMethod {
  <A>(options: TypedTaggedOptions<A> & P4PromiseWatchOptions): P4WatchHandle<A, P4TaggedResult<A>>;
  (options: RunTaggedOptions & P4PromiseWatchOptions): P4WatchHandle<unknown, P4TaggedResult<unknown>>;
}

/** Watch methods generated from the operation registry. */
export type P4PromiseWatch = {
  readonly [K in keyof P4PromiseOps]: K extends 'runTagged' ? P4PromiseTaggedWatchMethod :
    K extends 'materializeDepotFiles' ? <F extends P4MaterializeSpec>(
      options: MaterializeDepotFilesOptions<F> & P4PromiseWatchOptions,
    ) => P4WatchHandle<P4MaterializedFile<F>, P4MaterializeResult<F>> :
    K extends 'listChangelists' ? <S extends P4ChangelistStatus>(
      options: ListChangelistsOptions & { readonly status: S } & P4PromiseWatchOptions,
    ) => P4WatchHandle<P4Changelist<S>, P4ChangelistPage<S>> :
    (options: Parameters<P4PromiseOps[K]['program']>[0] & P4PromiseWatchOptions) => P4WatchHandle<
      Parameters<P4PromiseOps[K]['program']>[1] extends P4Sink<infer I> ? I : never,
      Effect.Success<ReturnType<P4PromiseOps[K]['program']>>
    >;
};

/** The members of {@link P4PromiseClient} that are not operations. */
export interface P4PromiseClientLifecycle {
  /** Resolve local connection settings using this client's cwd and executor. */
  readonly resolveConnection: (options: ResolveConnectionOptions & P4PromiseOptions) => Promise<P4ResolvedConnection>;
  /** Check whether a workspace root exists on this machine. */
  readonly workspaceRootExists: (options: Pick<P4Workspace, 'root'> & P4PromiseOptions) => Promise<boolean>;
  /** Create an independent client with merged connection and environment options. */
  readonly with: (patch: P4ClientOptions) => P4PromiseClient;
  /** Cancel active operations and release this client's runtime. Idempotent. */
  readonly dispose: () => Promise<void>;
}

/** Immutable Promise facade. Each derived client owns its runtime and must be disposed. */
export type P4PromiseClient = {
  readonly [K in keyof P4PromiseOps]: K extends 'runTagged' ? P4PromiseTaggedMethod :
    K extends 'materializeDepotFiles' ? <F extends P4MaterializeSpec>(
      options: MaterializeDepotFilesOptions<F> & P4PromiseOptions,
    ) => Promise<P4MaterializeResult<F>> :
    K extends 'listChangelists' ? <S extends P4ChangelistStatus>(
      options: ListChangelistsOptions & { readonly status: S } & P4PromiseOptions,
    ) => Promise<P4ChangelistPage<S>> :
    (options: Parameters<P4PromiseOps[K]['program']>[0] & P4PromiseOptions) =>
      Promise<Effect.Success<ReturnType<P4PromiseOps[K]['program']>>>;
} & P4PromiseClientLifecycle & {
  readonly watch: P4PromiseWatch;
};

/** Create a Promise facade over a supplied P4 layer, for replay or application-specific executors. */
export function createP4ClientFromLayer(
  layer: Layer.Layer<P4 | P4Context, P4InvalidArgumentError>,
  derive: (options: P4ClientOptions) => Layer.Layer<P4 | P4Context, P4InvalidArgumentError>,
  options: P4ClientOptions = {},
): P4PromiseClient {
  const config = resolveOptions(options);
  const runtime = ManagedRuntime.make(layer);
  const active = new Map<AbortController, Promise<unknown>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function execute<A, E>(effect: Effect.Effect<A, E, P4 | P4Context>, signal?: AbortSignal,
    controller = new AbortController()): Promise<A> {
    if (disposed) return Promise.reject(new Error('P4 client disposed.'));

    if (signal?.aborted) return Promise.reject(signal.reason);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });

    const result = runtime.runPromise(effect, { signal: controller.signal }).catch((cause: unknown) => {
      throw controller.signal.aborted ? controller.signal.reason : cause;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
    });

    active.set(controller, result);

    return result;
  }

  const methods: Record<string, (input: never) => Promise<AnyResult>> = {};
  const watched: Record<string, (input: never) => P4WatchHandle<AnyItem, AnyResult>> = {};

  for (const [name, { run, watch }] of FACADE_OPERATIONS) {
    methods[name] = (input: P4PromiseWatchOptions) => execute(run(input), input.signal);
    watched[name] = (input: P4PromiseWatchOptions) => {
      const queue = createAsyncEventQueue<P4OperationEvent<AnyItem, AnyResult>>(
        input.maxBuffered === undefined ? {} : { maxBuffered: input.maxBuffered },
      );

      const controller = new AbortController();
      let final: { result: AnyResult } | undefined;

      const result = execute(watch(input).pipe(
        Stream.runForEach((event) => Effect.sync(() => {
          queue.push(event);

          if (Predicate.isTagged(event, 'done')) final = { result: event.result };
        })),
        Effect.flatMap(() => final === undefined
          ? Effect.die(new Error(`P4 watch ${name} ended without a done event.`))
          : Effect.succeed(final.result)),
      ), input.signal, controller).then((value) => {
        queue.finish();

        return value;
      }, (cause: unknown) => {
        queue.fail(cause);
        throw cause;
      });

      // Watching events alone must not cause an unhandled result rejection.
      void result.catch(() => {});
      let consumed = false;

      const events: AsyncIterable<P4OperationEvent<AnyItem, AnyResult>> = {
        [Symbol.asyncIterator]() {
          if (consumed) throw new Error('P4 watch events can only be consumed once.');
          consumed = true;
          const iterator = queue.iterable[Symbol.asyncIterator]();

          return {
            next: () => iterator.next(),
            return: () => {
              if (final === undefined) controller.abort(new Error('P4 watch iteration ended early.'));

              return iterator.return!();
            },
          };
        },
      };

      return { events, result };
    };
  }

  // SAFETY: methods and watched hold one entry per facade operation name (FACADE_OPERATIONS), each
  // running the operation of that name, which is exactly the mapping P4PromiseClient declares.
  const operationMethods = methods as Omit<P4PromiseClient, keyof P4PromiseClientLifecycle | 'watch'>;
  // SAFETY: as above, for the watched methods.
  const watchMethods = watched as P4PromiseWatch;

  return Object.freeze({
    ...operationMethods,
    resolveConnection: (input: ResolveConnectionOptions & P4PromiseOptions) =>
      execute(resolveConnection(input), input.signal),
    workspaceRootExists: (input: Pick<P4Workspace, 'root'> & P4PromiseOptions) =>
      execute(Effect.sync(() => workspaceRootExists(input)), input.signal),
    watch: Object.freeze(watchMethods),
    with: (patch: P4ClientOptions) => {
      if (disposed) throw new Error('P4 client disposed.');
      const merged = mergeOptions(config, patch);

      return createP4ClientFromLayer(derive(merged), derive, merged);
    },
    dispose: () => {
      if (disposal !== undefined) return disposal;
      disposed = true;

      for (const controller of active.keys()) controller.abort(new Error('P4 client disposed.'));
      disposal = Promise.allSettled(active.values()).then(() => runtime.dispose());

      return disposal;
    },
  });
}

/** Create an immutable Node client. Dispose it and each client returned by with() when finished. */
export function createP4Client(options: P4ClientOptions = {}): P4PromiseClient {
  const config = resolveOptions(options);

  return createP4ClientFromLayer(layerNode(config), layerNode, config);
}

/**
 * Run a request with a client that is disposed when the callback resolves or rejects.
 * Clients derived inside the callback retain independent ownership.
 */
export function withP4Client<A>(
  options: P4ClientOptions,
  use: (client: P4PromiseClient) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => createP4Client(options)),
    (client) => Effect.promise(() => use(client)),
    (client) => Effect.promise(() => client.dispose()),
  ));
}
