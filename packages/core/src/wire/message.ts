import { Schema } from 'effect';
import { GENERIC_REASONS, catalogReason, decodeMessageCode } from './catalog.js';
import { textReason, textSeverity } from './fallback.js';
import {
  P4CategorySchema,
  P4ReasonSchema,
  P4SeveritySchema,
  categoryOf,
  severityName,
} from './reasons.js';
import { matchTemplate } from './template.js';
import type { P4MessageCode } from './catalog.js';
import type { P4Reason } from './reasons.js';

/** Unpacked `code0` fields of a message. */
export const P4MessageCodeSchema = Schema.Struct({
  severity: Schema.Number,
  argc: Schema.Number,
  generic: Schema.Number,
  subsystem: Schema.Number,
  subcode: Schema.Number,
});

/**
 * A diagnostic Perforce reported alongside, or instead of, data.
 *
 * Messages are plain data, so they survive `structuredClone` and Electron IPC.
 */
export const P4MessageSchema = Schema.Struct({
  /** The formatted message, without its trailing newline. */
  text: Schema.String,
  severity: P4SeveritySchema,
  reason: P4ReasonSchema,
  category: P4CategorySchema,
  /** Unpacked unique code, or `null` for messages without one. */
  code: Schema.NullOr(P4MessageCodeSchema),
  /** The server's `fmt0` template, or `null`. */
  template: Schema.NullOr(Schema.String),
  /** Template arguments recovered from the text, such as `file` or `path`. */
  args: Schema.Record(Schema.String, Schema.String),
  /** Whether the reason came from the unique code, the generic code, or the text. */
  reasonSource: Schema.Literals(['code', 'generic', 'text']),
  /** The message row as received, for diagnostics. */
  raw: Schema.Record(Schema.String, Schema.Unknown),
});

/** A diagnostic Perforce reported alongside, or instead of, data. */
export type P4Message = typeof P4MessageSchema.Type;

const MESSAGE_CODES = new Set(['error', 'warning', 'info']);

/**
 * Whether a structured output record is a message rather than data.
 *
 * `-Mj` messages carry `code0`, `severity` or `level`; `-G` messages carry
 * `code: 'error' | 'info'`. Data rows, including `-G` `stat`/`text`/`binary`
 * records and annotate's `data` rows, carry none of these.
 *
 * @param fields One decoded output record.
 * @returns `true` for a message record.
 */
export function isMessageRecord(fields: Readonly<Record<string, unknown>>): boolean {
  return (
    fields.code0 !== undefined ||
    fields.severity !== undefined ||
    fields.level !== undefined ||
    (typeof fields.code === 'string' && MESSAGE_CODES.has(fields.code))
  );
}

function numberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function numericSeverity(fields: Readonly<Record<string, unknown>>, code: P4MessageCode | null): number {
  const explicit = numberField(fields.severity);
  if (explicit !== null) return explicit;
  if (code !== null) return code.severity;
  if (fields.code === 'error') return 3;
  if (fields.code === 'warning') return 2;
  return 1;
}

function resolveReason(
  code: P4MessageCode | null,
  generic: number | null,
  args: Readonly<Record<string, string>>,
  text: string,
): { reason: P4Reason; reasonSource: P4Message['reasonSource'] } {
  const cataloged = code === null ? null : catalogReason(code, args);
  if (cataloged !== null) return { reason: cataloged, reasonSource: 'code' };
  const fromGeneric = generic === null ? undefined : GENERIC_REASONS.get(generic);
  if (fromGeneric !== undefined) return { reason: fromGeneric, reasonSource: 'generic' };
  return { reason: textReason(text), reasonSource: 'text' };
}

/**
 * Recover the arguments of a message's primary part. Multi-part messages
 * (`code0`, `code1`, …) print their parts in reverse, so the primary part is
 * the trailing lines of the text.
 */
function matchPrimaryPart(template: string, text: string): Readonly<Record<string, string>> {
  const lines = text.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const args = matchTemplate(template, lines.slice(start).join('\n'));
    if (args !== null) return args;
  }
  return {};
}

/**
 * Build a typed message from a structured message record.
 *
 * @param fields A record for which {@link isMessageRecord} is true.
 * @returns The classified message.
 */
export function toMessage(fields: Readonly<Record<string, unknown>>): P4Message {
  const code0 = numberField(fields.code0);
  const code = code0 === null ? null : decodeMessageCode(code0);
  const text = String(fields.data ?? '').trimEnd();
  const template = typeof fields.fmt0 === 'string' ? fields.fmt0 : null;
  const args = template === null ? {} : matchPrimaryPart(template, text);
  const generic = numberField(fields.generic) ?? code?.generic ?? null;
  const { reason, reasonSource } = resolveReason(code, generic, args, text);
  return {
    text,
    severity: severityName(numericSeverity(fields, code)),
    reason,
    category: categoryOf(reason),
    code,
    template,
    args,
    reasonSource,
    raw: { ...fields },
  };
}

/**
 * Build a typed message from a plain-text diagnostic line.
 *
 * Plain text carries no severity: recognized empty-result notices are warnings,
 * and anything else is a failure when the command exited non-zero.
 *
 * @param text One diagnostic line.
 * @param exitCode Exit code of the command that printed it.
 * @returns The classified message.
 */
export function textMessage(text: string, exitCode: number): P4Message {
  const trimmed = text.trimEnd();
  const reason = textReason(trimmed);
  return {
    text: trimmed,
    severity: severityName(textSeverity(reason, exitCode)),
    reason,
    category: categoryOf(reason),
    code: null,
    template: null,
    args: {},
    reasonSource: 'text',
    raw: { data: trimmed },
  };
}
