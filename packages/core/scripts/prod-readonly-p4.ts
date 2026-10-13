import { Effect, Schema } from 'effect';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WireScriptError } from './wire-script-error.js';

const Text = Schema.NonEmptyString.check(Schema.isPattern(/^[^\0\r\n]+$/));
const Config = Schema.Struct({
  port: Text,
  user: Text,
  scratchDir: Text,
  executable: Schema.optionalKey(Text),
  client: Schema.optionalKey(Text),
  charset: Schema.optionalKey(Text),
  tickets: Schema.optionalKey(Text),
  trust: Schema.optionalKey(Text),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30_000 })),
  ),
});

/** Explicit connection settings; keep instances in the gitignored capture directory. */
export type ProductionReadConfig = typeof Config.Type;

// Only reviewed flags are accepted. A flag's value cannot become another command or option.
const FLAGS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  info: {},
  changes: { '-m': true, '-s': true, '-u': true, '-c': true, '-l': false },
  describe: { '-s': false, '-S': false },
  files: { '-m': true, '-e': false, '-a': false },
  fstat: { '-m': true, '-T': true, '-Or': false, '-Os': false },
  dirs: {},
  depots: {},
  streams: { '-m': true, '-F': true },
  stream: { '-o': false },
  client: { '-o': false },
  user: { '-o': false },
  clients: { '-m': true, '-u': true, '-e': true },
  users: { '-m': true },
  where: {},
  have: {},
  opened: { '-m': true, '-c': true, '-C': true, '-u': true, '-a': false },
  filelog: {
    '-m': true,
    '-l': false,
    '-L': false,
    '-i': false,
    '-s': false,
    '-t': false,
  },
  print: { '-o': true, '-q': false },
  annotate: { '-c': false, '-u': false, '-i': false, '-I': false },
  diff2: { '-du': false, '-q': false, '-t': false },
  sizes: { '-s': false },
  interchanges: { '-m': true, '-l': false },
  integrated: {},
  labels: { '-m': true, '-e': true },
  property: { '-l': false, '-n': true, '-u': true, '-c': true },
  sync: { '-n': false, '-m': true },
  reconcile: { '-n': false, '-a': false, '-e': false, '-d': false },
  status: { '-n': false },
  diff: { '-sa': false, '-se': false, '-sd': false, '-sr': false },
  tickets: {},
  set: {},
};
const CLIENT_COMMANDS = new Set([
  'sync',
  'reconcile',
  'status',
  'have',
  'opened',
  'where',
  'client',
]);
const BOUNDED_COMMANDS = new Set([
  'changes',
  'files',
  'fstat',
  'streams',
  'clients',
  'users',
  'opened',
  'filelog',
  'labels',
  'sync',
  'interchanges',
]);
const PATH_COMMANDS = new Set([
  'files',
  'fstat',
  'dirs',
  'where',
  'have',
  'opened',
  'filelog',
  'print',
  'annotate',
  'diff2',
  'sizes',
  'interchanges',
  'integrated',
  'sync',
  'reconcile',
  'status',
  'diff',
]);

