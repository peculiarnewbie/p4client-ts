import { Schema } from 'effect';

/**
 * Specific Perforce outcome recognized from a message.
 *
 * Reasons come from the message's unique code when the server sends one, then
 * from its generic code, and only then from its text. Every reason belongs to
 * exactly one {@link P4Category}.
 */
export const P4ReasonSchema = Schema.Literals([
  'server_unreachable',
  'server_config',
  'not_logged_in',
  'ticket_expired',
  'charset',
  'permission_denied',
  'not_allowed',
  'misconfigured',
  'admin_required',
  'upgrade_required',
  'unknown_client',
  'unknown_user',
  'unknown_changelist',
  'unknown_stream',
  'unknown_revision',
  'unknown_object',
  'no_such_file',
  'not_in_view',
  'not_on_client',
  'not_opened',
  'up_to_date',
  'nothing_to_reconcile',
  'opened_unchanged',
  'empty',
  'clobber',
  'resolve_required',
  'exclusive_open',
  'locked',
  'not_ready',
  'filesystem',
  'fault',
  'client_fault',
  'too_big',
  'usage',
  'invalid_revision',
  'unknown',
]);

/** Specific Perforce outcome recognized from a message. */
export type P4Reason = typeof P4ReasonSchema.Type;

/** Coarse grouping of {@link P4Reason}, stable enough for UI and retry decisions. */
export const P4CategorySchema = Schema.Literals([
  'connection',
  'authentication',
  'permission',
  'configuration',
  'not_found',
  'not_in_view',
  'notice',
  'conflict',
  'filesystem',
  'fault',
  'usage',
  'limit',
  'unknown',
]);

/** Coarse grouping of {@link P4Reason}, stable enough for UI and retry decisions. */
export type P4Category = typeof P4CategorySchema.Type;

const CATEGORIES: { readonly [Reason in P4Reason]: P4Category } = {
  server_unreachable: 'connection',
  server_config: 'configuration',
  not_logged_in: 'authentication',
  ticket_expired: 'authentication',
  charset: 'configuration',
  permission_denied: 'permission',
  not_allowed: 'permission',
  misconfigured: 'configuration',
  admin_required: 'configuration',
  upgrade_required: 'configuration',
  unknown_client: 'not_found',
  unknown_user: 'not_found',
  unknown_changelist: 'not_found',
  unknown_stream: 'not_found',
  unknown_revision: 'not_found',
  unknown_object: 'not_found',
  no_such_file: 'not_found',
  not_in_view: 'not_in_view',
  not_on_client: 'not_found',
  not_opened: 'notice',
  up_to_date: 'notice',
  nothing_to_reconcile: 'notice',
  opened_unchanged: 'notice',
  empty: 'notice',
  clobber: 'filesystem',
  resolve_required: 'conflict',
  exclusive_open: 'conflict',
  locked: 'conflict',
  not_ready: 'conflict',
  filesystem: 'filesystem',
  fault: 'fault',
  client_fault: 'fault',
  too_big: 'limit',
  usage: 'usage',
  invalid_revision: 'usage',
  unknown: 'unknown',
};

/**
 * The category a reason belongs to. Categories are derived, never classified
 * separately, so a reason and its category cannot disagree.
 *
 * @param reason Recognized Perforce outcome.
 * @returns The coarse category of that outcome.
 */
export function categoryOf(reason: P4Reason): P4Category {
  return CATEGORIES[reason];
}

/** Perforce message severity, from `E_EMPTY` (0) to `E_FATAL` (4). */
export const P4SeveritySchema = Schema.Literals(['empty', 'info', 'warning', 'failed', 'fatal']);

/** Perforce message severity, from `E_EMPTY` (0) to `E_FATAL` (4). */
export type P4Severity = typeof P4SeveritySchema.Type;

const SEVERITIES: readonly P4Severity[] = ['empty', 'info', 'warning', 'failed', 'fatal'];

/**
 * Convert a numeric Perforce severity to its name. Values above `E_FATAL` are fatal.
 *
 * @param value Numeric severity from a message row or code.
 * @returns The named severity.
 */
export function severityName(value: number): P4Severity {
  return SEVERITIES[Math.max(0, Math.min(4, Math.trunc(value)))] ?? 'fatal';
}

/**
 * Whether a severity is an error (`E_FAILED` or `E_FATAL`) rather than a notice.
 *
 * @param severity Named severity.
 * @returns `true` for failed and fatal messages.
 */
export function isErrorSeverity(severity: P4Severity): boolean {
  return severity === 'failed' || severity === 'fatal';
}
