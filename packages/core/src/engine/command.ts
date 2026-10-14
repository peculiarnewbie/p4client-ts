import { Effect, Stream } from 'effect';
import {
  P4CommandError,
  P4ParseError,
  P4ReadOnlyError,
  P4TimeoutError,
  truncateOutput,
} from '../errors.js';
import { connectionEnv, globalArgs, redactArgs } from '../connection/argv.js';
import { P4Executor } from '../exec/executor.js';
import { checkCommand } from '../exec/guard.js';
import { createMarshalDecoder } from '../wire/marshal.js';
import { textMessage } from '../wire/message.js';
import { dispose } from '../wire/policy.js';
import { fromMarshalRecord, readJsonLine, toWireRecord } from '../wire/record.js';
import { P4Config } from './config.js';
import type { P4Error } from '../errors.js';
import type { P4Invocation, P4ProcessEvent } from '../exec/executor.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { WireRecord } from '../wire/record.js';
import type { P4ResolvedOptions } from './config.js';

/** How a command's output is requested: `-Mj -z tag`, `-G`, or plain text. */
export type P4OutputFormat = 'json' | 'marshal' | 'plain';

const FORMAT_ARGS: Readonly<Record<P4OutputFormat, readonly string[]>> = {
  json: ['-Mj', '-z', 'tag'],
  marshal: ['-G'],
  plain: [],
};

/** One structured `p4` command and how to read its data. */
export interface P4CommandSpec<A> {
  /** The subcommand and its arguments, without global options. */
  readonly args: readonly string[];
  /** Structured output format. */
  readonly format: 'json' | 'marshal';
  /** Text for stdin, with `-x -` in `globalArgs`. */
  readonly input?: string | undefined;
  /** Global options this command needs, such as `-x -` or `-I`. */
  readonly globalArgs?: readonly string[] | undefined;
  /** What to do with each message, beyond the defaults. */
  readonly policy?: P4MessagePolicy | undefined;
  /**
   * Convert a data record. Return `null` to skip it. Throw `P4ParseError` for
   * a record without the expected shape.
   */
  readonly decode: (fields: Readonly<Record<string, unknown>>) => A | null;
}

/** Something a structured command produced, in output order. */
export type P4CommandEvent<A> =
  /** A decoded data record. */
  | { readonly _tag: 'data'; readonly value: A }
  /** An informational message, or one saying the request matched nothing. */
  | { readonly _tag: 'message'; readonly message: P4Message }
  /** A per-item failure that does not fail the command. */
  | { readonly _tag: 'failure'; readonly message: P4Message };

/** Everything a structured command produced. */
export interface P4CommandOutput<A> {
  readonly items: A[];
  readonly messages: P4Message[];
  readonly failures: P4Message[];
}

/** A plain-text command, whose stdout is returned as bytes. */
export interface P4PlainCommandSpec {
  readonly args: readonly string[];
  readonly input?: string | undefined;
  readonly globalArgs?: readonly string[] | undefined;
  readonly policy?: P4MessagePolicy | undefined;
  /**
   * Accept a non-zero exit that no failing message explains, for example a
   * diff tool reporting differences. Defaults to rejecting it.
   */
  readonly acceptExit?: ((exitCode: number, stdout: Uint8Array) => boolean) | undefined;
}

/** Output of a plain-text command. */
export interface P4PlainOutput {
  readonly stdout: Uint8Array;
  readonly exitCode: number;
  readonly messages: P4Message[];
  readonly failures: P4Message[];
}

type Context = P4Executor | P4Config;

function invocation(
  options: P4ResolvedOptions,
  format: P4OutputFormat,
  spec: { readonly args: readonly string[]; readonly input?: string | undefined; readonly globalArgs?: readonly string[] | undefined },
): P4Invocation {
  return {
    executable: options.executable,
    args: [...globalArgs(options.connection), ...FORMAT_ARGS[format], ...(spec.globalArgs ?? []), ...spec.args],
    cwd: options.cwd,
    env: { ...options.env, ...connectionEnv(options.connection) },
    input: spec.input,
  };
}

