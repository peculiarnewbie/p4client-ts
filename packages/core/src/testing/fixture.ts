import { Option, Schema } from 'effect';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A recorded `p4` invocation: the arguments it ran with and exactly what it printed.
 *
 * Fixtures are produced by `scripts/capture-wire.ts` against a disposable server.
 * Paths and ports are normalized to placeholders such as `<WORKSPACE>`.
 */
export const P4WireFixtureSchema = Schema.Struct({
  origin: Schema.String,
  /** Output format requested: `-Mj -z tag`, `-ztag`, `-G`, or plain text. */
  mode: Schema.Literals(['json', 'tagged', 'marshal', 'plain']),
  cwd: Schema.optionalKey(Schema.String),
  charset: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Every argument passed to `p4`, including global options. */
  args: Schema.Array(Schema.String),
  /** Text written to stdin, for `-x -` argument lists. */
  input: Schema.optionalKey(Schema.String),
  exitCode: Schema.Number,
  stopped: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Output as text; `null` for marshal captures, whose output is binary. */
  stdout: Schema.NullOr(Schema.String),
  /** Output as base64, for marshal captures. */
  stdoutBase64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stderr: Schema.String,
});

/** A recorded `p4` invocation: the arguments it ran with and exactly what it printed. */
export type P4WireFixture = typeof P4WireFixtureSchema.Type;

const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(P4WireFixtureSchema));
const readMode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ mode: Schema.String })));

/**
 * The exact bytes a fixture's command wrote to stdout.
 *
 * @param fixture A recorded invocation.
 * @returns Its stdout bytes.
 */
export function fixtureStdout(fixture: P4WireFixture): Uint8Array {
  if (fixture.stdoutBase64) return new Uint8Array(Buffer.from(fixture.stdoutBase64, 'base64'));
  return new TextEncoder().encode(fixture.stdout ?? '');
}

/**
 * Read one fixture file.
 *
 * @param path Path to a fixture `.json` file.
 * @returns The decoded fixture.
 * @throws {Error} When the file is not a command capture.
 */
export function readWireFixture(path: string): P4WireFixture {
  return decodeFixture(readFileSync(path, 'utf8'));
}

/**
 * Read every command capture in a directory, keyed by file name without `.json`.
 * Files that are not command captures, such as golden outputs, are skipped.
 *
 * @param directory Directory of fixture files.
 * @returns Fixtures by name.
 */
export function readWireFixtures(directory: string): ReadonlyMap<string, P4WireFixture> {
  const fixtures = new Map<string, P4WireFixture>();
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const text = readFileSync(join(directory, name), 'utf8');
    if (Option.isNone(readMode(text))) continue;
    fixtures.set(name.slice(0, -'.json'.length), decodeFixture(text));
  }
  return fixtures;
}
