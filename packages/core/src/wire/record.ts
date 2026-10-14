import { Exit, Schema } from 'effect';
import { isMessageRecord, toMessage } from './message.js';
import type { MarshalRecord } from './marshal.js';
import type { P4Message } from './message.js';

/** One structured output record: data, or a message about the command. */
export type WireRecord =
  | { readonly _tag: 'data'; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly _tag: 'message'; readonly message: P4Message };

/** Result of reading one `-Mj` output line. */
export type JsonLineResult =
  | { readonly ok: true; readonly fields: Record<string, unknown> }
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
  return Exit.isSuccess(exit)
    ? { ok: true, fields: exit.value }
    : { ok: false, detail: 'Expected one JSON object per line.' };
}

/**
 * Classify a decoded record as data or a message.
 *
 * @param fields The record's fields.
 * @returns A data record, or a message record with its classification.
 */
export function toWireRecord(fields: Readonly<Record<string, unknown>>): WireRecord {
  return isMessageRecord(fields)
    ? { _tag: 'message', message: toMessage(fields) }
    : { _tag: 'data', fields };
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
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    fields[key] = value instanceof Uint8Array && !(keepBytes && key === 'data')
      ? textDecoder.decode(value)
      : value;
  }
  return toWireRecord(fields);
}