function refuse(message: string): never {
  throw new Error(`Production read guard refused: ${message}`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/** Validate a command without launching p4. Unreviewed commands, flags and broad reads fail closed. */
export function validateProductionRead(
  args: readonly string[],
  scratchDir: string,
): string {
  if (args.some((arg) => /[\0\r\n]/.test(arg) || /^-x/.test(arg)))
    refuse('argument files or control characters');
  let offset = 0;
  while (['-Mj', '-ztag', '-G', '-z'].includes(args[offset] ?? '')) {
    if (args[offset++] === '-z' && args[offset++] !== 'tag')
      refuse('only -z tag is allowed');
  }
  const command = args[offset++];
  if (!command || !Object.hasOwn(FLAGS, command))
    refuse('command is not allowlisted');
  const flags = FLAGS[command];
  if (!flags) refuse('missing flag policy');
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = offset; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) refuse('missing argument');
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!Object.hasOwn(flags, arg) || seen.has(arg))
      refuse(`unreviewed or repeated flag ${arg}`);
    seen.add(arg);
    if (!flags[arg]) continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) refuse(`missing value for ${arg}`);
    if (
      arg === '-m' &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50)
    )
      refuse('limit must be 1..50');
    if (
      arg === '-o' &&
      !inside(resolve(scratchDir), resolve(scratchDir, value))
    )
      refuse('print destination is outside scratch');
  }
  if (['stream', 'client', 'user'].includes(command) && !seen.has('-o'))
    refuse('spec reads require -o');
  if (['sync', 'reconcile', 'status'].includes(command) && !seen.has('-n'))
    refuse('preview requires -n');
  if (command === 'property' && !seen.has('-l'))
    refuse('properties require -l');
  if (
    command === 'diff' &&
    !['-sa', '-se', '-sd', '-sr'].some((flag) => seen.has(flag))
  )
    refuse('diff requires a reviewed summary flag');
  if (BOUNDED_COMMANDS.has(command) && !seen.has('-m'))
    refuse('command requires -m 1..50');
  if (
    ['info', 'depots', 'tickets', 'set', 'property'].includes(command) &&
    positional.length
  )
    refuse('unexpected positional arguments');
  if (
    ['stream', 'client', 'user', 'describe'].includes(command) &&
    positional.length > 1
  )
    refuse('read only one spec or change');
  if (
    command === 'describe' &&
    (positional.length !== 1 || !/^\d+$/.test(positional[0] ?? ''))
  )
    refuse('describe requires one numbered change');
  if (PATH_COMMANDS.has(command)) {
    if (!positional.length || positional.length > (command === 'diff2' ? 2 : 1))
      refuse('provide one narrow path (two for diff2)');
    for (const path of positional) {
      if (
        !path.startsWith('//') ||
        /^\/\/[^/]+\/(?:\.\.\.|\*)/.test(path) ||
        path === '//...'
      )
        refuse('use a narrow explicit depot path');
      if (
        [
          'print',
          'annotate',
          'sizes',
          'have',
          'integrated',
          'diff2',
          'reconcile',
          'status',
          'diff',
        ].includes(command) &&
        /\.\.\.|\*/.test(path)
      )
        refuse('this read requires an exact file');
      if (command === 'dirs' && path.includes('...'))
        refuse('directory reads must be one level');
    }
  }
  return command;
}

/** Exact subprocess capture, including binary -G output and timeout/size-limit termination. */
export interface ProductionCapture {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly stopped: 'timeout' | 'output-limit' | null;
}

/** Internal byte-preserving subprocess adapter; production callers must use runProductionRead. */
export function captureSubprocess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Effect.Effect<ProductionCapture, WireScriptError> {
  return Effect.callback<ProductionCapture, WireScriptError>((resume) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: ProductionCapture['stopped'] = null;
    const stop = (reason: NonNullable<ProductionCapture['stopped']>) => {
      stopped ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        stop('output-limit');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resume(
        Effect.fail(
          new WireScriptError('Unable to run capture command.', error),
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resume(
        Effect.succeed({
          args,
          exitCode: code ?? 1,
          stdout: out.toString('utf8'),
          stderr: err.toString('utf8'),
          stdoutBase64: out.toString('base64'),
          stderrBase64: err.toString('base64'),
          stopped,
        }),
      );
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    });
  });
}

