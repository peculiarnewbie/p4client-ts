import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { readDefaultChangelist } from './default-changelist.js';
import {
  change,
  description,
  invalid,
  isoFromSeconds,
  requireNonNegative,
  requirePositive,
  specList,
  text,
} from './shared.js';
import type { P4Operation, P4Context, P4Sink } from '../engine/operation.js';
import type { P4Error } from '../errors.js';
import type { P4Message } from '../wire/message.js';
import type { FileSpecs, Row } from './shared.js';

/** Which changelists to list. */
export type P4ChangelistStatus = 'pending' | 'submitted' | 'shelved';

/** Options for {@link listChangelists}. */
export interface ListChangelistsOptions {
  readonly status: P4ChangelistStatus;
  /** Changelists created by this user. */
  readonly user?: string | undefined;
  /** Changelists of this workspace. */
  readonly client?: string | undefined;
  /**
   * Changelists affecting these files. Prefer this over `client` for a stream
   * or team view: `client` limits the list to one workspace's changelists.
   */
  readonly fileSpec?: FileSpecs | undefined;
  /** Page size. Defaults to 50. */
  readonly limit?: number | undefined;
  /**
   * Inclusive upper changelist bound (`p4 changes <spec>@N`). Pass the previous
   * page's `nextCursor` unchanged: it already subtracts one from the last change.
   * Cannot be combined with revision-bearing file specs.
   */
  readonly cursor?: number | undefined;
  /**
   * For pending changelists, include the default changelist when files are
   * open in it. Defaults to `true`. Only the first page includes it.
   */
  readonly includeDefault?: boolean | undefined;
}

/** A changelist as `p4 changes -l` lists it. */
export interface P4Changelist<S extends P4ChangelistStatus = P4ChangelistStatus> {
  readonly change: S extends 'pending' ? number | 'default' : number;
  readonly status: S;
  readonly user: string | null;
  readonly client: string | null;
  /** The full description. */
  readonly description: string | null;
  /** Creation (pending) or submission (submitted) time, as ISO 8601. */
  readonly createdAt: string | null;
  readonly isDefault: boolean;
}

/** One page of changelists, newest first. */
export interface P4ChangelistPage<S extends P4ChangelistStatus = P4ChangelistStatus> {
  readonly items: P4Changelist<S>[];
  readonly messages: P4Message[];
  /** Whether older changelists remain. */
  readonly hasMore: boolean;
  /** Inclusive bound for the next page (last numbered change minus one), or `null`. */
  readonly nextCursor: number | null;
}

/** Changelist operation preserving the requested status in native programs. */
export interface P4ChangelistOperation extends Omit<P4Operation<ListChangelistsOptions, P4Changelist, P4ChangelistPage>, 'name' | 'program'> {
  readonly name: 'listChangelists';
  readonly program: <S extends P4ChangelistStatus>(
    options: ListChangelistsOptions & { readonly status: S }, sink: P4Sink<P4Changelist<S>>,
  ) => Effect.Effect<P4ChangelistPage<S>, P4Error, P4Context>;
}

const DEFAULT_LIMIT = 50;

interface P4NumberedChangelist extends P4Changelist {
  readonly change: number;
}

function toChangelist(status: P4ChangelistStatus) {
  return (row: Row): P4NumberedChangelist | null => {
    const number = change(row.change, row);
    // `changes` does not list the default changelist; it is synthesized from `opened`.
    if (number === 'default') return null;
    return {
      change: number,
      status,
      user: text(row.user),
      client: text(row.client),
      description: description(row.desc),
      createdAt: isoFromSeconds(row.time),
      isDefault: false,
    };
  };
}

/** Scope each spec at or below the cursor; a spec with its own revision cannot be scoped. */
function scopedSpecs(specs: string[], cursor: number | undefined) {
  if (cursor === undefined) return Effect.succeed(specs);
  const scopes = specs.length === 0 ? ['//...'] : specs;
  if (scopes.some((spec) => /[#@]/.test(spec))) {
    return invalid('cursor', 'cursor requires file specs without a revision specifier.');
  }
  return Effect.succeed(scopes.map((spec) => `${spec}@${cursor}`));
}

/**
 * List pending, submitted or shelved changelists, newest first, a page at a time.
 *
 * @returns One page, with the cursor for the next.
 */
export const listChangelists = operation<ListChangelistsOptions, P4Changelist, P4ChangelistPage>('listChangelists', (options, sink) =>
  Effect.gen(function* () {
    const limit = yield* requirePositive(options.limit ?? DEFAULT_LIMIT, 'limit');
    const cursor = options.cursor === undefined ? undefined : yield* requireNonNegative(options.cursor, 'cursor');
    const specs = yield* scopedSpecs(specList(options.fileSpec), cursor);
    const args = ['changes', '-s', options.status, '-l', '-m', String(limit + 1)];
    if (options.user !== undefined) args.push('-u', options.user);
    if (options.client !== undefined) args.push('-c', options.client);
    args.push(...specs);

    const counter = progressCounter(sink, 'changes', limit);
    const output = yield* drain(sink, streamCommand({ args, format: 'json', decode: toChangelist(options.status) }), {
      counter,
    });
    // Several scopes can each report the same changelist.
    const unique = [...new Map(output.items.map((item) => [item.change, item])).values()]
      .sort((left, right) => right.change - left.change);
    const hasMore = unique.length > limit;
    const numbered = unique.slice(0, limit);
    const oldest = numbered.at(-1)?.change ?? null;
    const page: P4Changelist[] = [...numbered];
    const messages = [...output.messages];

    const wantsDefault = options.status === 'pending' && (options.includeDefault ?? true) && cursor === undefined;
    if (wantsDefault) {
      const { description: found, opened } = yield* readDefaultChangelist(options);
      messages.push(...found.messages);
      for (const message of found.messages) yield* sink.message(message);
      if (opened.length > 0) {
        page.unshift({
          change: 'default',
          status: 'pending',
          user: found.user,
          client: found.client,
          description: found.description,
          createdAt: null,
          isDefault: true,
        });
      }
    }
    for (const item of page) yield* sink.item(item);

    return {
      items: page,
      messages,
      hasMore,
      nextCursor: hasMore && oldest !== null ? oldest - 1 : null,
    };
  }), 'changes') as P4ChangelistOperation;
