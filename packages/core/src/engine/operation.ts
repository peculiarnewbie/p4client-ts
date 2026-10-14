import { Clock, Effect, Queue, Stream } from 'effect';
import type { P4Error } from '../errors.js';
import type { P4Executor } from '../exec/executor.js';
import type { P4Message } from '../wire/message.js';
import type { P4CommandEvent, P4CommandOutput } from './command.js';
import type { P4Config } from './config.js';

/** Services every operation needs. */
export type P4Context = P4Executor | P4Config;

/** What an operation counts while it runs. */
export type P4ProgressUnit = 'files' | 'revisions' | 'changes' | 'records';

/** How far an operation has got. */
export interface P4Progress {
  /** Units done so far. */
  readonly completed: number;
  /** Units expected, or `null` when Perforce does not say in advance. */
  readonly total: number | null;
  readonly unit: P4ProgressUnit;
  /** Bytes done so far, for operations that transfer content. */
  readonly bytesCompleted: number | null;
  readonly bytesTotal: number | null;
  /** Milliseconds since the operation started. */
  readonly elapsedMs: number;
}

/** A progress report, before the runner stamps the elapsed time. */
export type P4ProgressUpdate = Omit<P4Progress, 'elapsedMs'>;

/** Something an operation reported while running, then its result. */
export type P4OperationEvent<I, R> =
  /** One result item, as soon as it is known. */
  | { readonly _tag: 'item'; readonly item: I }
  /** An informational message, or one saying the request matched nothing. */
  | { readonly _tag: 'message'; readonly message: P4Message }
  /** A per-item failure that does not fail the operation. */
  | { readonly _tag: 'failure'; readonly message: P4Message }
  | { readonly _tag: 'progress'; readonly progress: P4Progress }
  /** The operation's result; always the last event. */
  | { readonly _tag: 'done'; readonly result: R };

/** Where an operation reports what it finds while it runs. */
export interface P4Sink<I> {
  readonly item: (item: I) => Effect.Effect<void>;
  readonly message: (message: P4Message) => Effect.Effect<void>;
  readonly failure: (message: P4Message) => Effect.Effect<void>;
  readonly progress: (progress: P4ProgressUpdate) => Effect.Effect<void>;
}

/**
 * A read or write against Perforce: options in, a result out, with items,
 * messages, failures and progress reported to a sink along the way.
 *
 * {@link runOperation} and {@link watchOperation} execute the same program,
 * so a collected result and a watched one cannot disagree.
 */
export interface P4Operation<O, I, R> {
  /** Operation name, used for the client method. */
  readonly name: string;
  readonly program: (options: O, sink: P4Sink<I>) => Effect.Effect<R, P4Error, P4Context>;
}

/**
 * Define an operation.
 *
 * @param name Operation name.
 * @param program The program; report through the sink, return the result.
 * @returns The operation.
 */
export function operation<O, I, R>(
  name: string,
  program: (options: O, sink: P4Sink<I>) => Effect.Effect<R, P4Error, P4Context>,
): P4Operation<O, I, R> {
  return { name, program };
}

const SILENT: P4Sink<unknown> = {
  item: () => Effect.void,
  message: () => Effect.void,
  failure: () => Effect.void,
  progress: () => Effect.void,
};

/**
 * Run an operation for its result.
 *
 * @param op The operation.
 * @param options Its options.
 * @returns The result.
 */
export function runOperation<O, I, R>(op: P4Operation<O, I, R>, options: O): Effect.Effect<R, P4Error, P4Context> {
  return op.program(options, SILENT);
}

/** Options for watching an operation. */
export interface P4WatchOptions {
  /**
   * While Perforce prints nothing, repeat the latest progress with a fresh
   * `elapsedMs` this often, so a watcher can show the operation is alive.
   * Defaults to no heartbeat.
   */
  readonly progressIntervalMs?: number | undefined;
}

/**
 * Run an operation as a stream of what it reports, ending with its result.
 *
 * @param op The operation.
 * @param options Its options.
 * @param watch Heartbeat options.
 * @returns Items, messages, failures and progress in the order they happen, then `done`.
 */
