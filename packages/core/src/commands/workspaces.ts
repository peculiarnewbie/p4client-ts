import { Effect, Schema } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { decodeField, description, isoFromSeconds, malformed, optionalDepotPath, text } from './shared.js';
import type { P4DepotPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { Row } from './shared.js';

/** Options for {@link listWorkspaces}. */
export interface ListWorkspacesOptions {
  /** Only workspaces owned by this user. Defaults to every workspace on the server. */
  readonly user?: string | undefined;
  /** Only workspaces of this stream. */
  readonly stream?: string | undefined;
  /**
   * Only workspaces usable from this host: those restricted to it, and those
   * with no host restriction.
   */
  readonly host?: string | undefined;
}

/** A workspace (client spec) as `p4 clients` lists it. */
export interface P4Workspace {
  readonly client: string;
  readonly owner: string;
  /** Local directory the workspace maps to. */
  readonly root: string;
  /** Host the workspace is restricted to, or `null` when it can be used anywhere. */
  readonly host: string | null;
  /** Stream of a stream workspace, or `null`. */
  readonly stream: P4DepotPath | null;
  readonly description: string | null;
  /** Last use, as ISO 8601. */
  readonly accessedAt: string | null;
  /** Last change to the spec, as ISO 8601. */
  readonly updatedAt: string | null;
}

/** Workspaces with the messages Perforce reported. */
export interface P4WorkspaceList {
  readonly items: P4Workspace[];
  readonly messages: P4Message[];
}

const Name = Schema.NonEmptyString;

function toWorkspace(row: Row): P4Workspace {
  const root = text(row.Root);
  if (root === null) throw malformed('Expected a workspace with a Root.', row);
  return {
    client: decodeField(Name, row.client, row),
    owner: decodeField(Name, row.Owner, row),
    root,
    host: text(row.Host),
    stream: optionalDepotPath(row.Stream, row),
    description: description(row.Description),
    accessedAt: isoFromSeconds(row.Access),
    updatedAt: isoFromSeconds(row.Update),
  };
}

/**
 * List workspaces, sorted by root and then name.
 *
 * @returns Matching workspaces.
 */
export const listWorkspaces = operation<ListWorkspacesOptions, P4Workspace, P4WorkspaceList>('listWorkspaces', (options, sink) =>
  Effect.gen(function* () {
    const args = ['clients'];
    if (options.user !== undefined) args.push('-u', options.user);
    if (options.stream !== undefined) args.push('-S', options.stream);
    const usable = (workspace: P4Workspace) =>
      options.host === undefined || workspace.host === null || workspace.host === options.host;
    const output = yield* drain(sink, streamCommand({ args, format: 'json', decode: toWorkspace }), {
      item: (workspace) => (usable(workspace) ? workspace : null),
      counter: progressCounter(sink, 'records'),
    });
    const items = output.items
      .filter(usable)
      .sort((left, right) => left.root.localeCompare(right.root) || left.client.localeCompare(right.client));
    return { items, messages: output.messages };
  }));
