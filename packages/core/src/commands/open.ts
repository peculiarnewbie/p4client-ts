import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { openHolder } from '../wire/fallback.js';
import {
  action,
  clientFile,
  integer,
  invalid,
  itemFailure,
  optionalDepotPath,
  requirePositive,
  specList,
  text,
} from './shared.js';
import type { P4Sink } from '../engine/operation.js';
import type { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { P4MessagePolicy } from '../wire/policy.js';
import type { FileSpecs, P4ItemFailure, Row } from './shared.js';

/** Options for {@link openForEdit} and {@link previewOpenForEdit}. */
export interface OpenForEditOptions {
  /** Files to open, in depot, client or local syntax. */
  readonly fileSpec: FileSpecs;
  /** Pending changelist to open them in (`-c`). Defaults to the default changelist. */
  readonly change?: number | 'default' | undefined;
}

/** Options for {@link openForAdd} and {@link previewOpenForAdd}. */
export interface OpenForAddOptions {
  /** Workspace files to add, usually local paths. */
  readonly fileSpec: FileSpecs;
  /** Pending changelist to open them in (`-c`). Defaults to the default changelist. */
  readonly change?: number | 'default' | undefined;
  /** File type (`-t`), such as `binary+l`. Defaults to the typemap and the file's content. */
  readonly type?: string | undefined;
}

/** A file `edit` or `add` opened, or would open. */
export interface P4FileOpen {
  readonly depotFile: P4DepotPath | null;
  /** The workspace file, usually as a local path. */
  readonly clientFile: P4ClientPath | P4LocalPath | null;
  readonly action: P4FileAction;
  /** File type it is open as. */
  readonly type: string | null;
  /** Revision of the workspace file (`1` for an add). */
  readonly workRevision: number | null;
}

/**
 * A file that could not be opened. The operation itself succeeded.
 *
 * Reasons callers usually act on:
 * - `exclusive_open`: an exclusive (`+l`) file is already open elsewhere;
 *   `heldBy` names who has it. Stop here: no other workspace can open it.
 * - `exists_in_depot`: `add` of a file the depot already has; use `edit`.
 * - `not_on_client`, `no_such_file`, `not_in_view`: nothing to open.
 */
export interface P4OpenFailure extends P4ItemFailure {
  /** For `exclusive_open`: each `user@client` Perforce named as having the file open. */
  readonly heldBy: readonly string[];
}

/** What `edit` or `add` opened, or would open. */
export interface P4OpenResult {
  readonly items: P4FileOpen[];
  /** Files that could not be opened; see {@link P4OpenFailure}. */
  readonly failures: P4OpenFailure[];
  /**
   * Notices, including `already_opened` for a file already open in this
   * workspace, which stays in the changelist it is in.
   */
  readonly messages: P4Message[];
}

/** A file that cannot be opened concerns that file only; the others are still opened. */
const OPEN_POLICY: P4MessagePolicy = {
  exclusive_open: 'item',
  exists_in_depot: 'item',
  no_such_file: 'item',
  not_on_client: 'item',
  not_in_view: 'item',
  unknown_revision: 'item',
};

function toFileOpen(row: Row): P4FileOpen {
  return {
    depotFile: optionalDepotPath(row.depotFile, row),
    clientFile: clientFile(row.clientFile, row),
    action: action(row.action, row),
    type: text(row.type),
    workRevision: integer(row.workRev, row),
  };
}

/** Validate an optional `-c` changelist. */
function changeArgs(change: number | 'default' | undefined) {
  if (change === undefined) return Effect.succeed([]);

  if (change === 'default') return Effect.succeed(['-c', 'default']);

  return Effect.map(requirePositive(change, 'change'), (value) => ['-c', String(value)]);
}

/** Attach each holder notice to the exclusive-open failure for the same file. */
function withHolders(failures: P4ItemFailure[], messages: P4Message[]): P4OpenFailure[] {
  const holders = new Map<string, string[]>();

  for (const message of messages) {
    const held = openHolder(message.text);

    if (held !== null) holders.set(held.file, [...(holders.get(held.file) ?? []), held.holder]);
  }

  return failures.map((failure) => ({
    ...failure,
    heldBy: failure.reason === 'exclusive_open' && failure.spec !== null ? holders.get(failure.spec) ?? [] : [],
  }));
}

function runOpen(command: 'edit' | 'add', args: string[], fileSpec: FileSpecs, sink: P4Sink<P4FileOpen>) {
  return Effect.gen(function* () {
    const specs = specList(fileSpec);

    if (specs.length === 0) return yield* invalid('fileSpec', `${command} needs at least one file.`);

    const output = yield* drain(sink, streamCommand({
      args: [command, ...args, ...specs],
      format: 'json',
      policy: OPEN_POLICY,
      decode: toFileOpen,
    }), { item: (file) => file, counter: progressCounter(sink, 'files') });

    const result: P4OpenResult = {
      items: output.items,
      failures: withHolders(output.failures.map(itemFailure), output.messages),
      messages: output.messages,
    };

    return result;
  });
}

function editArgs(options: OpenForEditOptions, preview: boolean) {
  return Effect.map(changeArgs(options.change), (change) => [...(preview ? ['-n'] : []), ...change]);
}

function addArgs(options: OpenForAddOptions, preview: boolean) {
  return Effect.gen(function* () {
    const args = [...(preview ? ['-n'] : []), ...yield* changeArgs(options.change)];

    if (options.type !== undefined) {
      if (!/^[A-Za-z0-9+]+$/.test(options.type)) return yield* invalid('type', `Invalid file type "${options.type}".`);
      args.push('-t', options.type);
    }

    return args;
  });
}

/**
 * Open files for edit with `p4 edit`, making them writable.
 *
 * This changes the workspace and server, so the client must be created with
 * `allowMutation: true`. A file that cannot be opened is a per-item failure:
 * an exclusive file open in another workspace comes back with reason
 * `exclusive_open` and `heldBy`, and must be treated as a stop. A file already
 * open in this workspace is reported as an `already_opened` message and is
 * not moved to `change`.
 *
 * @returns The files opened, and those that could not be.
 * @throws {P4InvalidArgumentError} When no file is given or `change` is invalid.
 * @throws {P4ReadOnlyError} When the client does not allow mutation.
 */
export const openForEdit = operation<OpenForEditOptions, P4FileOpen, P4OpenResult>('openForEdit', (options, sink) =>
  Effect.flatMap(editArgs(options, false), (args) => runOpen('edit', args, options.fileSpec, sink)), 'files');

/**
 * Preview {@link openForEdit} with `p4 edit -n`: what would be opened, and
 * what would be refused (including `exclusive_open`), without opening anything.
 *
 * @returns The files that would be opened, and those that could not be.
 */
export const previewOpenForEdit = operation<OpenForEditOptions, P4FileOpen, P4OpenResult>('previewOpenForEdit', (options, sink) =>
  Effect.flatMap(editArgs(options, true), (args) => runOpen('edit', args, options.fileSpec, sink)), 'files');

/**
 * Open new workspace files for add with `p4 add`.
 *
 * This changes the server, so the client must be created with
 * `allowMutation: true`. A file the depot already has is a per-item failure
 * with reason `exists_in_depot`; one already open is an `already_opened`
 * message. File names containing `@`, `#`, `%` or `*` are not supported.
 *
 * @returns The files opened, and those that could not be.
 * @throws {P4InvalidArgumentError} When no file is given, or `change` or `type` is invalid.
 * @throws {P4ReadOnlyError} When the client does not allow mutation.
 */
export const openForAdd = operation<OpenForAddOptions, P4FileOpen, P4OpenResult>('openForAdd', (options, sink) =>
  Effect.flatMap(addArgs(options, false), (args) => runOpen('add', args, options.fileSpec, sink)), 'files');

/**
 * Preview {@link openForAdd} with `p4 add -n`, without opening anything.
 *
 * @returns The files that would be opened, and those that could not be.
 */
export const previewOpenForAdd = operation<OpenForAddOptions, P4FileOpen, P4OpenResult>('previewOpenForAdd', (options, sink) =>
  Effect.flatMap(addArgs(options, true), (args) => runOpen('add', args, options.fileSpec, sink)), 'files');

