import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { P4 } from '../P4.js';
import { resolveOptions, mergeOptions } from '../engine/config.js';
import { createAsyncEventQueue } from '../internal/async-queue.js';
import {
  layerNode, resolveConnection, findWorkspaceForPath, workspaceRootExists, materializeDepotFiles,
} from '../node/index.js';
import { runOperation, watchOperation } from '../engine/operation.js';
import { ops } from '../ops.js';
import type { ResolveConnectionOptions, P4ResolvedConnection } from '../node/connection.js';
import type { P4Workspace } from '../commands/workspaces.js';
import type { P4Ops } from '../ops.js';
import type { TypedTaggedOptions } from '../P4.js';
import type { P4TaggedResult, RunTaggedOptions } from '../commands/raw.js';
import type { P4ClientOptions } from '../engine/config.js';
import type { P4Context, P4Operation, P4OperationEvent, P4Sink, P4WatchOptions } from '../engine/operation.js';
import type { P4InvalidArgumentError } from '../errors.js';

const nodeOps = { findWorkspaceForPath, materializeDepotFiles };
const promiseOps = { ...ops, ...nodeOps };
/** Neutral and Node operations exposed as Promise and watch methods. */
export type P4PromiseOps = P4Ops & {
  readonly findWorkspaceForPath: typeof findWorkspaceForPath;
  readonly materializeDepotFiles: typeof materializeDepotFiles;
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
    (options: Parameters<P4PromiseOps[K]['program']>[0] & P4PromiseWatchOptions) => P4WatchHandle<
      Parameters<P4PromiseOps[K]['program']>[1] extends P4Sink<infer I> ? I : never,
      Effect.Success<ReturnType<P4PromiseOps[K]['program']>>
    >;
};

/** Immutable Promise facade. Each derived client owns its runtime and must be disposed. */
export type P4PromiseClient = {
  readonly [K in keyof P4PromiseOps]: K extends 'runTagged' ? P4PromiseTaggedMethod :
    (options: Parameters<P4PromiseOps[K]['program']>[0] & P4PromiseOptions) =>
      Promise<Effect.Success<ReturnType<P4PromiseOps[K]['program']>>>;
} & {
  readonly watch: P4PromiseWatch;
  /** Resolve local connection settings using this client's cwd and executor. */
  readonly resolveConnection: (options: ResolveConnectionOptions & P4PromiseOptions) => Promise<P4ResolvedConnection>;
  /** Check whether a workspace root exists on this machine. */
  readonly workspaceRootExists: (options: Pick<P4Workspace, 'root'> & P4PromiseOptions) => Promise<boolean>;
  /** Create an independent client with merged connection and environment options. */
  readonly with: (patch: P4ClientOptions) => P4PromiseClient;
  /** Cancel active operations and release this client's runtime. Idempotent. */
  readonly dispose: () => Promise<void>;
};

/**
 * Create a Promise facade over a supplied P4 layer, for replay or application-specific executors.
 * @param layer A layer supplying P4; expose P4Config and P4Executor to use Node helper methods.
 * @param derive Build a layer for a derived configuration.
 * @param options Base configuration for with().
 * @returns An immutable client owning a ManagedRuntime.
 */
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
    const result = runtime.runPromise(effect, { signal: controller.signal }).catch((error: unknown) => {
      throw controller.signal.aborted ? controller.signal.reason : error;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
    });
    active.set(controller, result);
    return result;
  }

  const methods: Record<string, unknown> = {};
  const watched: Record<string, unknown> = {};
  type Run = (options: unknown) => Effect.Effect<unknown, unknown>;
  type Watch = (options: unknown, settings?: P4WatchOptions) =>
    Stream.Stream<P4OperationEvent<unknown, unknown>, unknown>;
  for (const name of Object.keys(promiseOps) as Array<keyof P4PromiseOps>) {
    const nodeOp = nodeOps[name as keyof typeof nodeOps] as P4Operation<unknown, unknown, unknown> | undefined;
    const run = (input: unknown): Effect.Effect<unknown, unknown, P4 | P4Context> => nodeOp === undefined
      ? Effect.flatMap(P4.asEffect(), (service) => (service[name as keyof P4Ops] as Run)(input))
      : runOperation(nodeOp, input);
    const watch = (input: P4PromiseWatchOptions):
      Stream.Stream<P4OperationEvent<unknown, unknown>, unknown, P4 | P4Context> => nodeOp === undefined
      ? Stream.unwrap(Effect.map(P4.asEffect(), (service) =>
        (service.watch[name as keyof P4Ops] as Watch)(input, input)))
      : watchOperation(nodeOp, input, input);
    methods[name] = (input: P4PromiseOptions) => execute(run(input), input.signal);
    watched[name] = (input: P4PromiseWatchOptions): P4WatchHandle<unknown, unknown> => {
      const queue = createAsyncEventQueue<P4OperationEvent<unknown, unknown>>(
        input.maxBuffered === undefined ? {} : { maxBuffered: input.maxBuffered },
      );
      const controller = new AbortController();
      let final: { result: unknown } | undefined;
      const result = execute(watch(input).pipe(
        Stream.runForEach((event) => Effect.sync(() => {
          queue.push(event);
          if (event._tag === 'done') final = { result: event.result };
        })),
        Effect.flatMap(() => final === undefined
          ? Effect.die(new Error(`P4 watch ${name} ended without a done event.`))
          : Effect.succeed(final.result)),
      ), input.signal, controller).then((value) => {
        queue.finish();
        return value;
      }, (error: unknown) => {
        queue.fail(error);
        throw error;
      });
      // Watching events alone must not cause an unhandled result rejection.
      void result.catch(() => {});
      let consumed = false;
      const events: AsyncIterable<P4OperationEvent<unknown, unknown>> = {
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
  return Object.freeze({
    ...methods,
    resolveConnection: (input: ResolveConnectionOptions & P4PromiseOptions) =>
      execute(resolveConnection(input), input.signal),
    workspaceRootExists: (input: Pick<P4Workspace, 'root'> & P4PromiseOptions) =>
      execute(Effect.sync(() => workspaceRootExists(input)), input.signal),
    watch: Object.freeze(watched),
    with: (patch: P4ClientOptions) => {
      if (disposed) throw new Error('P4 client disposed.');
      const merged = mergeOptions(config, patch);
      return createP4ClientFromLayer(derive(merged), derive, merged);
    },
    dispose: () => {
      if (disposal !== undefined) return disposal;
      disposed = true;
      for (const controller of active.keys()) controller.abort(new Error('P4 client disposed.'));
      disposal = Promise.allSettled([...active.values()]).then(() => runtime.dispose());
      return disposal;
    },
  }) as P4PromiseClient;
}

/**
 * Create an immutable Node client. Dispose it and each client returned by with() when finished.
 * @param options Connection, execution and mutation options.
 * @returns Promise methods and watched methods generated from the operations registry.
 * @throws {P4InvalidArgumentError} When configuration is invalid.
 */
export function createP4Client(options: P4ClientOptions = {}): P4PromiseClient {
  const config = resolveOptions(options);
  return createP4ClientFromLayer(layerNode(config), layerNode, config);
}
