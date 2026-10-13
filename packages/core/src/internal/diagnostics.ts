import { Option, Schema } from 'effect';
import { P4MessageRowSchema } from '../public/schemas.js';
import type { P4CommandResult } from '../public/types.js';

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeMessage = Schema.decodeUnknownOption(P4MessageRowSchema);
const GLOBAL_VALUE_FLAGS = new Set(['-b', '-c', '-C', '-d', '-H', '-L', '-p', '-P', '-Q', '-r', '-u', '-v', '-x', '-z']);
const PAYLOAD_COMMANDS = new Set(['print', 'diff', 'diff2', 'annotate']);

/** Remove a leading `<path> - ` so file names cannot match failure patterns. */
export function stripMessageSubject(text: string): string {
  return text.replace(/^(?:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*? - /, '');
}

/** The Perforce subcommand after global options, when present. */
function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) return arg;
    if (GLOBAL_VALUE_FLAGS.has(arg)) index++;
  }
  return undefined;
}

/** Extract diagnostics without treating tagged data or plain file payloads as error text. */
export function diagnosticText(result: P4CommandResult): string {
  const messages: Array<{ text: string; error: boolean }> = [];
  const plain: string[] = [];
  const read = (output: string, allowPlain: boolean): void => {
    for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
      if (!line.trim().startsWith('{')) {
        if (allowPlain) plain.push(line);
        continue;
      }
      const record = decodeRecord(line);
      if (Option.isNone(record)) continue;
      const row = record.value;
      if (
        row.severity === undefined &&
        row.level === undefined &&
        !['error', 'warning', 'info'].includes(String(row.code))
      )
        continue;
      const message = decodeMessage(row);
      if (Option.isSome(message))
        messages.push({
          text: stripMessageSubject(message.value.data),
          error:
            Number(message.value.severity) >= 3 ||
            message.value.code === 'error',
        });
    }
  };
  read(result.stderr, true);
  const payloadCommand = PAYLOAD_COMMANDS.has(subcommand(result.args) ?? '');
  if (!payloadCommand || result.args.includes('-Mj')) {
    read(
      result.stdout,
      !result.stderr.trim() && !payloadCommand && !result.args.includes('-Mj'),
    );
  }
  const errors = messages.filter((message) => message.error);
  return [
    ...(errors.length ? errors : messages).map((message) => message.text),
    ...plain,
  ].join('\n');
}