export function watchOperation<O, I, R>(
  op: P4Operation<O, I, R>,
  options: O,
  watch: P4WatchOptions = {},
): Stream.Stream<P4OperationEvent<I, R>, P4Error, P4Context> {
  return Stream.callback<P4OperationEvent<I, R>, P4Error, P4Context>((queue) => Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    let latest: P4ProgressUpdate = {
      completed: 0, total: null, unit: 'records', bytesCompleted: null, bytesTotal: null,
    };
    let reportedAt = started;
    const emit = (event: P4OperationEvent<I, R>) => Queue.offer(queue, event).pipe(Effect.asVoid);
    const report = (update: P4ProgressUpdate) => Effect.flatMap(Clock.currentTimeMillis, (now) => {
      latest = update;
      reportedAt = now;
      return emit({ _tag: 'progress', progress: { ...update, elapsedMs: now - started } });
    });
    const sink: P4Sink<I> = {
      item: (item) => emit({ _tag: 'item', item }),
      message: (message) => emit({ _tag: 'message', message }),
      failure: (message) => emit({ _tag: 'failure', message }),
      progress: report,
    };
    const interval = watch.progressIntervalMs;
    if (interval !== undefined && interval > 0) {
      yield* Effect.forkScoped(Effect.forever(Effect.sleep(interval).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) => (now - reportedAt >= interval ? report(latest) : Effect.void)),
      )));
    }
    // A failure must reach the queue explicitly: left in the callback's effect, it hangs the stream.
    yield* op.program(options, sink).pipe(
      Effect.flatMap((result) => emit({ _tag: 'done', result })),
      Effect.matchCauseEffect({
        onFailure: (cause) => Effect.sync(() => Queue.failCauseUnsafe(queue, cause)),
        onSuccess: () => Effect.sync(() => Queue.endUnsafe(queue)),
      }),
    );
  }));
}

/** Counts progress for an operation and reports it to a sink. */
export interface P4ProgressCounter {
  /** Set or revise the expected totals. */
  readonly expect: (total: number | null, bytesTotal?: number | null) => void;
  /** Record completed units and bytes, then report. */
  readonly advance: (count?: number, bytes?: number) => Effect.Effect<void>;
  /** The current counts. */
  readonly snapshot: () => P4ProgressUpdate;
}

/**
 * Create a progress counter.
 *
 * @param sink Where progress is reported.
 * @param unit What is counted.
 * @param total Units expected, when known.
 * @returns The counter.
 */
export function progressCounter(
  sink: P4Sink<unknown>,
  unit: P4ProgressUnit,
  total: number | null = null,
): P4ProgressCounter {
  let state: P4ProgressUpdate = { completed: 0, total, unit, bytesCompleted: null, bytesTotal: null };
  return {
    expect: (expected, bytesTotal) => {
      state = { ...state, total: expected, bytesTotal: bytesTotal === undefined ? state.bytesTotal : bytesTotal };
    },
    advance: (count = 1, bytes) => Effect.suspend(() => {
      state = {
        ...state,
        completed: state.completed + count,
        bytesCompleted: bytes === undefined ? state.bytesCompleted : (state.bytesCompleted ?? 0) + bytes,
      };
      return sink.progress(state);
    }),
    snapshot: () => state,
  };
}

/** How {@link drain} reports a command's data. */
export interface P4DrainOptions<A, I> {
  /** Convert data to a reported item; `null` reports nothing. Defaults to reporting nothing. */
  readonly item?: ((value: A) => I | null) | undefined;
  /** Advanced once per data record. */
  readonly counter?: P4ProgressCounter | undefined;
  /** Called for each data record before it is counted, for example to read totals. */
  readonly inspect?: ((value: A) => void) | undefined;
}

/**
 * Run a command's events to completion, reporting messages, failures and
 * items to a sink, and collect its output.
 *
 * @param sink Where the operation reports.
 * @param events A command stream, such as `streamCommand(spec)`.
 * @param options How data is reported.
 * @returns The collected output.
 */
export function drain<A, I>(
  sink: P4Sink<I>,
  events: Stream.Stream<P4CommandEvent<A>, P4Error, P4Context>,
  options: P4DrainOptions<A, I> = {},
): Effect.Effect<P4CommandOutput<A>, P4Error, P4Context> {
  return Effect.suspend(() => {
    const output: P4CommandOutput<A> = { items: [], messages: [], failures: [] };
    return events.pipe(
      Stream.runForEach((event): Effect.Effect<void> => {
        if (event._tag === 'message') {
          output.messages.push(event.message);
          return sink.message(event.message);
        }
        if (event._tag === 'failure') {
          output.failures.push(event.message);
          return sink.failure(event.message);
        }
        output.items.push(event.value);
        options.inspect?.(event.value);
        const item = options.item?.(event.value) ?? null;
        const reported = item === null ? Effect.void : sink.item(item);
        return options.counter === undefined ? reported : Effect.andThen(reported, options.counter.advance());
      }),
      Effect.as(output),
    );
  });
}
