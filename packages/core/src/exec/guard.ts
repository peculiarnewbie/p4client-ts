/**
 * Read-only command recognition.
 *
 * p4client-ts refuses to run a command that changes the server or a workspace
 * unless the client was configured with `allowMutation: true`. Unknown commands
 * are treated as mutating, so the guard fails closed.
 */

/** Global options that consume the following argument. */
const GLOBAL_VALUE_OPTIONS = new Set([
  '-b', '-c', '-C', '-d', '-H', '-L', '-p', '-P', '-Q', '-r', '-u', '-v', '-x', '-z',
]);

/** Commands that never change the server or a workspace. */
const READ_COMMANDS = new Set([
  'annotate', 'branches', 'changes', 'changelists', 'clients', 'counters', 'depots', 'describe',
  'diff', 'diff2', 'dirs', 'files', 'filelog', 'fixes', 'fstat', 'grep', 'groups', 'have', 'help',
  'info', 'integrated', 'interchanges', 'jobs', 'keys', 'labels', 'license', 'opened', 'print',
  'protects', 'sizes', 'status', 'streams', 'tickets', 'users', 'where', 'workspaces',
]);

/** Spec commands, read-only with `-o`. */
const SPEC_COMMANDS = new Set([
  'branch', 'change', 'changelist', 'client', 'depot', 'group', 'job', 'label', 'protect',
  'stream', 'typemap', 'user', 'workspace',
]);

/** Commands that only preview with `-n`. */
const PREVIEW_COMMANDS = new Set([
  'add', 'clean', 'copy', 'delete', 'edit', 'flush', 'integ', 'integrate', 'merge', 'move',
  'populate', 'reconcile', 'rec', 'resolve', 'revert', 'shelve', 'sync', 'unshelve',
]);

/** Outcome of inspecting a `p4` argument vector. */
export interface P4CommandCheck {
  /** The subcommand, or `null` when none was found. */
  readonly command: string | null;
  /** Whether the invocation can change the server or a workspace. */
  readonly mutates: boolean;
}

function subcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) return index;
    if (GLOBAL_VALUE_OPTIONS.has(arg)) index += 1;
  }
  return -1;
}

function argumentFile(args: readonly string[], end: number): string | null {
  for (let index = 0; index < end; index += 1) {
    if (args[index] === '-x') return args[index + 1] ?? null;
    if (args[index]!.startsWith('-x') && args[index] !== '-x') return args[index]!.slice(2);
    if (GLOBAL_VALUE_OPTIONS.has(args[index]!)) index += 1;
  }
  return null;
}

/**
 * Decide whether a `p4` invocation can change the server or a workspace.
 *
 * Arguments read from stdin with `-x -` are inspected too; an argument file
 * cannot be, so `-x <file>` is treated as mutating.
 *
 * @param args Complete argument vector, including global options.
 * @param input Text written to stdin, when the invocation uses `-x -`.
 * @returns The subcommand and whether it mutates.
 */
export function checkCommand(args: readonly string[], input?: string): P4CommandCheck {
  const index = subcommandIndex(args);
  if (index < 0) return { command: null, mutates: false };
  const command = args[index]!;
  const file = argumentFile(args, index);
  if (file !== null && file !== '-') return { command, mutates: true };
  const stdinArgs = file === '-' ? (input ?? '').split(/\r?\n/).filter((line) => line !== '') : [];
  // Arguments from stdin are appended; they may add a file, but never an option.
  if (stdinArgs.some((arg) => arg.startsWith('-'))) return { command, mutates: true };
  const options = args.slice(index + 1).filter((arg) => arg.startsWith('-'));
  if (READ_COMMANDS.has(command)) return { command, mutates: false };
  if (SPEC_COMMANDS.has(command)) return { command, mutates: !options.includes('-o') };
  if (PREVIEW_COMMANDS.has(command)) return { command, mutates: !options.includes('-n') };
  if (command === 'property') return { command, mutates: !options.includes('-l') };
  if (command === 'set') return { command, mutates: args.slice(index + 1).some((arg) => arg.includes('=')) };
  if (command === 'login') return { command, mutates: !options.includes('-s') };
  return { command, mutates: true };
}
