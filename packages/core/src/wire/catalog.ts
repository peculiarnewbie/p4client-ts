import type { P4Reason } from './reasons.js';

/** Fields packed into a Perforce `ErrorId` code (`code0`). */
export interface P4MessageCode {
  /** Severity, `E_EMPTY` (0) to `E_FATAL` (4). */
  readonly severity: number;
  /** Number of arguments the server substituted into the template. */
  readonly argc: number;
  /** Generic code (`EV_*`), shared by related messages across subsystems. */
  readonly generic: number;
  /** Server subsystem (`ES_*`) that defines the message. */
  readonly subsystem: number;
  /** Message number within the subsystem. */
  readonly subcode: number;
}

/**
 * Unpack `code0`: `severity << 28 | argc << 24 | generic << 16 | subsystem << 10 | subcode`.
 *
 * @param code0 The message's unique code as sent by `p4 -Mj` or `p4 -G`.
 * @returns The packed fields.
 */
export function decodeMessageCode(code0: number): P4MessageCode {
  const code = code0 >>> 0;
  return {
    severity: code >>> 28,
    argc: (code >>> 24) & 0x0f,
    generic: (code >>> 16) & 0xff,
    subsystem: (code >>> 10) & 0x3f,
    subcode: code & 0x3ff,
  };
}

/**
 * Identify a message independently of its severity and argument count.
 *
 * @param code Unpacked message code.
 * @returns `subsystem:subcode`, the key used by {@link MESSAGE_CATALOG}.
 */
export function messageKey(code: P4MessageCode): string {
  return `${code.subsystem}:${code.subcode}`;
}

interface CatalogEntry {
  readonly reason: P4Reason;
  /** Narrow the reason from the message's named arguments. */
  readonly refine?: (args: Readonly<Record<string, string>>) => P4Reason;
}

const UNKNOWN_SPEC: Readonly<Record<string, P4Reason>> = {
  client: 'unknown_client',
  user: 'unknown_user',
  change: 'unknown_changelist',
  stream: 'unknown_stream',
};

/**
 * Messages recognized by their unique code, keyed by `subsystem:subcode`.
 *
 * Each entry is verified against the captured wire corpus. Subsystems: 0 OS,
 * 1 support, 6 data manager, 7 server, 8 client.
 */
export const MESSAGE_CATALOG: ReadonlyMap<string, CatalogEntry> = new Map<string, CatalogEntry>([
  // %operation%: %arg%: %errmsg% — an operating-system call failed on the client.
  ['0:1', { reason: 'filesystem' }],
  // Invalid option: -%option%.
  ['1:4', { reason: 'usage' }],
  // Invalid revision number '%rev%'.
  ['6:17', { reason: 'invalid_revision' }],
  // %type% '%name%' unknown - use '%command%' command to create it.
  ['6:35', {
    reason: 'unknown_object',
    refine: (args) => UNKNOWN_SPEC[(args.type ?? '').toLowerCase()] ?? 'unknown_object',
  }],
  // You don't have permission for this operation.
  ['6:41', { reason: 'permission_denied' }],
  // %path% - must refer to client '%client%' or a depot.
  ['6:100', { reason: 'not_in_view' }],
  // [%argc% - no|No] such changelist.
  ['6:365', { reason: 'unknown_changelist' }],
  // [%argc% - no|No] such user(s).
  ['6:366', { reason: 'unknown_user' }],
  // [%argc% - file(s)|File(s)] not in client view.
  ['6:367', { reason: 'not_in_view' }],
  // [%argc% - no|No] such file(s).
  ['6:375', { reason: 'no_such_file' }],
  // [%argc% - file(s)|File(s)] not on client.
  ['6:376', { reason: 'not_on_client' }],
  // [%argc% - file(s)|File(s)] not opened on this client.
  ['6:382', { reason: 'not_opened' }],
  // [%argc% - file(s)|File(s)] up-to-date.
  ['6:388', { reason: 'up_to_date' }],
  // [%argc% - no|No] file(s) at that revision.
  ['6:398', { reason: 'unknown_revision' }],
  // [%argc% - no|No] such stream.
  ['6:508', { reason: 'unknown_stream' }],
  // [%argc% - no|No] file(s) to reconcile.
  ['6:683', { reason: 'nothing_to_reconcile' }],
  // %depotFile% - can't %action% exclusive file already opened[ for %otherclntaction%]
  ['6:980', { reason: 'exclusive_open' }],
  // Perforce password (%'P4PASSWD'%) invalid or unset.
  ['7:21', { reason: 'not_logged_in' }],
  // Unicode server permits only unicode enabled clients.
  ['7:22', { reason: 'charset' }],
  // Your session has expired, please %'login'% again.
  ['7:312', { reason: 'ticket_expired' }],
  // Can't clobber writable file %file%
  ['8:4', { reason: 'clobber' }],
]);

/**
 * Reasons for generic codes (`EV_*`), used when a message's unique code is not
 * cataloged. `EV_NONE` (0) carries no information and is absent.
 */
export const GENERIC_REASONS: ReadonlyMap<number, P4Reason> = new Map<number, P4Reason>([
  [0x01, 'usage'], // EV_USAGE
  [0x02, 'unknown_object'], // EV_UNKNOWN
  [0x03, 'usage'], // EV_CONTEXT
  [0x04, 'not_allowed'], // EV_ILLEGAL
  [0x05, 'not_ready'], // EV_NOTYET
  [0x06, 'permission_denied'], // EV_PROTECT
  [0x11, 'empty'], // EV_EMPTY
  [0x21, 'fault'], // EV_FAULT
  [0x22, 'client_fault'], // EV_CLIENT
  [0x23, 'admin_required'], // EV_ADMIN
  [0x24, 'misconfigured'], // EV_CONFIG
  [0x25, 'upgrade_required'], // EV_UPGRADE
  [0x26, 'server_unreachable'], // EV_COMM
  [0x27, 'too_big'], // EV_TOOBIG
]);

/**
 * Look up a cataloged message.
 *
 * @param code Unpacked message code.
 * @param args Named arguments recovered from the message template.
 * @returns The specific reason, or `null` when the code is not cataloged.
 */
export function catalogReason(code: P4MessageCode, args: Readonly<Record<string, string>>): P4Reason | null {
  const entry = MESSAGE_CATALOG.get(messageKey(code));
  if (entry === undefined) return null;
  return entry.refine ? entry.refine(args) : entry.reason;
}
