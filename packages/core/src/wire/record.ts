import { Data, Exit, Schema } from 'effect';
import { isMessageRecord, toMessage } from './message.js';
import type { MarshalRecord } from './marshal.js';
import type { P4Message } from './message.js';
import type { P4WireFields, P4WireValue } from './value.js';

export type { P4WireFields, P4WireValue } from './value.js';

/** One structured output record: data, or a message about the command. */
export type WireRecord =
  | { readonly _tag: 'data'; readonly fields: P4WireFields }
  | { readonly _tag: 'message'; readonly message: P4Message };

/** Constructors and guards for {@link WireRecord}. */
export const WireRecord = Data.taggedEnum<WireRecord>();

/** Result of reading one `-Mj` output line. */
export type JsonLineResult =
  | { readonly ok: true; readonly fields: P4WireFields }
  | { readonly ok: false; readonly detail: string };

const decodeObject = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const textDecoder = new TextDecoder('utf-8');

/** `-G` records whose `data` is file content, which must stay as bytes. */
const CONTENT_CODES = new Set(['text', 'binary']);

/**
 * Read one line of `p4 -Mj -z tag` output as an object.
 *
 * @param line One output line, without its line terminator.
 * @returns The decoded fields, or why the line is not a JSON object.
 */
export function readJsonLine(line: string): JsonLineResult {
  const exit = decodeObject(line);

  if (!Exit.isSuccess(exit)) return { ok: false, detail: 'Expected one JSON object per line.' };

  // SAFETY: the schema parsed the line with JSON.parse and checked it is an object, and JSON.parse
  // only produces strings, numbers, booleans, null, arrays and objects, all of them P4WireValues.
  // Validating every value again would cost a pass over each row for nothing.
  return { ok: true, fields: exit.value as P4WireFields };
}

/**
 * Classify a decoded record as data or a message.
 *
 * @param fields The record's fields.
 * @returns A data record, or a message record with its classification.
 */
export function toWireRecord(fields: P4WireFields): WireRecord {
  return isMessageRecord(fields)
    ? WireRecord.message({ message: toMessage(fields) })
    : WireRecord.data({ fields });
}

/**
 * Interpret a `-G` record. Strings decode as UTF-8, apart from the `data` of
 * `text` and `binary` content records, which stays as the exact bytes printed.
 *
 * @param record One decoded marshal dictionary.
 * @returns A data record, or a message record with its classification.
 */
export function fromMarshalRecord(record: MarshalRecord): WireRecord {
  const code = record.code instanceof Uint8Array ? textDecoder.decode(record.code) : null;
  const keepBytes = code !== null && CONTENT_CODES.has(code);
  const fields: Record<string, P4WireValue> = {};

  for (const [key, value] of Object.entries(record)) {
    fields[key] = value instanceof Uint8Array && !(keepBytes && key === 'data')
      ? textDecoder.decode(value)
      : value;
  }

  return toWireRecord(fields);
}
