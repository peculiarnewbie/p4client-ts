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
  | "command";

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
    this.category = category ?? classifyP4Error(message);
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
    super(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms.`);
    this.name = "P4TimeoutError";
    this.command = command;
    this.args = args;
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
 * Tagged errors surfaced by the Effect service API.
 */
export type P4ServiceError =
  | P4CommandError
  | P4TimeoutError
  | P4ParseError
  | P4ClientOperationError;
