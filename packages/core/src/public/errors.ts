import { formatCommandArgs, redactCommandArgs } from "./command-format.js";
import type { P4CommandResult } from "./types.js";

/**
 * Structured error categories for Perforce CLI failures.
 *
 * - `"connection"` – DNS resolution, TCP connect, or server unavailable
 * - `"authentication"` – login required, ticket expired, password invalid
 * - `"server_config"` – missing or invalid P4PORT / SSL config
 * - `"client"` – unknown or invalid workspace / client spec
 * - `"command"` – any other non-zero exit (the default bucket)
 */
export type P4ErrorCategory =
  | "connection"
  | "authentication"
  | "server_config"
  | "client"
  | 'permission'
  | 'not_in_view'
  | 'revision'
  | 'changelist'
  | 'user'
  | 'charset'
  | "command";

/** Specific failure case, independent of the CLI's exit status. */
export type P4FailureReason = 'server_unreachable' | 'not_logged_in' | 'ticket_expired'
  | 'permission_denied' | 'not_in_view' | 'unknown_revision' | 'unknown_changelist'
  | 'unknown_user' | 'unknown_client' | 'charset' | 'clobber' | 'command';

/** Classify recognizable Perforce failure text without relying on exit status. */
export function classifyP4Failure(text: string): P4FailureReason {
  if (/session has expired|ticket.*expired/i.test(text)) return 'ticket_expired';
  if (/password.*invalid|password.*unset|login.*required|not logged in/i.test(text)) return 'not_logged_in';
  if (/(?:no|have|denied) permission|permission denied|access (?:for|to).*denied|protected namespace/i.test(text)) return 'permission_denied';
  if (/not in (?:the )?client view|must refer to client/i.test(text)) return 'not_in_view';
  if (/invalid revision|no file\(s\) at that revision|unknown revision/i.test(text)) return 'unknown_revision';
  if (/no such changelist|unknown changelist|change .+ unknown/i.test(text)) return 'unknown_changelist';
  if (/no such user|user .+ (?:doesn.t exist|unknown)|unknown user/i.test(text)) return 'unknown_user';
  if (/client .+ unknown|unknown.*client|client .+doesn.t exist/i.test(text)) return 'unknown_client';
  if (/can.t clobber writable file|can.t overwrite existing file/i.test(text)) return 'clobber';
  if (/unicode.*(?:require|permit)|translation (?:of|failed)|(?:unknown|invalid|unsupported) (?:character set|charset)|P4CHARSET.*(?:must|invalid|unknown)/i.test(text)) return 'charset';
  if (/connect to server failed|tcp connect|no such host|connection refused|network is unreachable|WSAECONNREFUSED/i.test(text)) return 'server_unreachable';
  return 'command';
}

// Order matters: patterns are evaluated top-down; first match wins.
const categoryPatterns: readonly { category: P4ErrorCategory; pattern: RegExp }[] = [
  // Connection / DNS / server unreachable
  { category: "connection", pattern: /connect to server failed/i },
  { category: "connection", pattern: /tcp connect to .+ failed/i },
  { category: "connection", pattern: /no such host/i },
  { category: "connection", pattern: /connection refused/i },
  { category: "connection", pattern: /network is unreachable/i },
  { category: "connection", pattern: /timed? ?out/i },

  // Server / port configuration
  { category: "server_config", pattern: /check \$?P4PORT/i },
  { category: "server_config", pattern: /P4PORT invalid/i },
  { category: "server_config", pattern: /ssl.*init.*fail/i },

  // Authentication / login
  { category: "authentication", pattern: /your session has expired/i },
  { category: "authentication", pattern: /password.*invalid/i },
  { category: "authentication", pattern: /perforce password.*\(P4PASSWD\)/i },
  { category: "authentication", pattern: /login.*required/i },
  { category: "authentication", pattern: /ticket.*expired/i },

  // Client / workspace
  { category: "client", pattern: /unknown.*client/i },
  { category: "client", pattern: /client '.*' unknown/i },
  { category: "client", pattern: /has not been set/i },
];

const connectionErrorPatterns: readonly RegExp[] = [
  /connect to server failed/i,
  /check \$?P4PORT/i,
  /tcp connect to .+ failed/i,
  /no such host/i,
  /connection refused/i,
  /network is unreachable/i,
  /wsaetimedout/i
];

/**
 * Classify a Perforce command failure from combined stderr/stdout text.
 *
 * This helper maps common Perforce CLI failures into coarse categories that are
 * stable enough for UI and application error handling.
 *
 * @returns `"command"` when no more specific category matches.
 */
export function classifyP4Error(text: string): P4ErrorCategory {
  const reason = classifyP4Failure(text);
  const categories: Partial<Record<P4FailureReason, P4ErrorCategory>> = {
    server_unreachable: 'connection', not_logged_in: 'authentication', ticket_expired: 'authentication',
    permission_denied: 'permission', not_in_view: 'not_in_view', unknown_revision: 'revision',
    unknown_changelist: 'changelist', unknown_user: 'user', unknown_client: 'client', charset: 'charset'
  };
  if (categories[reason] !== undefined) return categories[reason];
  for (const { category, pattern } of categoryPatterns) {
    if (pattern.test(text)) {
      return category;
    }
  }
  return "command";
}

