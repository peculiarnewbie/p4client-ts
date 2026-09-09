import { Schema } from 'effect';
import { P4ParseError } from '../public/errors.js';
import {
  P4DepotPathSchema,
  P4ChangeSchema,
  P4FileActionSchema,
  P4NonNegativeIntegerSchema,
  P4PositiveIntegerSchema
} from '../public/schemas.js';

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));
const Integer = Schema.optionalKey(Schema.NullOr(P4NonNegativeIntegerSchema));
const Action = Schema.optionalKey(Schema.NullOr(P4FileActionSchema));
const FileFields = {
  depotFile: P4DepotPathSchema,
  action: Action,
  type: Text,
  rev: Integer,
  change: Integer
};

export const DepotRow = Schema.Struct({ name: Schema.NonEmptyString, type: Text, map: Text, desc: Text });
export const DirRow = Schema.Struct({ dir: P4DepotPathSchema });
export const FileRow = Schema.Struct(FileFields);
export const DescribedFileRow = Schema.Struct({ ...FileFields, action: P4FileActionSchema });
export const FileRevisionRow = Schema.Struct({
  depotFile: P4DepotPathSchema,
  rev: P4PositiveIntegerSchema,
  change: P4PositiveIntegerSchema,
  action: P4FileActionSchema,
  type: Schema.NonEmptyString
});
export const OpenedRow = Schema.Struct({
  ...FileFields,
  depotFile: Schema.optionalKey(Schema.NullOr(P4DepotPathSchema)),
  action: P4FileActionSchema,
  change: Schema.optionalKey(Schema.NullOr(P4ChangeSchema)),
  clientFile: Text, path: Text, desc: Text, user: Text, client: Text
});
const SyncFields = Schema.Struct({
  ...FileFields,
  depotFile: Schema.optionalKey(Schema.NullOr(P4DepotPathSchema)),
  clientFile: Text, path: Text, fileSize: Integer
});
export const SyncRow = SyncFields.check(Schema.makeFilter(
  (row: typeof SyncFields.Type) => row.depotFile != null || row.action != null,
  { expected: 'a sync row with a depot path or action' }
));
export const ChangelistRow = Schema.Struct({
  change: P4ChangeSchema, client: Text, user: Text, time: Text, desc: Text, status: Text
});
export const StatRow = Schema.Struct({
  ...FileFields,
  change: Schema.optionalKey(Schema.NullOr(P4ChangeSchema)),
  headAction: Action, headType: Text, headRev: Integer, haveRev: Integer,
  headChange: Integer, headTime: Text, fileSize: Integer, digest: Text, clientFile: Text
});
export const WhereRow = Schema.Struct({
  depotFile: Schema.String.check(Schema.isPattern(/^-?\/\/[^/\\\s][^\\\0\r\n]*$/)),
  clientFile: Text, path: Text
});
export const HistoryRevisionRow = Schema.Struct({
  rev: P4PositiveIntegerSchema, change: Integer, action: Action, type: Text,
  time: Text, user: Text, client: Text, desc: Text, digest: Text, fileSize: Integer
});
export const UserRow = Schema.Struct({
  User: Schema.NonEmptyString, Email: Text, FullName: Text, Type: Text, Access: Text
});
export const StreamRow = Schema.Struct({
  Stream: P4DepotPathSchema, Name: Text, Owner: Text,
  Parent: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Literal('none'), P4DepotPathSchema]))),
  Type: Text, desc: Text
});
export const AnnotationRow = Schema.Struct({ upper: P4NonNegativeIntegerSchema, data: Schema.String });
export const MessageRow = Schema.Struct({ data: Schema.String, severity: Integer, generic: Integer, code: Text });
export const AnnotationHeaderRow = Schema.Struct({ depotFile: P4DepotPathSchema, rev: Text });

/** Decode CLI data and keep the complete offending row in the public error. */
export function decodeRow<A>(schema: Schema.Decoder<A>, row: unknown, source: unknown = row): A {
  try {
    return Schema.decodeUnknownSync(schema)(row, { onExcessProperty: 'preserve' });
  } catch (cause) {
    throw new P4ParseError('Invalid Perforce command output.', JSON.stringify(source) ?? String(source), cause);
  }
}
