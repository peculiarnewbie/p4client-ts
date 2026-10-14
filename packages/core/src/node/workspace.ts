import { Effect } from 'effect';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runCommand } from '../engine/command.js';
import { operation, runOperation } from '../engine/operation.js';
import { indexes, text } from '../commands/shared.js';
import { listWorkspaces } from '../commands/workspaces.js';
import type { P4Workspace } from '../commands/workspaces.js';
import type { P4Message } from '../wire/message.js';

/** Options for {@link findWorkspaceForPath}. */
export interface FindWorkspaceForPathOptions {
  /** A local file or directory. */
  readonly path: string;
  /** Only workspaces owned by this user. Defaults to every workspace. */
  readonly user?: string | undefined;
  /** Only workspaces usable from this host (restricted to it, or unrestricted). */
  readonly host?: string | undefined;
  /**
   * Also match each workspace's `AltRoots`, which needs one `p4 client -o`
   * per workspace whose `Root` does not contain the path. Defaults to `false`.
   */
  readonly altRoots?: boolean | undefined;
  /** Compare paths case-insensitively. Defaults to `true` on Windows. */
  readonly caseInsensitive?: boolean | undefined;
}

/** The workspace whose root contains a path. */
export interface P4WorkspaceMatch {
  readonly workspace: P4Workspace;
  /** The root or alternate root that contains the path. */
  readonly root: string;
  /** The path relative to that root, with `/` separators. */
  readonly relativePath: string;
}

/** The best match, or `null`, with every candidate root that contained the path. */
export interface P4WorkspaceForPath {
  readonly match: P4WorkspaceMatch | null;
  /** Every workspace containing the path, deepest root first. */
  readonly candidates: P4WorkspaceMatch[];
  readonly messages: P4Message[];
}

/** Resolve symbolic links where the path exists, so a junction and its target compare equal. */
function canonical(path: string): Effect.Effect<string> {
  const absolute = resolve(path);
  return Effect.tryPromise(() => realpath(absolute)).pipe(Effect.orElseSucceed(() => absolute));
}

function contains(root: string, path: string, caseInsensitive: boolean): string | null {
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const inside = relative(fold(root), fold(path));
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  // Keep the original case of the path in the result.
  return relative(root, path).split(sep).join('/');
}

/** `AltRoots0`, `AltRoots1`, … from a client spec. */
function alternateRoots(client: string) {
  return Effect.map(
    runCommand({
      args: ['client', '-o', client],
      format: 'json',
      decode: (row) => indexes(row, 'AltRoots').flatMap((index) => {
        const root = text(row[`AltRoots${index}`]);
        return root === null ? [] : [root];
      }),
    }),
    (output) => output.items.flat(),
  );
}

/**
 * Find the workspace whose root contains a local path, as a tool started in
 * that directory would need to. When several roots contain it, the deepest
 * one wins.
 *
 * @returns The match, if any, and every candidate.
 */
export const findWorkspaceForPath = operation<FindWorkspaceForPathOptions, never, P4WorkspaceForPath>('findWorkspaceForPath', (options, sink) =>
  Effect.gen(function* () {
    const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
    const path = yield* canonical(options.path);
    const listed = yield* runOperation(listWorkspaces, { user: options.user, host: options.host });
    for (const message of listed.messages) yield* sink.message(message);

    const candidates: P4WorkspaceMatch[] = [];
    const unmatched: P4Workspace[] = [];
    for (const workspace of listed.items) {
      const root = yield* canonical(workspace.root);
      const relativePath = contains(root, path, caseInsensitive);
      if (relativePath === null) unmatched.push(workspace);
      else candidates.push({ workspace, root: workspace.root, relativePath });
    }
    if (options.altRoots) {
      const found = yield* Effect.forEach(unmatched, (workspace) => Effect.gen(function* () {
        for (const alternate of yield* alternateRoots(workspace.client)) {
          const relativePath = contains(yield* canonical(alternate), path, caseInsensitive);
          if (relativePath !== null) return [{ workspace, root: alternate, relativePath }];
        }
        return [];
      }), { concurrency: 4 });
      candidates.push(...found.flat());
    }
    // The deepest root leaves the shortest path below it.
    candidates.sort((left, right) => left.relativePath.length - right.relativePath.length);
    return { match: candidates[0] ?? null, candidates, messages: listed.messages };
  }));

/**
 * Whether a workspace's root exists on this machine. A workspace without a
 * host restriction can be used anywhere, so this is how to tell whether one
 * is set up here.
 *
 * @param workspace A listed workspace.
 * @returns `true` when the root directory exists.
 */
export function workspaceRootExists(workspace: Pick<P4Workspace, 'root'>): boolean {
  try {
    return existsSync(workspace.root);
  } catch {
    return false;
  }
}
