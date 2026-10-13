import { classifyP4Error, classifyP4Failure } from '../public/errors.js';
import { P4MessageRowSchema } from '../public/schemas.js';
import { stripMessageSubject } from './diagnostics.js';
import { decodeRow } from './rows.js';
import type { P4Message, P4MessageCarrier } from '../public/types.js';

const FATAL_MESSAGE_REASONS = new Set<P4Message['reason']>([
  'server_unreachable',
  'not_logged_in',
  'ticket_expired',
  'permission_denied',
  'not_in_view',
  'unknown_changelist',
  'unknown_user',
  'unknown_client',
  'charset',
]);

/** Warning-level missing revisions stay non-fatal; global failures do not depend on severity. */
export function isFatalMessage(message: P4Message): boolean {
  return message.kind === 'error' || FATAL_MESSAGE_REASONS.has(message.reason);
}

/** Preserve sync's per-file failure contract while keeping connection/session/spec failures fatal. */
export function isSyncFileError(message: P4Message): boolean {
  if (
    message.kind !== 'error' ||
    (message.raw.severity === undefined && message.raw.code !== 'error')
  )
    return false;
  // Filesystem permission failures are per-file errors, distinct from server protection failures.
  if (
    /^(?:rename|unlink|remove|read|write|chmod|mkdir|rmdir|lstat|open(?: for (?:read|write))?):\s|can't clobber writable file|can't overwrite existing file/i.test(
      message.message.trim(),
    )
  )
    return true;
  return (
    !FATAL_MESSAGE_REASONS.has(message.reason) &&
    classifyP4Error(stripMessageSubject(message.message)) === 'command'
  );
}

function messageReason(message: string): P4Message['reason'] {
  const text = stripMessageSubject(message);
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

/** Carry typed messages through arrays and objects without changing their JSON representation. */
export function withMessages<A extends object>(
  value: A,
  source: P4MessageCarrier,
): A & P4MessageCarrier {
  if (source.messages?.length)
    Object.defineProperty(value, 'messages', {
      value: source.messages,
      enumerable: false,
      configurable: true,
    });
  return value;
}
