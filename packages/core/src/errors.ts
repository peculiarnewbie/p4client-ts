import { Schema } from 'effect';
import { P4MessageSchema } from './wire/message.js';
import { P4CategorySchema, P4ReasonSchema } from './wire/reasons.js';

/**
 * Perforce reported a failure: a message the operation's policy treats as fatal,
 * or a non-zero exit that no message explains.
 *
 * `reason` and `category` describe the first failing message. `messages` holds
 * every message the command produced, in order.
 */
export class P4CommandError extends Schema.TaggedErrorClass<P4CommandError>()('P4CommandError', {
  message: Schema.String,
  reason: P4ReasonSchema,
  category: P4CategorySchema,
  /** Executable that ran. */
  command: Schema.String,
  /** Arguments it ran with, credentials redacted. */
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  messages: Schema.Array(P4MessageSchema),
  /** Diagnostic output on stderr, truncated to 64 KiB. */
  stderr: Schema.String,
}) {}

/** A `p4` process exceeded its timeout and was killed. */
export class P4TimeoutError extends Schema.TaggedErrorClass<P4TimeoutError>()('P4TimeoutError', {
  message: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Number,
  /** Output received before the process was killed, each truncated to 64 KiB. */
  stdout: Schema.String,
  stderr: Schema.String,
}) {}

/** Perforce output did not have the expected shape. */
export class P4ParseError extends Schema.TaggedErrorClass<P4ParseError>()('P4ParseError', {
  message: Schema.String,
  /** The offending output, as text, truncated to 4 KiB. */
  line: Schema.String,
  /** What was wrong with it. */
  detail: Schema.String,
  command: Schema.NullOr(Schema.String),
  args: Schema.NullOr(Schema.Array(Schema.String)),
}) {}

/** The `p4` executable could not be started, or its pipes failed. */
export class P4SpawnError extends Schema.TaggedErrorClass<P4SpawnError>()('P4SpawnError', {
  message: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  /** System error code such as `ENOENT`, when there is one. */
  code: Schema.NullOr(Schema.String),
}) {}

/** A command that changes the workspace or server was refused because mutation is not allowed. */
export class P4ReadOnlyError extends Schema.TaggedErrorClass<P4ReadOnlyError>()('P4ReadOnlyError', {
  message: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
}) {}

/** An option passed by the caller is invalid; no command was run. */
export class P4InvalidArgumentError extends Schema.TaggedErrorClass<P4InvalidArgumentError>()(
  'P4InvalidArgumentError',
  {
    message: Schema.String,
    /** Name of the offending option. */
    option: Schema.String,
  },
) {}

/** Depot files could not be written safely to the requested destination. */
export class P4MaterializationError extends Schema.TaggedErrorClass<P4MaterializationError>()(
  'P4MaterializationError',
  {
    message: Schema.String,
    reason: Schema.Literals(['limit_exceeded', 'invalid_depot_path', 'invalid_destination']),
    /** The depot or local path concerned, when there is one. */
    path: Schema.NullOr(Schema.String),
  },
) {}

/** Every error a p4client-ts operation can fail with. */
export const P4ErrorSchema = Schema.Union([
  P4CommandError,
  P4TimeoutError,
  P4ParseError,
  P4SpawnError,
  P4ReadOnlyError,
  P4InvalidArgumentError,
  P4MaterializationError,
]);

/** Every error a p4client-ts operation can fail with. */
export type P4Error = typeof P4ErrorSchema.Type;

/** Serializable form of a {@link P4Error}. */
export type P4EncodedError = typeof P4ErrorSchema.Encoded;

/**
 * Encode an error as plain data, for example to send it over Electron IPC,
 * which drops the fields of `Error` subclasses.
 *
 * @param error A p4client-ts error.
 * @returns Plain data accepted by {@link decodeP4Error}.
 */
export function encodeP4Error(error: P4Error): P4EncodedError {
  return Schema.encodeSync(P4ErrorSchema)(error);
}

/**
 * Rebuild an error from {@link encodeP4Error} output, restoring its class.
 *
 * @param encoded Plain data produced by {@link encodeP4Error}.
 * @returns The error instance, usable with `instanceof` and `Effect.catchTag`.
 * @throws {Error} When the data is not an encoded p4client-ts error.
 */
export function decodeP4Error(encoded: unknown): P4Error {
  return Schema.decodeUnknownSync(P4ErrorSchema)(encoded);
}

const MAX_RETAINED = 64 * 1024;

/**
 * Truncate retained output so errors stay small enough to log and send over IPC.
 *
 * @param text Output text.
 * @param limit Maximum length kept.
 * @returns The text, truncated with a marker when it was longer than `limit`.
 */
export function truncateOutput(text: string, limit = MAX_RETAINED): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}
