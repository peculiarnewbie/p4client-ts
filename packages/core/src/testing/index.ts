import { P4 } from '../P4.js';
import type { Layer } from 'effect';
import type { P4TestOps } from '../P4.js';

export * from './executor.js';

export * from './fixture.js';

/** Methods supplied by a test, with optional watched method overrides. */
export type { P4TestOps } from '../P4.js';

/**
 * Provide only the operations a test expects. Unspecified calls die with a descriptive error.
 * Watched methods default to a single done event from the corresponding mock.
 */
export const layerTest = (partialOps: P4TestOps): Layer.Layer<P4> => P4.layerTest(partialOps);
