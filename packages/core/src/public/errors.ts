import type { P4CommandResult } from "./types.js";

export class P4CommandError extends Error {
  readonly result: P4CommandResult;

  constructor(message: string, result: P4CommandResult) {
    super(message);
    this.name = "P4CommandError";
    this.result = result;
  }
}
