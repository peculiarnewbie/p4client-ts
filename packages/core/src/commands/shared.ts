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
import { isWireNumber, isWireString } from '../wire/value.js';
import type { P4Message } from '../wire/message.js';
import type { P4WireFields, P4WireValue } from '../wire/value.js';

/** A decoded output record, as received. */
export type Row = P4WireFields;

/** One field of a {@link Row}; `undefined` when the record has no such field. */
export type Field = P4WireValue | undefined;

/** One file spec or several. */
export type FileSpecs = string | readonly string[];

/**
 * Decode a value from a command's output. Throws `P4ParseError`, which the
 * engine completes with the command that produced the row.
 */
export function decodeField<A>(schema: Schema.Decoder<A>, value: Field, row: Field = value): A {
  try {
    return Schema.decodeSync(schema)(value, { onExcessProperty: 'ignore' });
  } catch (cause) {
    throw new P4ParseError({
      message: 'Invalid Perforce command output.',
      line: (JSON.stringify(row) ?? 'undefined').slice(0, 4096),
      detail: String(cause),
      command: null,
      args: null,
    });
  }
}

/**
 * A parse error for output without the expected shape. Throw it from a
 * decoder, or `yield*` it from a program.
 */
export function malformed(message: string, evidence: Field | readonly P4Message[]): P4ParseError {
  return new P4ParseError({
    message,
    line: (JSON.stringify(evidence) ?? 'undefined').slice(0, 4096),
    detail: message,
    command: null,
    args: null,
  });
}

/** A trimmed non-empty string field, or `null`. */
export function text(value: Field): string | null {
  if (!isWireString(value)) return null;
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/** A description field: trailing line breaks removed, otherwise as written. */
export function description(value: Field): string | null {
  return isWireString(value) && value.trim() ? value.replace(/\s+$/, '') : null;
}

const Integer = Schema.NullOr(P4NonNegativeIntegerSchema);

/** A non-negative integer field, or `null` when absent. */
export function integer(value: Field, row: Row): number | null {
  return value === undefined || value === '' ? null : decodeField(Integer, value, row);
}

/** A positive integer field that must be present. */
export function positive(value: Field, row: Row): number {
  return decodeField(P4PositiveIntegerSchema, value, row);
}

/** A changelist field: a number or `default`. */
export function change(value: Field, row: Row): number | 'default' {
  return decodeField(P4ChangeSchema, value, row);
}

/** A depot path field that must be present. */
export function depotPath(value: Field, row: Row): P4DepotPath {
  return decodeField(P4DepotPathSchema, isWireString(value) ? value.trim() : value, row);
}

/** A depot path field, or `null` when absent. */
export function optionalDepotPath(value: Field, row: Row): P4DepotPath | null {
  return value === undefined || value === null || value === '' ? null : depotPath(value, row);
}

/** A file action field that must be present. */
export function action(value: Field, row: Row): P4FileAction {
  return decodeField(P4FileActionSchema, value, row);
}

/** A file action field, or `null` when absent. */
export function optionalAction(value: Field, row: Row): P4FileAction | null {
  return value === undefined || value === null || value === '' ? null : action(value, row);
}

/** A local path field, or `null` when absent. */
export function localPath(value: Field, row: Row): P4LocalPath | null {
  const trimmed = text(value);

  return trimmed === null ? null : decodeField(P4LocalPathSchema, trimmed, row);
}

/**
 * A `clientFile` field, which is client syntax (`//client/...`) or, for some
 * commands, a local path.
 */
export function clientFile(value: Field, row: Row): P4ClientPath | P4LocalPath | null {
  const trimmed = text(value);

  if (trimmed === null) return null;

  return trimmed.startsWith('//') ? decodeField(P4ClientPathSchema, trimmed, row) : localPath(trimmed, row);
}

/** Convert a Unix time in seconds, as Perforce prints it, to ISO 8601. */
export function isoFromSeconds(value: Field): string | null {
  const seconds = isWireNumber(value) ? value : isWireString(value) && value.trim() ? Number(value) : NaN;

  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The file specs as a list. */
export function specList(specs: FileSpecs | undefined): string[] {
  if (specs === undefined) return [];

  return isWireString(specs) ? [specs] : [...specs];
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

/** Require a positive integer option. */
export function requirePositive(value: number, option: string): Effect.Effect<number, P4InvalidArgumentError> {
  return Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(new P4InvalidArgumentError({
      message: `${option} must be a positive integer, received ${String(value)}.`,
      option,
    }));
}

/** Require a non-negative integer option. */
export function requireNonNegative(value: number, option: string): Effect.Effect<number, P4InvalidArgumentError> {
  return Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(new P4InvalidArgumentError({
      message: `${option} must be a non-negative integer, received ${String(value)}.`,
      option,
    }));
}

/** Reject an invalid option. */
export function invalid(option: string, message: string): Effect.Effect<never, P4InvalidArgumentError> {
  return Effect.fail(new P4InvalidArgumentError({ message, option }));
}

export { itemFailure } from '../engine/failure.js';

export type { P4ItemFailure } from '../engine/failure.js';
