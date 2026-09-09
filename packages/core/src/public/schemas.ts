import { Schema } from 'effect';

const PathText = Schema.String.check(Schema.isPattern(/\S/), Schema.isPattern(/^[^\0\r\n]+$/));
const PerforcePath = PathText.check(Schema.isPattern(/^\/\/[^/\\\s][^\\]*$/));

/** Validate a depot-syntax path, including depot roots and filespecs. */
export const P4DepotPathSchema = PerforcePath.pipe(Schema.brand('P4DepotPath'));

/** Validate a client-syntax path beginning with `//client`. */
export const P4ClientPathSchema = PerforcePath.pipe(Schema.brand('P4ClientPath'));

/** Validate a non-empty local path without NUL or line-break characters. */
export const P4LocalPathSchema = PathText.pipe(Schema.brand('P4LocalPath'));

/** Validate an action token, allowing future Perforce actions without an enum update. */
export const P4FileActionSchema = Schema.String.check(
  Schema.isPattern(/^[a-z]+(?:\/[a-z]+)*$/)
).pipe(Schema.brand('P4FileAction'));

/** Decode a decimal CLI integer or JSON number without truncation or precision loss. */
export const P4NonNegativeIntegerSchema = Schema.Union([
  Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(Schema.decodeTo(Schema.NumberFromString)),
  Schema.Number
]).check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Decode a positive revision or numbered changelist from CLI output. */
export const P4PositiveIntegerSchema = P4NonNegativeIntegerSchema.check(Schema.isGreaterThan(0));

/** Decode the default changelist sentinel or a non-negative numbered changelist. */
export const P4ChangeSchema = Schema.Union([Schema.Literal('default'), P4NonNegativeIntegerSchema]);

/** Runtime contract for the required and optional fields emitted by `p4 clients`. */
export const P4JsonWorkspaceSchema = Schema.Struct({
  client: Schema.NonEmptyString,
  Stream: Schema.optionalKey(Schema.String),
  Root: Schema.NonEmptyString,
  Host: Schema.optionalKey(Schema.String),
  Owner: Schema.NonEmptyString,
  Access: Schema.optionalKey(Schema.String),
  Update: Schema.optionalKey(Schema.String)
});