/**
 * Conservative classifier for failures that indicate an unreachable Perforce
 * server or invalid connection endpoint.
 */
export function isP4ConnectionError(error: unknown): boolean {
  const text = error instanceof P4CommandError
    ? [error.message, error.result.stderr, error.result.stdout].filter(Boolean).join("\n")
    : error instanceof Error
      ? error.message
      : String(error);

  return connectionErrorPatterns.some((pattern) => pattern.test(text));
}

/**
 * Error thrown when a `p4` command exits non-zero and non-zero exits were not allowed.
 *
 * The raw {@link P4CommandResult} is preserved on {@link P4CommandError.result}
 * for debugging, while {@link P4CommandError.category} provides a typed failure
 * bucket for control flow.
 */
export class P4CommandError extends Error {
  readonly _tag = "P4CommandError";
  readonly result: P4CommandResult;

  /**
   * Structured category of the failure – callers can `switch` on this
   * instead of parsing the error message string.
   */
  readonly category: P4ErrorCategory;
  /** Specific recognized failure, including zero-exit warning failures. */
  readonly reason: P4FailureReason;

  /**
   * Create a typed wrapper for a failed Perforce command result.
   *
   * @param message Human-readable failure message.
   * @param result Raw command result including stdout, stderr, and exit code.
   * @param category Optional explicit category. When omitted, the category is
   * inferred from the message text.
   */
  constructor(message: string, result: P4CommandResult, category?: P4ErrorCategory) {
    super(message);
    this.name = "P4CommandError";
    this.result = result;
    const text = [result.stderr, result.stdout, message].join('\n');
    this.category = category ?? classifyP4Error(text);
    this.reason = classifyP4Failure(text);
  }
}

/**
 * Error thrown when a child `p4` process exceeds a configured timeout.
 */
export class P4TimeoutError extends Error {
  readonly _tag = "P4TimeoutError";
  readonly command: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;

  /**
   * Create a typed timeout error for a killed Perforce subprocess.
   *
   * @param command Executable that was invoked.
   * @param args Final argument vector passed to the command.
   * @param timeoutMs Timeout in milliseconds that was exceeded.
   * @param stdout Partial stdout captured before termination.
   * @param stderr Partial stderr captured before termination.
   */
  constructor(
    command: string,
    args: string[],
    timeoutMs: number,
    stdout = "",
    stderr = ""
  ) {
    super(`${command} ${formatCommandArgs(args)} timed out after ${timeoutMs}ms.`);
    this.name = "P4TimeoutError";
    this.command = command;
    this.args = redactCommandArgs(args);
    this.timeoutMs = timeoutMs;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Error thrown when Perforce tagged JSON output cannot be parsed or validated.
 */
export class P4ParseError extends Error {
  readonly _tag = "P4ParseError";
  readonly line: string;
  readonly cause: unknown;
  /** Executable and argument vector when parsing was part of a client command. */
  command: string | undefined;
  args: string[] | undefined;

  /**
   * Create a typed parse error for malformed CLI output.
   *
   * @param message Human-readable parse failure.
   * @param line Raw output line that failed parsing or validation.
   * @param cause Original parser or schema error.
   */
  constructor(message: string, line: string, cause: unknown) {
    super(message);
    this.name = "P4ParseError";
    this.line = line;
    this.cause = cause;
  }

  /**
   * Attach command context while preserving the original row and schema cause.
   * @param command Executable used for the malformed response.
   * @param args Command arguments, redacted before retention.
   * @returns This error with command context attached.
   */
  withCommand(command: string, args: readonly string[]): this {
    this.command = command;
    this.args = redactCommandArgs([...args]);
    return this;
  }
}

/**
 * Tagged wrapper for unexpected failures raised while bridging `P4Client` into Effect.
 */
export class P4ClientOperationError extends Error {
  readonly _tag = "P4ClientOperationError";
  readonly cause: unknown;

  /**
   * Create a tagged wrapper for an unexpected client operation failure.
   */
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "P4ClientOperationError";
    this.cause = cause;
  }
}

/**
 * Error raised before depot materialization when its bounded or filesystem
 * safety invariants are not satisfied.
 */
export class P4MaterializationError extends Error {
  readonly _tag = "P4MaterializationError";
  readonly reason: "limit_exceeded" | "invalid_depot_path" | "invalid_destination";
  readonly cause: unknown;

  /**
   * Create a typed materialization failure.
   *
   * @param message Human-readable failure description.
   * @param reason Stable category suitable for caller control flow.
   * @param cause Original validation or filesystem failure, when available.
   */
  constructor(
    message: string,
    reason: P4MaterializationError["reason"],
    cause: unknown = null
  ) {
    super(message);
    this.name = "P4MaterializationError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Tagged errors surfaced by the Effect service API.
 */
export type P4ServiceError =
  | P4CommandError
  | P4TimeoutError
  | P4ParseError
  | P4MaterializationError
  | P4ClientOperationError;