/**
 * Split stderr into diagnostics. `p4` prints a client-side failure as a header
 * followed by tab-indented detail lines, which together form one message.
 */
function groupDiagnostics(text: string): string[] {
  const groups: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const previous = groups.length - 1;
    if (/^\s/.test(line) && previous >= 0 && !groups[previous]!.startsWith('{')) {
      groups[previous] = `${groups[previous]}\n${line.trim()}`;
    } else {
      groups.push(line.trim());
    }
  }
  return groups;
}

/** Accumulates one process's output and turns it into records, messages and a final verdict. */
class OutputReader {
  readonly messages: P4Message[] = [];
  readonly failures: P4Message[] = [];
  readonly fatal: P4Message[] = [];
  private readonly stdoutDecoder = new TextDecoder('utf-8');
  private readonly stderrDecoder = new TextDecoder('utf-8');
  private readonly marshal = createMarshalDecoder();
  private stdoutCarry = '';
  private stderrText = '';
  private retainedStdout = '';
  private readonly stdoutChunks: Uint8Array[] = [];

  constructor(
    private readonly run: P4Invocation,
    private readonly format: P4OutputFormat,
    private readonly policy: P4MessagePolicy | undefined,
  ) {}

  parseError(message: string, line: string, detail: string): P4ParseError {
    return new P4ParseError({
      message,
      line: line.slice(0, 4096),
      detail,
      command: this.run.executable,
      args: redactArgs(this.run.args),
    });
  }

  /** Classify a message; returns it as an event unless it fails the command. */
  classify(received: P4Message): P4CommandEvent<never> | null {
    const disposition = dispose(received, this.policy);
    const message: P4Message = { ...received, disposition };
    if (disposition === 'fail') {
      this.fatal.push(message);
      this.messages.push(message);
      return null;
    }
    if (disposition === 'item') {
      this.failures.push(message);
      return { _tag: 'failure', message };
    }
    this.messages.push(message);
    return { _tag: 'message', message };
  }

  /** Structured records completed by a stdout chunk. */
  stdout(bytes: Uint8Array): WireRecord[] {
    if (this.retainedStdout.length < 65_536) {
      this.retainedStdout += new TextDecoder('utf-8').decode(bytes.subarray(0, 65_536));
    }
    if (this.format === 'plain') {
      this.stdoutChunks.push(bytes);
      return [];
    }
    if (this.format === 'marshal') return this.marshal.push(bytes).map(fromMarshalRecord);
    const lines = (this.stdoutCarry + this.stdoutDecoder.decode(bytes, { stream: true })).split(/\r?\n/);
    this.stdoutCarry = lines.pop() ?? '';
    return lines.flatMap((line) => this.jsonLine(line));
  }

  stderr(bytes: Uint8Array): void {
    this.stderrText += this.stderrDecoder.decode(bytes, { stream: true });
  }

  /** Records still buffered when the process exits, then stderr's diagnostics. */
  finish(exitCode: number): { records: WireRecord[]; stderrMessages: P4Message[] } {
    const records: WireRecord[] = [];
    if (this.format === 'json') {
      records.push(...this.jsonLine(this.stdoutCarry + this.stdoutDecoder.decode()));
    } else if (this.format === 'marshal') {
      this.marshal.end();
    }
    this.stderrText += this.stderrDecoder.decode();
    const stderrMessages = groupDiagnostics(this.stderrText).flatMap((line) => {
      if (!line.startsWith('{')) return [textMessage(line, exitCode)];
      const parsed = readJsonLine(line);
      if (!parsed.ok) throw this.parseError('Unable to parse Perforce diagnostics.', line, parsed.detail);
      const record = toWireRecord(parsed.fields);
      if (record._tag !== 'message') throw this.parseError('Unexpected data on stderr.', line, 'Expected a message.');
      return [record.message];
    });
    return { records, stderrMessages };
  }