/** Run one audited read from scratch with explicit identity and isolated settings. */
export function runProductionRead(
  config: ProductionReadConfig,
  args: readonly string[],
): Promise<ProductionCapture> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* Schema.decodeUnknownEffect(Config)(config);
      const scratch = resolve(settings.scratchDir);
      const temp = realpathSync(tmpdir());
      if (!inside(temp, scratch))
        refuse('scratch must be under the system temp folder');
      mkdirSync(scratch, { recursive: true });
      if (realpathSync(scratch) !== scratch)
        refuse('scratch cannot contain links');
      const command = validateProductionRead(args, scratch);
      const destinationIndex = args.indexOf('-o');
      if (command === 'print' && destinationIndex >= 0) {
        const destination = resolve(scratch, args[destinationIndex + 1] ?? '');
        if (
          !inside(scratch, destination) ||
          realpathSync(dirname(destination)) !== dirname(destination) ||
          (existsSync(destination) && lstatSync(destination).isSymbolicLink())
        )
          refuse('print destination contains links');
      }
      if (CLIENT_COMMANDS.has(command) && !settings.client)
        refuse('workspace reads require an explicit client');
      const environment: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.toUpperCase().startsWith('P4') && key !== 'PWD',
        ),
      );
      Object.assign(environment, {
        P4CONFIG: join(scratch, 'disabled-config'),
        P4ENVIRO: join(scratch, 'enviro'),
        P4ALIASES: join(scratch, 'disabled-aliases'),
        P4CHARSET: settings.charset ?? 'none',
        P4CLIENT: '__readonly_guard__',
        P4TICKETS: settings.tickets ?? join(scratch, 'tickets'),
        P4TRUST: settings.trust ?? join(scratch, 'trust'),
      });
      writeFileSync(environment.P4ENVIRO ?? '', '');
      const actualArgs = [
        '-p',
        settings.port,
        '-u',
        settings.user,
        ...(CLIENT_COMMANDS.has(command) ? ['-c', settings.client ?? ''] : []),
        ...args,
      ];
      // One lock across every invocation and scratch folder. Never remove another invocation's lock.
      const lock = join(temp, 'p4client-prod-readonly.lock');
      const log = join(scratch, 'commands.jsonl');
      return yield* Effect.acquireUseRelease(
        Effect.try({
          try: () => mkdirSync(lock),
          catch: (error) =>
            new WireScriptError(
              'Another production read holds the guard lock.',
              error,
            ),
        }),
        () =>
          Effect.gen(function* () {
            appendFileSync(
              log,
              JSON.stringify({
                event: 'start',
                time: new Date().toISOString(),
                command,
                args: actualArgs,
              }) + '\n',
            );
            const result = yield* captureSubprocess(
              settings.executable ?? 'p4',
              actualArgs,
              scratch,
              environment,
              settings.timeoutMs ?? 30_000,
            ).pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  appendFileSync(
                    log,
                    JSON.stringify({
                      event: 'exit',
                      command,
                      exitCode: 1,
                      error: error.message,
                    }) + '\n',
                  ),
                ),
              ),
            );
            appendFileSync(
              log,
              JSON.stringify({
                event: 'exit',
                command,
                exitCode: result.exitCode,
                stopped: result.stopped,
              }) + '\n',
            );
            return result;
          }),
        () => Effect.sync(() => rmdirSync(lock)),
      );
    }),
  );
}

if (import.meta.main) {
  const [configPath, ...args] = process.argv.slice(2);
  Effect.runPromise(
    Effect.gen(function* () {
      if (!configPath)
        refuse(
          'usage: bun prod-readonly-p4.ts <private-config.json> <command arguments>',
        );
      const contents = yield* Effect.promise(() => Bun.file(configPath).text());
      const config = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Config),
      )(contents);
      const capture = yield* Effect.promise(() =>
        runProductionRead(config, args),
      );
      const destination = join(
        dirname(resolve(configPath)),
        `capture-${Date.now()}.json`,
      );
      writeFileSync(destination, JSON.stringify(capture, null, 2));
      // Captures can contain private production data; display only their local location and exit status.
      console.log(
        JSON.stringify({
          capture: destination,
          exitCode: capture.exitCode,
          stopped: capture.stopped,
        }),
      );
      process.exitCode = capture.exitCode;
    }),
  ).catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
