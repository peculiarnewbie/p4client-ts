import { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../../src/schemas.js';

/** A depot path for an expectation, validated as the library validates command output. */
export const asDepotPath = (value: string): P4DepotPath => P4DepotPath.make(value);

/** A client-syntax path for an expectation. */
export const asClientPath = (value: string): P4ClientPath => P4ClientPath.make(value);

/** A local path for an expectation. */
export const asLocalPath = (value: string): P4LocalPath => P4LocalPath.make(value);

/** A file action for an expectation. */
export const asAction = (value: string): P4FileAction => P4FileAction.make(value);
