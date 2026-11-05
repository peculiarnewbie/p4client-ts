import { Schema } from 'effect';
import { P4ClientPathSchema, P4DepotPathSchema, P4FileActionSchema, P4LocalPathSchema } from '../../src/schemas.js';

/** A depot path for an expectation, validated as the library validates command output. */
export const asDepotPath = Schema.decodeSync(P4DepotPathSchema);

/** A client-syntax path for an expectation. */
export const asClientPath = Schema.decodeSync(P4ClientPathSchema);

/** A local path for an expectation. */
export const asLocalPath = Schema.decodeSync(P4LocalPathSchema);

/** A file action for an expectation. */
export const asAction = Schema.decodeSync(P4FileActionSchema);
