import type { P4Reason } from './reasons.js';

/**
 * Text recognition for messages without a code: failures `p4` prints before reaching a server,
 * plain-text stderr and info rows with only a `level`. Structured output carries codes, so this
 * is the only module that classifies English text; a test enforces that.
 */

/** Ordered: the first pattern that matches the message, after its subject, wins. */
const TEXT_REASONS: ReadonlyArray<readonly [RegExp, P4Reason]> = [
  [/connect to server failed|tcp connect to .+ failed|connection refused|WSAECONNREFUSED|no such host|network is unreachable|WSAETIMEDOUT/i, 'server_unreachable'],
  [/check \$?P4PORT|P4PORT invalid|ssl.*(?:init|handshake).*fail|authenticity of .+ can't be established/i, 'server_config'],
  [/session has expired|ticket.*expired/i, 'ticket_expired'],
  [/password.*(?:invalid|unset)|login.*required|not logged in/i, 'not_logged_in'],
  [/unicode.*(?:require|permit)|translation (?:of|failed)|(?:unknown|invalid|unsupported) (?:character set|charset)|P4CHARSET/i, 'charset'],
  [/(?:no|don't have) permission|permission denied|access (?:for|to) .* denied|protected namespace/i, 'permission_denied'],
  [/not in (?:the )?client view|must refer to client/i, 'not_in_view'],
  [/opened and not being changed/i, 'opened_unchanged'],
  [/must resolve/i, 'resolve_required'],
  [/exclusive file already opened/i, 'exclusive_open'],
  [/locked by/i, 'locked'],
  [/currently opened for|can't add \(already opened for/i, 'already_opened'],
  [/can't add existing file/i, 'exists_in_depot'],
  [/associated with it and can't be deleted/i, 'changelist_not_empty'],
  [/can't clobber writable file|can't overwrite existing file/i, 'clobber'],
  [/^(?:rename|unlink|remove|read|write|chmod|mkdir|rmdir|lstat|stat|open(?: for (?:read|write))?):\s/i, 'filesystem'],
  [/file\(s\) up-to-date/i, 'up_to_date'],
  [/not opened on this client/i, 'not_opened'],
  [/no file\(s\) to reconcile/i, 'nothing_to_reconcile'],
  [/file\(s\) not on client/i, 'not_on_client'],
  [/no file\(s\) at that revision|unknown revision/i, 'unknown_revision'],
  [/invalid revision/i, 'invalid_revision'],
  [/no such file\(s\)/i, 'no_such_file'],
  [/no such changelist|change .+ unknown/i, 'unknown_changelist'],
  [/no such user|user .+ (?:doesn't exist|unknown)/i, 'unknown_user'],
  [/no such stream/i, 'unknown_stream'],
  [/client .+ unknown|unknown client/i, 'unknown_client'],
  [/^usage:|invalid option|unknown option/i, 'usage'],
];

/** Remove a leading `<path> - ` so that file names cannot match a pattern. */
export function stripMessageSubject(text: string): string {
  return text.replace(/^(?:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*? - /, '');
}

/** Recognize a message that carries no code. */
export function textReason(text: string): P4Reason {
  const subject = stripMessageSubject(text.trim());

  for (const [pattern, reason] of TEXT_REASONS) {
    if (pattern.test(subject)) return reason;
  }

  return 'unknown';
}

/** Reasons that describe an empty or unchanged result rather than a failure. */
const NOTICE_REASONS = new Set<P4Reason>([
  'no_such_file', 'not_on_client', 'not_opened', 'up_to_date', 'nothing_to_reconcile',
  'opened_unchanged', 'unknown_revision', 'empty', 'resolve_required', 'locked', 'already_opened',
]);

/**
 * Severity of a plain-text diagnostic, which carries none of its own. Known
 * empty-result notices stay warnings even when `p4` exits non-zero.
 */
export function textSeverity(reason: P4Reason, exitCode: number): number {
  return NOTICE_REASONS.has(reason) || exitCode === 0 ? 2 : 3;
}

/** Recover a path subject from a diagnostic without a format template. */
export function textSubject(text: string): Readonly<Record<string, string>> {
  const match = /^(?<file>(?:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*?) - /.exec(text);

  return match?.groups?.file === undefined ? {} : { file: match.groups.file };
}

/** The changelist number in `p4 change -i` output (`Change 42 created.`). */
export function createdChangeNumber(text: string): number | null {
  const match = /^Change (\d+) created\b/m.exec(text);

  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Who else has a file open, from the notice `edit` and `add` print after a
 * refused exclusive open: `<file> - also opened by <user>@<client>` or
 * `<file> - locked by <user>@<client>`.
 */
export function openHolder(text: string): { readonly file: string; readonly holder: string } | null {
  const match = /^(?<file>(?:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*?) - (?:also opened|locked) by (?<holder>\S+)$/.exec(text.trim());
  const file = match?.groups?.file;
  const holder = match?.groups?.holder;

  return file === undefined || holder === undefined ? null : { file, holder };
}
