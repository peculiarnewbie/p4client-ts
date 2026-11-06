import { Schema } from 'effect';

/**
 * One field of a structured output record: what `-Mj` JSON (strings, numbers, booleans, `null`,
 * arrays, objects) or `-G` marshal (strings, numbers, booleans, `None`, bytes) can carry.
 */
export type P4WireValue = string | number | boolean | null | Uint8Array | readonly P4WireValue[] | P4WireFields;

/** The fields of one structured output record, by name. */
export interface P4WireFields {
  readonly [field: string]: P4WireValue;
}

/** Whether a field is a string. */
export const isWireString = Schema.is(Schema.String);

/** Whether a field is a finite number. */
export const isWireNumber = Schema.is(Schema.Finite);
