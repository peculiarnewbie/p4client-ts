import { Effect } from 'effect';
import { runCommand } from '../engine/command.js';
import { operation, progressCounter } from '../engine/operation.js';
import { openedCommand } from './opened.js';
import {
  action,
  change,
  depotPath,
  description,
  indexes,
  integer,
  invalid,
  isoFromSeconds,
  malformed,
  text,
} from './shared.js';
import type { P4DepotPath, P4FileAction } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { Row } from './shared.js';

/** Options for {@link describeChangelist}. */
export interface DescribeChangelistOptions {
  readonly change: number | 'default';
  /** Describe the files shelved in a pending changelist, rather than those opened in it. */
  readonly shelved?: boolean | undefined;
  /** For the default changelist: the workspace whose default changelist to describe. */
  readonly client?: string | undefined;
}

/** A file in a described changelist. */
export interface P4DescribedFile {
  readonly depotFile: P4DepotPath;
  readonly action: P4FileAction;
  readonly type: string | null;
  readonly revision: number | null;
  /** MD5 of the content, for shelved and submitted files. */
  readonly digest: string | null;
  readonly fileSize: number | null;
}

/**
 * A changelist and its files.
 *
 * `status` is `shelved` when shelved files of a pending changelist were
 * requested; a submitted changelist stays `submitted` either way.
 */
export interface P4ChangelistDescription {
  readonly change: number | 'default';
  readonly status: 'pending' | 'submitted' | 'shelved';
  readonly user: string | null;
  readonly client: string | null;
  readonly description: string | null;
  readonly createdAt: string | null;
  readonly files: P4DescribedFile[];
  readonly messages: P4Message[];
}

function describedFiles(row: Row): P4DescribedFile[] {
  return indexes(row, 'depotFile').map((index) => ({
    depotFile: depotPath(row[`depotFile${index}`], row),
    action: action(row[`action${index}`], row),
    type: text(row[`type${index}`]),
    revision: integer(row[`rev${index}`], row),
    digest: text(row[`digest${index}`]),
    fileSize: integer(row[`fileSize${index}`], row),
  }));
}

function describeDefault(options: DescribeChangelistOptions) {
  return Effect.gen(function* () {
    if (options.shelved) return yield* invalid('shelved', 'Only a numbered changelist can have shelved files.');
    const opened = yield* runCommand(openedCommand({ change: 'default', client: options.client }));
    const first = opened.items[0];
    const description: P4ChangelistDescription = {
      change: 'default',
      status: 'pending',
      user: first?.user ?? null,
      client: options.client ?? first?.client ?? null,
      description: first?.changeDescription ?? 'Default changelist',
      createdAt: null,
      files: opened.items.flatMap((file) => file.depotFile === null ? [] : [{
        depotFile: file.depotFile,
        action: file.action,
        type: file.type,
        revision: file.revision,
        digest: null,
        fileSize: null,
      }]),
      messages: opened.messages,
    };
    return description;
  });
}

function describeNumbered(number: number, shelved: boolean) {
  return Effect.gen(function* () {
    const args = shelved ? ['describe', '-S', '-s', String(number)] : ['describe', '-s', String(number)];
    const output = yield* runCommand({
      args,
      format: 'json',
      decode: (row): Omit<P4ChangelistDescription, 'messages'> | null => row.change === undefined ? null : {
        change: change(row.change, row),
        status: text(row.status) === 'submitted' ? 'submitted' : shelved ? 'shelved' : 'pending',
        user: text(row.user),
        client: text(row.client),
        description: description(row.desc),
        createdAt: isoFromSeconds(row.time),
        files: describedFiles(row),
      },
    });
    const described = output.items[0];
    if (described === undefined) return yield* malformed('describe printed no changelist.', output.messages);
    return { ...described, messages: output.messages } satisfies P4ChangelistDescription;
  });
}

/**
 * Describe a changelist: its metadata and files, without diffs.
 *
 * Numbered changelists use `p4 describe -s`. The default changelist, which
 * `describe` cannot show, is read from `p4 opened -c default`. A changelist
 * that does not exist fails with reason `unknown_changelist`.
 *
 * @returns The changelist and its files.
 */
export const describeChangelist = operation('describeChangelist', (options: DescribeChangelistOptions, sink) =>
  Effect.gen(function* () {
    const counter = progressCounter(sink, 'files');
    const result = options.change === 'default'
      ? yield* describeDefault(options)
      : yield* describeNumbered(options.change, options.shelved ?? false);
    for (const message of result.messages) yield* sink.message(message);
    counter.expect(result.files.length);
    yield* counter.advance(result.files.length);
    return result;
  }));
