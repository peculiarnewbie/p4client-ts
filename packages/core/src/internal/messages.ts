import { classifyP4Failure } from '../public/errors.js';
import { P4MessageRowSchema } from '../public/schemas.js';
import { decodeRow } from './rows.js';
import type { P4Message, P4MessageCarrier } from '../public/types.js';

function messageReason(text: string): P4Message['reason'] {
  if (/opened and not being changed/i.test(text)) return 'opened_unchanged';
  if (/must resolve/i.test(text)) return 'resolve_required';
  if (/exclusive file already opened/i.test(text)) return 'exclusive_open';
  if (/file\(s\) up-to-date/i.test(text)) return 'up_to_date';
  if (/not opened on this client/i.test(text)) return 'not_opened';
  if (
    /no such file\(s\)|no file\(s\) (?:to reconcile|at that changelist)|file\(s\) not on client/i.test(
      text,
    )
  )
    return 'empty';
  return classifyP4Failure(text);
}

/** Message discriminants do not overlap with annotate's data/upper content rows. */
export function readMessage(row: Record<string, unknown>): P4Message | null {
  if (
    row.severity === undefined &&
    row.level === undefined &&
    !['error', 'warning', 'info'].includes(String(row.code))
  )
    return null;
  const parsed = decodeRow(P4MessageRowSchema, row);
  const severity = parsed.severity ?? null;
  return {
    kind:
      severity === null
        ? row.code === 'error'
          ? 'error'
          : row.code === 'warning'
            ? 'warning'
            : 'info'
        : severity >= 3
          ? 'error'
          : severity === 2
            ? 'warning'
            : 'info',
    message: parsed.data,
    severity,
    level: parsed.level ?? null,
    generic: parsed.generic ?? null,
    code: parsed.code ?? null,
    reason: messageReason(parsed.data),
    raw: row,
  };
}

/** Carry typed messages through arrays without changing their ordinary JSON representation. */
export function withMessages<A extends object>(
  value: A,
  source: P4MessageCarrier,
): A & P4MessageCarrier {
  if (source.messages?.length)
    Object.defineProperty(value, 'messages', {
      value: source.messages,
      enumerable: !Array.isArray(value),
      configurable: true,
    });
  return value;
}
