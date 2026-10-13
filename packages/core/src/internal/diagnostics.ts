import { Option, Schema } from 'effect';
import { P4MessageRowSchema } from '../public/schemas.js';
import type { P4CommandResult } from '../public/types.js';

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeMessage = Schema.decodeUnknownOption(P4MessageRowSchema);

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
          text: message.value.data,
          error:
            Number(message.value.severity) >= 3 ||
            message.value.code === 'error',
        });
    }
  };
  read(result.stderr, true);
  const payloadCommand = result.args.some((arg) =>
    ['print', 'diff', 'diff2', 'annotate'].includes(arg),
  );
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
