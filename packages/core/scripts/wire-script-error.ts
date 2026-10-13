/** Typed failures at the wire-validation script boundary. */
export class WireScriptError extends Error {
  readonly _tag = 'WireScriptError';
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WireScriptError';
    this.cause = cause;
  }
}
