import { P4ParseError } from '../errors.js';

/** A value in a `p4 -G` record. Strings stay as bytes until the record is interpreted. */
export type MarshalValue = Uint8Array | number | boolean | null;

/** One `p4 -G` output record: a Python marshal dictionary. */
export type MarshalRecord = Readonly<Record<string, MarshalValue>>;

/** Incremental decoder for the stream of marshal dictionaries `p4 -G` writes. */
export interface MarshalDecoder {
  /**
   * Decode every record completed by this chunk. Partial records are kept for the next chunk.
   *
   * @throws {P4ParseError} When the bytes are not marshal dictionaries.
   */
  push(chunk: Uint8Array): MarshalRecord[];
  /**
   * Confirm the stream ended on a record boundary.
   *
   * @throws {P4ParseError} When a partial record remains.
   */
  end(): void;
}

const INCOMPLETE = Symbol('incomplete');
const keyDecoder = new TextDecoder('utf-8');

function parseError(detail: string, bytes: Uint8Array): P4ParseError {
  return new P4ParseError({
    message: 'Unable to decode Perforce marshal output.',
    // Latin-1 keeps every byte visible without depending on Node's Buffer.
    line: String.fromCharCode(...bytes.subarray(0, 4096)),
    detail,
    command: null,
    args: null,
  });
}

/**
 * Create a decoder for `p4 -G` output.
 *
 * @returns A decoder that accepts output chunks in order.
 */
export function createMarshalDecoder(): MarshalDecoder {
  let pending = new Uint8Array(0);

  const readValue = (
    bytes: Uint8Array,
    view: DataView,
    offset: number,
  ): readonly [MarshalValue, number] | typeof INCOMPLETE => {
    if (offset >= bytes.length) return INCOMPLETE;
    const type = String.fromCharCode(bytes[offset]!);
    const start = offset + 1;
    switch (type) {
      case 's':
      case 'u':
      case 't': {
        if (start + 4 > bytes.length) return INCOMPLETE;
        const length = view.getInt32(start, true);
        if (length < 0) throw parseError(`Negative string length ${length}.`, bytes);
        const end = start + 4 + length;
        if (end > bytes.length) return INCOMPLETE;
        return [bytes.slice(start + 4, end), end];
      }
      case 'i':
        if (start + 4 > bytes.length) return INCOMPLETE;
        return [view.getInt32(start, true), start + 4];
      case 'N':
        return [null, start];
      case 'T':
        return [true, start];
      case 'F':
        return [false, start];
      default:
        throw parseError(`Unsupported marshal type '${type}' at byte ${offset}.`, bytes);
    }
  };

  const readRecord = (
    bytes: Uint8Array,
    view: DataView,
    offset: number,
  ): readonly [MarshalRecord, number] | typeof INCOMPLETE => {
    if (bytes[offset] !== 0x7b /* { */) {
      throw parseError(`Expected a marshal dictionary at byte ${offset}.`, bytes);
    }
    const record: Record<string, MarshalValue> = {};
    let cursor = offset + 1;
    for (;;) {
      if (cursor >= bytes.length) return INCOMPLETE;
      if (bytes[cursor] === 0x30 /* 0: end of dictionary */) return [record, cursor + 1];
      const key = readValue(bytes, view, cursor);
      if (key === INCOMPLETE) return INCOMPLETE;
      if (!(key[0] instanceof Uint8Array)) throw parseError('A marshal dictionary key is not a string.', bytes);
      const value = readValue(bytes, view, key[1]);
      if (value === INCOMPLETE) return INCOMPLETE;
      record[keyDecoder.decode(key[0])] = value[0];
      cursor = value[1];
    }
  };

  return {
    push(chunk) {
      const bytes = new Uint8Array(pending.length + chunk.length);
      bytes.set(pending);
      bytes.set(chunk, pending.length);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const records: MarshalRecord[] = [];
      let offset = 0;
      while (offset < bytes.length) {
        const result = readRecord(bytes, view, offset);
        if (result === INCOMPLETE) break;
        records.push(result[0]);
        offset = result[1];
      }
      pending = bytes.slice(offset);
      return records;
    },
    end() {
      if (pending.length > 0) throw parseError('Marshal output ended inside a record.', pending);
    },
  };
}
