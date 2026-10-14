import { VERSION } from '../version.js';

/**
 * The Perforce server, user and workspace commands run against.
 *
 * Values given here are passed as command-line global options (`-p`, `-u`,
 * `-c`, `-C`, `-H`), which take precedence over P4CONFIG files, environment
 * variables and `p4 set`. Omitted values fall back to that usual resolution.
 */
export interface P4Connection {
  /** Server address (`P4PORT`), for example `ssl:perforce:1666`. */
  readonly port?: string | undefined;
  /** User name (`P4USER`). */
  readonly user?: string | undefined;
  /** Workspace name (`P4CLIENT`). */
  readonly client?: string | undefined;
  /** Character set (`P4CHARSET`), for example `utf8`. */
  readonly charset?: string | undefined;
  /** Host name reported to the server (`P4HOST`). */
  readonly host?: string | undefined;
  /**
   * Ignore P4CONFIG and P4ENVIRO files, so inherited settings cannot
   * redirect commands. Use with explicit `port`, `user` and `client`.
   */
  readonly isolated?: boolean | undefined;
}

/** Nonexistent enviro path used by isolated connections. */
export const ISOLATED_P4ENVIRO = 'p4client-ts.isolated-no-enviro';

/** P4CONFIG names a file searched for in each parent directory; this one never exists. */
export const ISOLATED_P4CONFIG = 'p4client-ts.isolated-no-config';

/**
 * Global options for a connection, plus program identification for server logs.
 *
 * @param connection Explicit connection values.
 * @returns Arguments to place before the subcommand.
 */
export function globalArgs(connection: P4Connection): string[] {
  const args: string[] = [];
  if (connection.port) args.push('-p', connection.port);
  if (connection.user) args.push('-u', connection.user);
  if (connection.client) args.push('-c', connection.client);
  if (connection.charset) args.push('-C', connection.charset);
  if (connection.host) args.push('-H', connection.host);
  args.push(`-zprog=p4client-ts`, `-zversion=${VERSION}`);
  return args;
}

/**
 * Environment changes a connection requires.
 *
 * @param connection Explicit connection values.
 * @returns Variables to set; isolation points `P4CONFIG` and `P4ENVIRO` at files that never exist.
 */
export function connectionEnv(connection: P4Connection): Record<string, string | undefined> {
  return connection.isolated ? { P4CONFIG: ISOLATED_P4CONFIG, P4ENVIRO: ISOLATED_P4ENVIRO } : {};
}

/**
 * Copy an argument vector with password-like values replaced by `***`.
 *
 * @param args Arguments as passed to `p4`.
 * @returns Arguments safe to log or return in errors.
 */
export function redactArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-P' || arg === '--password') {
      redacted.push(arg, '***');
      index += 1;
    } else if (arg.startsWith('-P') && arg.length > 2) {
      redacted.push('-P***');
    } else if (/^P4PASSWD=/i.test(arg)) {
      redacted.push('P4PASSWD=***');
    } else {
      redacted.push(arg);
    }
  }
  return redacted;
}
