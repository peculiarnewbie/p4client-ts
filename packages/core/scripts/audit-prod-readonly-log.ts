import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateProductionRead } from './prod-readonly-p4.js';

const Config = Schema.Struct({ scratchDir: Schema.String });
const Record = Schema.Struct({
  event: Schema.Literals(['start', 'exit']),
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  exitCode: Schema.optionalKey(Schema.Int),
});

/** Replay a private log through the guard without running any subprocess. */
export function auditProductionLog(configPath: string): {
  starts: number;
  exits: number;
  forbidden: number;
  commands: { [command: string]: number };
} {
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(Config))(
    readFileSync(configPath, 'utf8'),
  );
  const log = readFileSync(join(config.scratchDir, 'commands.jsonl'), 'utf8');
  let active: string | undefined;
  let starts = 0;
  let exits = 0;
  const commands: { [command: string]: number } = {};
  for (const line of log.trim().split('\n').filter(Boolean)) {
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(
      line,
    );
    if (record.event === 'start') {
      if (active || record.args?.[0] !== '-p' || record.args[2] !== '-u') {
        throw new Error('Invalid or overlapping production command log.');
      }
      const args = record.args.slice(record.args[4] === '-c' ? 6 : 4);
      const command = validateProductionRead(args, config.scratchDir);
      if (command !== record.command)
        throw new Error('Command does not match its log entry.');
      active = command;
      starts += 1;
      commands[command] = (commands[command] ?? 0) + 1;
    } else {
      if (active !== record.command || record.exitCode === undefined) {
        throw new Error(
          'Missing command start or exit status in the production log.',
        );
      }
      active = undefined;
      exits += 1;
    }
  }
  if (active || starts !== exits)
    throw new Error('A production command has no logged exit.');
  return { starts, exits, forbidden: 0, commands };
}

if (import.meta.main) {
  Effect.runPromise(
    Effect.sync(() => {
      const path = process.argv[2];
      if (!path) throw new Error('Pass the private guard configuration path.');
      console.log(JSON.stringify(auditProductionLog(path)));
    }),
  ).catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
