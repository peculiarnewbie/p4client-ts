import { Effect } from 'effect';
import { runCommand, streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { readDefaultChangelist } from './default-changelist.js';
import {
  action,
  change,
  depotPath,
  description,
  indexes,
  integer,
  invalid,
  isoFromSeconds,
  itemFailure,
  malformed,
  requirePositive,
  text,
} from './shared.js';
import type { P4DepotPath, P4FileAction } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { P4ItemFailure, Row } from './shared.js';

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

/** A described changelist without its messages, as {@link describeChangelists} lists it. */
export type P4DescribedChangelist = Omit<P4ChangelistDescription, 'messages'>;

/** Options for {@link describeChangelists}. */
export interface DescribeChangelistsOptions {
  /** Numbered changelists, described in one `p4 describe -s`. */
  readonly changes: readonly number[];
  /** Describe the files shelved in pending changelists (`-S`). */
  readonly shelved?: boolean | undefined;
}

/** Several described changelists, with those that do not exist. */
export interface P4DescribedChangelistList {
  /** Described changelists, in the order Perforce prints them. */
  readonly items: P4DescribedChangelist[];
  /** One `unknown_changelist` failure per changelist that does not exist; its `spec` is the number. */
  readonly failures: P4ItemFailure[];
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
  return options.shelved
    ? invalid('shelved', 'Only a numbered changelist can have shelved files.')
    : Effect.map(readDefaultChangelist({ client: options.client }), (found) => found.description);
}

/** One `describe -s` record, or `null` for a record without a changelist. */
function toDescribed(shelved: boolean) {
  return (row: Row): P4DescribedChangelist | null => row.change === undefined ? null : {
    change: change(row.change, row),
    status: text(row.status) === 'submitted' ? 'submitted' : shelved ? 'shelved' : 'pending',
    user: text(row.user),
    client: text(row.client),
    description: description(row.desc),
    createdAt: isoFromSeconds(row.time),
    files: describedFiles(row),
  };
}

function describeNumbered(number: number, shelved: boolean) {
  return Effect.gen(function* () {
    const args = shelved ? ['describe', '-S', '-s', String(number)] : ['describe', '-s', String(number)];
    const output = yield* runCommand({ args, format: 'json', decode: toDescribed(shelved) });
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
export const describeChangelist = operation<DescribeChangelistOptions, never, P4ChangelistDescription>('describeChangelist', (options, sink) =>
  Effect.gen(function* () {
    const counter = progressCounter(sink, 'files');
    const result = options.change === 'default'
      ? yield* describeDefault(options)
      : yield* describeNumbered(options.change, options.shelved ?? false);
    for (const message of result.messages) yield* sink.message(message);
    counter.expect(result.files.length);
    yield* counter.advance(result.files.length);
    return result;
  }), 'files');

/** A changelist that does not exist concerns that changelist only. */
const DESCRIBE_MANY_POLICY: P4MessagePolicy = { unknown_changelist: 'item' };

/**
 * Describe several numbered changelists with one `p4 describe -s`: their
 * metadata and files, without diffs.
 *
 * A changelist that does not exist is a per-item failure with reason
 * `unknown_changelist`, so the others are still described. `describe` stops
 * at the first changelist that does not exist, so the ones after it are
 * described by a further command. Each changelist is reported as soon as it
 * is read.
 *
 * @returns The changelists, and those that do not exist.
 * @throws {P4InvalidArgumentError} When a change is not a positive integer.
 */
export const describeChangelists = operation<
  DescribeChangelistsOptions, P4DescribedChangelist, P4DescribedChangelistList
>('describeChangelists', (options, sink) =>
  Effect.gen(function* () {
    for (const number of options.changes) yield* requirePositive(number, 'changes');
    const shelved = options.shelved ?? false;
    const counter = progressCounter(sink, 'changes', options.changes.length);
    const result: P4DescribedChangelistList = { items: [], failures: [], messages: [] };
    const answered = new Set<number>();
    let remaining = [...new Set(options.changes)];
    while (remaining.length > 0) {
      const output = yield* drain(sink, streamCommand({
        args: ['describe', ...(shelved ? ['-S'] : []), '-s', ...remaining.map(String)],
        format: 'json',
        policy: DESCRIBE_MANY_POLICY,
        decode: toDescribed(shelved),
      }), { item: (described) => described, counter });
      const failures = output.failures.map(itemFailure);
      result.items.push(...output.items);
      result.failures.push(...failures);
      result.messages.push(...output.messages);
      for (const item of output.items) if (item.change !== 'default') answered.add(item.change);
      for (const failure of failures) if (failure.spec !== null) answered.add(Number(failure.spec));
      const next = remaining.filter((number) => !answered.has(number));
      // Only a missing changelist cuts a describe short; without a new failure, nothing would change.
      if (failures.length === 0 || next.length === remaining.length) break;
      remaining = next;
    }
    return result;
  }), 'changes');
