import { Effect } from 'effect';
import { runCommand, streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { openedCommand } from './opened.js';
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
  /** Start the page below this changelist; pass the previous page's `nextCursor`. */
  readonly cursor?: number | undefined;
  /**
   * For pending changelists, include the default changelist when files are
   * open in it. Defaults to `true`. Only the first page includes it.
   */
  readonly includeDefault?: boolean | undefined;
}

/** A changelist as `p4 changes -l` lists it. */
export interface P4Changelist {
  readonly change: number | 'default';
  readonly status: P4ChangelistStatus;
  readonly user: string | null;
  readonly client: string | null;
  /** The full description. */
  readonly description: string | null;
  /** Creation (pending) or submission (submitted) time, as ISO 8601. */
  readonly createdAt: string | null;
  readonly isDefault: boolean;
}

/** One page of changelists, newest first. */
export interface P4ChangelistPage {
  readonly items: P4Changelist[];
  readonly messages: P4Message[];
  /** Whether older changelists remain. */
  readonly hasMore: boolean;
  /** `cursor` for the next page, or `null` on the last page. */
  readonly nextCursor: number | null;
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

/** Scope each spec below the cursor; a spec with its own revision cannot be scoped. */
function scopedSpecs(specs: string[], cursor: number | undefined) {
  if (cursor === undefined) return Effect.succeed(specs);
  const scopes = specs.length === 0 ? ['//...'] : specs;
  if (scopes.some((spec) => /[#@]/.test(spec))) {
    return invalid('cursor', 'cursor requires file specs without a revision specifier.');
  }
  return Effect.succeed(scopes.map((spec) => `${spec}@${cursor}`));
}

/**
 * The default changelist, when files are open in it. Its description and
 * owner come from the first opened file.
 */
function defaultChangelist(options: ListChangelistsOptions) {
  return Effect.map(
    runCommand(openedCommand({ change: 'default', user: options.user, client: options.client, fileSpec: options.fileSpec })),
    (output) => {
      const first = output.items[0];
      const synthesized: P4Changelist | null = first === undefined ? null : {
        change: 'default',
        status: 'pending',
        user: options.user ?? first.user,
        client: options.client ?? first.client,
        description: first.changeDescription ?? 'Default changelist',
        createdAt: null,
        isDefault: true,
      };
      return { changelist: synthesized, messages: output.messages };
    },
  );
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
      const found = yield* defaultChangelist(options);
      messages.push(...found.messages);
      for (const message of found.messages) yield* sink.message(message);
      if (found.changelist !== null) page.unshift(found.changelist);
    }
    for (const item of page) yield* sink.item(item);

    return {
      items: page,
      messages,
      hasMore,
      nextCursor: hasMore && oldest !== null ? oldest - 1 : null,
    };
  }));
