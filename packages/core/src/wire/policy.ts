import { isErrorSeverity } from './reasons.js';
import type { P4Message } from './message.js';
import type { P4Reason } from './reasons.js';

/**
 * What an operation does with a message.
 *
 * - `fail`: the operation fails with a `P4CommandError`.
 * - `item`: a per-item failure, returned in the result's `failures`.
 * - `empty`: the request matched nothing; returned in `messages`.
 * - `notice`: informational; returned in `messages`.
 */
export type P4Disposition = 'fail' | 'item' | 'empty' | 'notice';

/** Per-operation overrides of the default disposition, by reason. */
export type P4MessagePolicy = Readonly<Partial<Record<P4Reason, P4Disposition>>>;

/**
 * Reasons that fail an operation whatever their severity: the session,
 * connection or workspace cannot be used, or a named object does not exist.
 * Operations that query several objects at once override the last group to `item`.
 */
const ALWAYS_FAIL = new Set<P4Reason>([
  'server_unreachable',
  'server_config',
  'not_logged_in',
  'ticket_expired',
  'charset',
  'permission_denied',
  'misconfigured',
  'admin_required',
  'upgrade_required',
  'unknown_client',
  'not_in_view',
  'unknown_changelist',
  'unknown_user',
]);

/** Reasons meaning the request matched nothing. */
const EMPTY_REASONS = new Set<P4Reason>([
  'empty',
  'no_such_file',
  'not_on_client',
  'not_opened',
  'up_to_date',
  'nothing_to_reconcile',
  'unknown_revision',
  'unknown_stream',
]);

/**
 * Decide what an operation does with a message: its policy first, then the defaults.
 *
 * By default, errors and the reasons in `ALWAYS_FAIL` fail the operation;
 * warnings that a request matched nothing are `empty`; everything else is a `notice`.
 *
 * @param message A classified message.
 * @param policy The operation's overrides.
 * @returns The disposition.
 */
export function dispose(message: P4Message, policy: P4MessagePolicy = {}): P4Disposition {
  const override = policy[message.reason];
  if (override !== undefined) return override;
  if (ALWAYS_FAIL.has(message.reason) || isErrorSeverity(message.severity)) return 'fail';
  if (EMPTY_REASONS.has(message.reason) || message.code?.generic === 0x11) return 'empty';
  return 'notice';
}
