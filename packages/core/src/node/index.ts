import { Layer } from 'effect';
import { P4 } from '../P4.js';
import { configLayer } from '../engine/config.js';
import { NodeP4Executor } from './executor.js';
import type { P4ClientOptions, P4Config } from '../engine/config.js';
import type { P4InvalidArgumentError } from '../errors.js';
import type { P4Executor } from '../exec/executor.js';

export * from './executor.js';
export * from './connection.js';
export * from './workspace.js';
export * from './materialize.js';

/**
 * Provide the P4 service, configuration and Node executor.
 * @param options Immutable command configuration.
 * @returns A layer usable by P4 operations and the Node-only helpers.
 */
export function layerNode(options: P4ClientOptions = {}):
  Layer.Layer<P4 | P4Config | P4Executor, P4InvalidArgumentError> {
  return P4.layer.pipe(Layer.provideMerge(Layer.merge(configLayer(options), NodeP4Executor)));
}