  plainStdout(): Uint8Array {
    const total = this.stdoutChunks.reduce((size, chunk) => size + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.stdoutChunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  /** Fail if a message did, or if the exit is unexplained; otherwise accept. */
  verdict(exitCode: number | null, acceptExit: () => boolean): P4CommandError | null {
    const first = this.fatal[0];
    if (first !== undefined) return this.commandError(exitCode, first.text, first);
    if (exitCode === 0) return null;
    if (exitCode !== null && (this.messages.length > 0 || this.failures.length > 0 || acceptExit())) return null;
    const detail = this.stderrText.trim()
      || (exitCode === null ? 'p4 was terminated by a signal.' : 'No diagnostics were reported.');
    return this.commandError(exitCode, detail, null);
  }

  timeoutError(timeoutMs: number): P4TimeoutError {
    const args = redactArgs(this.run.args);
    return new P4TimeoutError({
      message: `${this.run.executable} ${args.join(' ')} timed out after ${timeoutMs}ms.`,
      command: this.run.executable,
      args,
      timeoutMs,
      stdout: truncateOutput(this.retainedStdout),
      stderr: truncateOutput(this.stderrText),
    });
  }

  private commandError(exitCode: number | null, detail: string, message: P4Message | null): P4CommandError {
    const args = redactArgs(this.run.args);
    return new P4CommandError({
      message: `${this.run.executable} ${args.join(' ')} failed (exit ${exitCode ?? 'signal'}): ${detail}`,
      reason: message?.reason ?? 'unknown',
      category: message?.category ?? 'unknown',
      command: this.run.executable,
      args,
      exitCode: exitCode ?? -1,
      messages: this.messages,
      stderr: truncateOutput(this.stderrText),
    });
  }

  private jsonLine(line: string): WireRecord[] {
    if (!line.trim()) return [];
    const parsed = readJsonLine(line);
    if (!parsed.ok) throw this.parseError('Unable to parse tagged Perforce JSON output.', line, parsed.detail);
    return [toWireRecord(parsed.fields)];
  }
}

/** Convert a thrown parse failure into the error channel; anything else is a defect. */
function attempt<A>(reader: OutputReader, f: () => A): Effect.Effect<A, P4ParseError> {
  return Effect.try({
    try: f,
    catch: (error) => {
      if (error instanceof P4ParseError) {
        return error.command === null
          ? reader.parseError(error.message, error.line, error.detail)
          : error;
      }
      throw error;
    },
  });
}

function processStream<A>(
  format: P4OutputFormat,
  spec: Parameters<typeof invocation>[2] & { readonly policy?: P4MessagePolicy | undefined },
  onRecords: (reader: OutputReader, records: WireRecord[]) => Effect.Effect<Array<P4CommandEvent<A>>, P4ParseError>,
  onExit: (reader: OutputReader, code: number | null) => Effect.Effect<Array<P4CommandEvent<A>>, P4Error>,
): Stream.Stream<P4CommandEvent<A>, P4Error, Context> {
  return Stream.unwrap(Effect.gen(function* () {
    const options = yield* P4Config.asEffect();
    const executor = yield* P4Executor.asEffect();
    const run = invocation(options, format, spec);
    if (checkCommand(run.args, run.input).mutates && !options.allowMutation) {
      const args = redactArgs(run.args);
      return yield* new P4ReadOnlyError({
        message: `Refusing to run ${run.executable} ${args.join(' ')}: it can change the server or a workspace, `
          + 'and this client was not created with allowMutation: true.',
        command: run.executable,
        args,
      });
    }
    const reader = new OutputReader(run, format, spec.policy);
    const events = executor.run(run).pipe(
      Stream.mapEffect((event: P4ProcessEvent): Effect.Effect<Array<P4CommandEvent<A>>, P4Error> => {
        if (event._tag === 'stderr') {
          return Effect.sync((): Array<P4CommandEvent<A>> => {
            reader.stderr(event.bytes);
            return [];
          });
        }
        if (event._tag === 'stdout') {
          return attempt(reader, () => reader.stdout(event.bytes)).pipe(
            Effect.flatMap((records) => onRecords(reader, records)),
          );
        }
        return onExit(reader, event.code);
      }),
      Stream.flattenIterable,
    );
    const timeoutMs = options.timeoutMs;
    return timeoutMs === undefined
      ? events
      : events.pipe(Stream.interruptWhen(
        Effect.sleep(timeoutMs).pipe(Effect.andThen(Effect.suspend(() => Effect.fail(reader.timeoutError(timeoutMs))))),
      ));
  }));
}

/**
 * Run a structured command as a stream of data, messages and per-item failures.
 *
 * Messages are classified by the spec's policy. A message that fails the
 * command, or a non-zero exit nothing explains, fails the stream after the
 * process has exited, so every earlier event has already been emitted.
 *
 * @param spec The command and how to read its data.
 * @returns Events in output order.
 */
export function streamCommand<A>(spec: P4CommandSpec<A>): Stream.Stream<P4CommandEvent<A>, P4Error, Context> {
  const toEvents = (reader: OutputReader, records: WireRecord[]) =>
    attempt(reader, () => records.flatMap((record): Array<P4CommandEvent<A>> => {
      if (record._tag === 'message') {
        const event = reader.classify(record.message);
        return event === null ? [] : [event];
      }
      const value = spec.decode(record.fields);
      return value === null ? [] : [{ _tag: 'data', value }];
    }));
  return processStream<A>(
    spec.format,
    spec,
    toEvents,
    (reader, code) => Effect.gen(function* () {
      const { records, stderrMessages } = yield* attempt(reader, () => reader.finish(code ?? 1));
      const events = yield* toEvents(reader, records);
      for (const message of stderrMessages) {
        const event = reader.classify(message);
        if (event !== null) events.push(event);
      }
      const error = reader.verdict(code, () => false);
      if (error !== null) return yield* error;
      return events;
    }),
  );
}

/**
 * Run a structured command and collect its output.
 *
 * This is {@link streamCommand} folded, so both report the same items,
 * messages and failures.
 *
 * @param spec The command and how to read its data.
 * @returns Decoded items with the messages and per-item failures.
 */
export function runCommand<A>(spec: P4CommandSpec<A>): Effect.Effect<P4CommandOutput<A>, P4Error, Context> {
  return Stream.runFold(
    streamCommand(spec),
    (): P4CommandOutput<A> => ({ items: [], messages: [], failures: [] }),
    (output, event) => {
      if (event._tag === 'data') output.items.push(event.value);
      else if (event._tag === 'message') output.messages.push(event.message);
      else output.failures.push(event.message);
      return output;
    },
  );
}

/**
 * Run a plain-text command, such as `diff2`, whose stdout is content rather than records.
 *
 * Diagnostics on stderr are classified like structured messages.
 *
 * @param spec The command.
 * @returns Its stdout bytes, exit code, messages and per-item failures.
 */
export function runPlainCommand(spec: P4PlainCommandSpec): Effect.Effect<P4PlainOutput, P4Error, Context> {
  return processStream<P4PlainOutput>(
    'plain',
    spec,
    () => Effect.succeed([]),
    (reader, code) => Effect.gen(function* () {
      const { stderrMessages } = yield* attempt(reader, () => reader.finish(code ?? 1));
      for (const message of stderrMessages) reader.classify(message);
      const stdout = reader.plainStdout();
      const error = reader.verdict(code, () => code !== null && (spec.acceptExit?.(code, stdout) ?? false));
      if (error !== null) return yield* error;
      const output: P4PlainOutput = { stdout, exitCode: code ?? 0, messages: reader.messages, failures: reader.failures };
      return [{ _tag: 'data', value: output }];
    }),
  ).pipe(
    Stream.runFold(
      (): P4PlainOutput => ({ stdout: new Uint8Array(0), exitCode: 0, messages: [], failures: [] }),
      (output, event) => (event._tag === 'data' ? event.value : output),
    ),
  );
}
