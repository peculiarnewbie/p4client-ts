import { Effect, Layer, ServiceMap } from 'effect';
import { P4InvalidArgumentError } from '../errors.js';
import type { P4Connection } from '../connection/argv.js';

/** How p4client-ts runs `p4`. Every field is optional. */
export interface P4ClientOptions {
  /** Path or name of the `p4` executable. Defaults to `p4`. */
  readonly executable?: string | undefined;
  /** Server, user and workspace; passed as global options. */
  readonly connection?: P4Connection | undefined;
  /** Working directory for commands, which also selects P4CONFIG files. */
  readonly cwd?: string | undefined;
  /** Environment changes for commands; an `undefined` value removes an inherited variable. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Kill each command after this many milliseconds (at most 2,147,483,647). */
  readonly timeoutMs?: number | undefined;
  /**
   * Allow commands that change the server or a workspace, such as `sync`.
   * Defaults to `false`: such commands fail with `P4ReadOnlyError` without running.
   */
  readonly allowMutation?: boolean | undefined;
}

/** {@link P4ClientOptions} with defaults applied. */
export interface P4ResolvedOptions {
  readonly executable: string;
  readonly connection: P4Connection;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number | undefined;
  readonly allowMutation: boolean;
}

/** Largest timeout a JavaScript timer can schedule. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The options commands run with. Change them for part of a program with {@link withOptions}. */
export class P4Config extends ServiceMap.Service<P4Config, P4ResolvedOptions>()('p4client-ts/P4Config') {}

/**
 * Validate a timeout.
 *
 * @param timeoutMs Timeout in milliseconds, or `undefined` for none.
 * @returns The timeout.
 * @throws {P4InvalidArgumentError} When it is not a positive number within the timer limit.
 */
export function requireTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new P4InvalidArgumentError({
      message: `timeoutMs must be a positive number of milliseconds no greater than ${MAX_TIMEOUT_MS}.`,
      option: 'timeoutMs',
    });
  }
  return timeoutMs;
}

/**
 * Apply options on top of resolved ones. Omitted fields inherit; explicit `undefined`
 * clears cwd and timeoutMs, and resets executable to `p4`. Connection fields merge individually.
 *
 * @param base Options in effect.
 * @param patch Options to change.
 * @returns The combined options.
 * @throws {P4InvalidArgumentError} When the timeout is invalid.
 */
export function mergeOptions(base: P4ResolvedOptions, patch: P4ClientOptions): P4ResolvedOptions {
  return {
    executable: Object.hasOwn(patch, 'executable') ? patch.executable ?? 'p4' : base.executable,
    connection: { ...base.connection, ...patch.connection },
    cwd: Object.hasOwn(patch, 'cwd') ? patch.cwd : base.cwd,
    env: { ...base.env, ...patch.env },
    timeoutMs: requireTimeout(Object.hasOwn(patch, 'timeoutMs') ? patch.timeoutMs : base.timeoutMs),
    allowMutation: patch.allowMutation ?? base.allowMutation,
  };
}

const DEFAULTS: P4ResolvedOptions = {
  executable: 'p4',
  connection: {},
  cwd: undefined,
  env: {},
  timeoutMs: undefined,
  allowMutation: false,
};

/**
 * Resolve client options.
 *
 * @param options Options to resolve.
 * @returns The options with defaults applied.
 * @throws {P4InvalidArgumentError} When the timeout is invalid.
 */
export function resolveOptions(options: P4ClientOptions = {}): P4ResolvedOptions {
  return mergeOptions(DEFAULTS, options);
}

/**
 * A layer providing client options.
 *
 * @param options Options for every command run with this layer.
 * @returns A layer that fails with `P4InvalidArgumentError` for invalid options.
 */
export function configLayer(options: P4ClientOptions = {}): Layer.Layer<P4Config, P4InvalidArgumentError> {
  return Layer.effect(P4Config, Effect.try({
    try: () => resolveOptions(options),
    catch: (error) => error as P4InvalidArgumentError,
  }));
}

/**
 * Run part of a program with changed options, for example another workspace.
 *
 * @param patch Options to change; connection fields merge individually.
 * @returns A function applying the change to an effect.
 */
export function withOptions(patch: P4ClientOptions) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | P4InvalidArgumentError, R | P4Config> =>
    Effect.flatMap(P4Config.asEffect(), (base) =>
      Effect.try({
        try: () => mergeOptions(base, patch),
        catch: (error) => error as P4InvalidArgumentError,
      })).pipe(Effect.flatMap((options) => Effect.provideService(effect, P4Config, options)));
}
