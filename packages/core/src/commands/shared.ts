import { Effect, Schema } from 'effect';
import { P4InvalidArgumentError, P4ParseError } from '../errors.js';
import {
  P4ChangeSchema,
  P4ClientPathSchema,
  P4DepotPathSchema,
  P4FileActionSchema,
  P4LocalPathSchema,
  P4NonNegativeIntegerSchema,
  P4PositiveIntegerSchema,
} from '../schemas.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4Reason } from '../wire/reasons.js';

/** A decoded output record, as received. */
export type Row = Readonly<Record<string, unknown>>;

/** One file spec or several. */
export type FileSpecs = string | readonly string[];

/**
 * Decode a value from a command's output. Throws `P4ParseError`, which the
 * engine completes with the command that produced the row.
 *
 * @param schema Schema the value must satisfy.
 * @param value The value.
 * @param row The record it came from, kept in the error.
 * @returns The decoded value.
 */
export function decodeField<A>(schema: Schema.Decoder<A>, value: unknown, row: unknown = value): A {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: 'preserve' });
  } catch (cause) {
    throw new P4ParseError({
      message: 'Invalid Perforce command output.',
      line: (JSON.stringify(row) ?? String(row)).slice(0, 4096),
      detail: String(cause),
      command: null,
      args: null,
    });
  }
}

/**
 * A parse error for output without the expected shape. Throw it from a
 * decoder, or `yield*` it from a program.
 *
 * @param message What was expected.
 * @param row The offending output.
 * @returns The error.
 */
export function malformed(message: string, row: unknown): P4ParseError {
  return new P4ParseError({
    message,
    line: (JSON.stringify(row) ?? String(row)).slice(0, 4096),
    detail: message,
    command: null,
    args: null,
  });
}

/** A trimmed non-empty string field, or `null`. */
export function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A description field: trailing line breaks removed, otherwise as written. */
export function description(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+$/, '') : null;
}

const Integer = Schema.NullOr(P4NonNegativeIntegerSchema);

/** A non-negative integer field, or `null` when absent. */
export function integer(value: unknown, row: unknown): number | null {
  return value === undefined || value === '' ? null : decodeField(Integer, value, row);
}

/** A positive integer field that must be present. */
export function positive(value: unknown, row: unknown): number {
  return decodeField(P4PositiveIntegerSchema, value, row);
}

/** A changelist field: a number or `default`. */
export function change(value: unknown, row: unknown): number | 'default' {
  return decodeField(P4ChangeSchema, value, row);
}

/** A depot path field that must be present. */
export function depotPath(value: unknown, row: unknown): P4DepotPath {
  return decodeField(P4DepotPathSchema, typeof value === 'string' ? value.trim() : value, row);
}

/** A depot path field, or `null` when absent. */
export function optionalDepotPath(value: unknown, row: unknown): P4DepotPath | null {
  return value === undefined || value === null || value === '' ? null : depotPath(value, row);
}

/** A file action field that must be present. */
export function action(value: unknown, row: unknown): P4FileAction {
  return decodeField(P4FileActionSchema, value, row);
}

/** A file action field, or `null` when absent. */
export function optionalAction(value: unknown, row: unknown): P4FileAction | null {
  return value === undefined || value === null || value === '' ? null : action(value, row);
}

/** A local path field, or `null` when absent. */
export function localPath(value: unknown, row: unknown): P4LocalPath | null {
  const trimmed = text(value);
  return trimmed === null ? null : decodeField(P4LocalPathSchema, trimmed, row);
}

/**
 * A `clientFile` field, which is client syntax (`//client/...`) or, for some
 * commands, a local path.
 */
export function clientFile(value: unknown, row: unknown): P4ClientPath | P4LocalPath | null {
  const trimmed = text(value);
  if (trimmed === null) return null;
  return trimmed.startsWith('//') ? decodeField(P4ClientPathSchema, trimmed, row) : localPath(trimmed, row);
}

/**
 * Convert a Unix time in seconds, as Perforce prints it, to ISO 8601.
 *
 * @param value Seconds as a string or number.
 * @returns The ISO timestamp, or `null` for a missing or invalid time.
 */
export function isoFromSeconds(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The file specs as a list. */
export function specList(specs: FileSpecs | undefined): string[] {
  if (specs === undefined) return [];
  return typeof specs === 'string' ? [specs] : [...specs];
}

/** Every `name{index}` field of a record, by index, in index order (as `describe` and `filelog` print them). */
export function indexes(row: Row, field: string): number[] {
  const pattern = new RegExp(`^${field}(\\d+)$`);
  return Object.keys(row)
    .flatMap((key) => {
      const match = pattern.exec(key);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    })
    .sort((left, right) => left - right);
}

/**
 * Require a positive integer option.
 *
 * @param value The option value.
 * @param option The option name, for the error.
 * @returns The value, or `P4InvalidArgumentError`.
 */
export function requirePositive(value: number, option: string): Effect.Effect<number, P4InvalidArgumentError> {
  return Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(new P4InvalidArgumentError({
      message: `${option} must be a positive integer, received ${String(value)}.`,
      option,
    }));
}

/**
 * Require a non-negative integer option.
 *
 * @param value The option value.
 * @param option The option name, for the error.
 * @returns The value, or `P4InvalidArgumentError`.
 */
export function requireNonNegative(value: number, option: string): Effect.Effect<number, P4InvalidArgumentError> {
  return Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(new P4InvalidArgumentError({
      message: `${option} must be a non-negative integer, received ${String(value)}.`,
      option,
    }));
}

/**
 * Reject an invalid option.
 *
 * @param option The option name.
 * @param message What is wrong with it.
 * @returns A failed effect.
 */
export function invalid(option: string, message: string): Effect.Effect<never, P4InvalidArgumentError> {
  return Effect.fail(new P4InvalidArgumentError({ message, option }));
}

/**
 * Something a batch operation could not do for one of its inputs, such as a
 * missing file or user. The operation itself succeeded.
 */
export interface P4ItemFailure {
  /** The file, spec or name the message is about, or `null` when it names none. */
  readonly spec: string | null;
  readonly reason: P4Reason;
  readonly message: P4Message;
}

/** Template arguments naming what a message is about, in preference order. */
const SUBJECT_ARGS = ['file', 'arg', 'path', 'depotFile', 'clientFile', 'argc'] as const;

/**
 * Describe a per-item failure message, reading what it is about from its
 * template arguments rather than its text.
 *
 * @param message A message the operation's policy disposed as `item`.
 * @returns The failure.
 */
export function itemFailure(message: P4Message): P4ItemFailure {
  const spec = SUBJECT_ARGS.map((key) => message.args[key]).find((value) => value !== undefined && value !== '');
  return { spec: spec ?? null, reason: message.reason, message };
}
