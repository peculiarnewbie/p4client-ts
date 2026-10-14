import type { P4Message } from '../wire/message.js';
import type { P4Reason } from '../wire/reasons.js';

/**
 * Something a batch operation could not do for one of its inputs, such as a
 * missing file or user. The operation itself succeeded.
 */
export interface P4ItemFailure {
  /** The file, spec or name the message is about, or `null` when it names none. */
  readonly spec: string | null;
  readonly reason: P4Reason;
  readonly message: P4Message;
}

/** Template arguments naming what a message is about, in preference order. */
const SUBJECT_ARGS = ['file', 'arg', 'path', 'depotFile', 'clientFile', 'argc'] as const;

/**
 * Describe a per-item failure message, reading what it is about from its
 * template arguments rather than its text.
 *
 * @param message A message the operation's policy disposed as `item`.
 * @returns The failure.
 */
export function itemFailure(message: P4Message): P4ItemFailure {
  const spec = SUBJECT_ARGS.map((key) => message.args[key]).find((value) => value !== undefined && value !== '');
  return { spec: spec ?? null, reason: message.reason, message };
}
