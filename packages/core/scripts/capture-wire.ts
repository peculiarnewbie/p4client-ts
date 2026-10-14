import { Effect, Schema } from 'effect';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureProcess } from '../tests/support/process.js';
import { captureSubprocess } from './prod-readonly-p4.js';
import { startFixture } from './test-perforce-e2e.js';
import { WireScriptError } from './wire-script-error.js';
import type { Fixture } from './test-perforce-e2e.js';

const destination = resolve(import.meta.dir, '../tests/fixtures/wire');
const privateRoot = resolve(import.meta.dir, '../.captures/disposable');
type Mode = 'json' | 'tagged' | 'marshal' | 'plain';
const PREFIX: Record<Mode, string[]> = {
  json: ['-Mj', '-z', 'tag'],
  tagged: ['-ztag'],
  marshal: ['-G'],
  plain: [],
};

function assertLocal(
  fixture: Fixture,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  if (
    env.P4PORT !== fixture.environment.P4PORT ||
    !/^127\.0\.0\.1:\d+$/.test(env.P4PORT ?? '') ||
    args.some((arg) => arg.startsWith('-p')) ||
    // `-x -` reads arguments from captured stdin; an argument file could name anything.
    args.some((arg, index) => arg.startsWith('-x') && (arg !== '-x' || args[index + 1] !== '-'))
  ) {
    throw new Error('Refusing a wire scenario outside its disposable server.');
  }
}

function scenarios(fixture: Fixture): Effect.Effect<void, WireScriptError> {
  const workspace = fixture.projectRoot;
  const env: NodeJS.ProcessEnv = {
    ...fixture.environment,
    P4CONFIG: join(workspace, 'disabled-config'),
  };
  const decodeJsonRow = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  );
  const decodeChange = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ change: Schema.String })),
  );
  let count = 0;
  const normalize = (text: string): string => {
    let result = text;
    const replace = (path: string, replacement: string) => {
      result = result.replace(
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        replacement,
      );
    };
    for (const path of [workspace, workspace.replaceAll('\\', '/')]) {
      replace(JSON.stringify(path).slice(1, -1), '<WORKSPACE>');
      replace(path, '<WORKSPACE>');
    }
    for (const path of [
      dirname(workspace),
      dirname(workspace).replaceAll('\\', '/'),
    ]) {
      replace(JSON.stringify(path).slice(1, -1), '<SCRATCH>');
      replace(path, '<SCRATCH>');
    }
    result = result.replaceAll(env.P4PORT ?? '', '<LOCAL_PORT>');
    result = result.replace(/(Peer address: )[^\r\n]+/g, '$1<LOCAL_PEER>');
    result = result.replace(/(Server address: )[^\r\n]+/g, '$1<LOCAL_PORT>');
    return result;
  };
  const run = (
    args: string[],
    input?: string,
    overrides: NodeJS.ProcessEnv = {},
  ) =>
    Effect.try({
      try: () => {
        const environment = { ...env, ...overrides };
        assertLocal(fixture, args, environment);
        return {
          executable: fixture.p4Executable,
          args: ['-p', environment.P4PORT ?? '', '-u', environment.P4USER ?? '',
            '-c', environment.P4CLIENT ?? '', ...args],
          cwd: workspace,
          env: environment,
          input,
        };
      },
      catch: (error) => new WireScriptError(String(error), error),
    }).pipe(Effect.flatMap((invocation) => captureProcess(invocation).pipe(
      Effect.mapError((error) => new WireScriptError(String(error), error)),
    )));
  const write = (
    args: string[],
    input?: string,
    overrides: NodeJS.ProcessEnv = {},
  ) =>
    run(args, input, overrides).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new WireScriptError(
                `Disposable seed failed: ${args[0]}: ${result.stderr || result.stdout}`,
              ),
            ),
      ),
    );
  const capture = (
    name: string,
    args: string[],
    mode: Mode = 'json',
    overrides: NodeJS.ProcessEnv = {},
    timeoutMs = 30_000,
    input?: string,
  ) =>
    Effect.gen(function* () {
      const environment = { ...env, ...overrides };
      assertLocal(fixture, args, environment);
      const actual = [
        '-p',
        environment.P4PORT ?? '',
        '-u',
        environment.P4USER ?? '',
        '-c',
        environment.P4CLIENT ?? '',
        ...PREFIX[mode],
        ...args,
      ];
      const result = yield* captureSubprocess(
        fixture.p4Executable,
        actual,
        workspace,
        environment,
        timeoutMs,
        input,
      );
      writeFileSync(
        join(privateRoot, `${name}.json`),
        JSON.stringify(result, null, 2),
      );
      const stdout = normalize(result.stdout);
      const stderr = normalize(result.stderr);
      const rows =
        mode === 'json'
          ? stdout
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => {
                try {
                  const row = decodeJsonRow(line);
                  return row.severity !== undefined ||
                    row.level !== undefined ||
                    row.code === 'error' ||
                    row.code === 'info'
                    ? 'message'
                    : 'data';
                } catch {
                  return 'text';
                }
              })
          : [];
      writeFileSync(
        join(destination, `${name}.json`),
        JSON.stringify(
          {
            origin: 'disposable p4d r26.1',
            mode,
            cwd: '<WORKSPACE>',
            charset: environment.P4CHARSET,
            args: actual.map(normalize),
            ...(input === undefined ? {} : { input: normalize(input) }),
            exitCode: result.exitCode,
            stopped: result.stopped,
            stdout: mode === 'marshal' ? null : stdout,
            stdoutBase64: mode === 'marshal' ? result.stdoutBase64 : null,
            stderr,
            rows,
          },
          null,
          2,
        ) + '\n',
      );
      count += 1;
      return result;
    });
  const file = '//p4ts/main/wire/text.txt';
  const local = join(workspace, 'wire/text.txt');
  return Effect.gen(function* () {
    mkdirSync(destination, { recursive: true });
    mkdirSync(privateRoot, { recursive: true });
    mkdirSync(dirname(local), { recursive: true });
    const seedFiles: Array<[string, string, string]> = [
      ['text.txt', 'text', 'one\ntwo\n'],
      ['space name.txt', 'text', 'spaced path\n'],
      ['literal@#%.txt', 'text', 'reserved filename\n'],
      ['exclusive.uasset', 'binary+l', 'synthetic asset\0data'],
      ['full.uasset', 'binary+F', 'full binary\0data'],
      ['wide.txt', 'utf16', '\ufeffwide text\r\n'],
      ['clobber.txt', 'text', 'clobber base\n'],
      ['deleted.txt', 'text', 'deleted base\n'],
    ];
    for (const [name, type, content] of seedFiles) {
      const path = join(workspace, 'wire', name);
      writeFileSync(
        path,
        type === 'utf16' ? Buffer.from(content, 'utf16le') : content,
      );
      yield* write(['add', '-f', '-t', type, path]);
    }
    const longDescription = `Wire fixture CRLF description\r\nsecond paragraph\r\n${'long description '.repeat(1000)}`;
    yield* write(['submit', '-d', longDescription]);
    yield* write(
      ['stream', '-i'],
      `Stream: //p4ts/consumer\nOwner: ${env.P4USER}\nName: consumer\nParent: none\nParentView: inherit\nType: mainline\nOptions: allsubmit unlocked\nDescription:\n\tImport fixture\nPaths:\n\tshare ...\n\timport vendor/... //p4ts/main/src/...\n`,
    );
    yield* capture('stream-import-spec', ['stream', '-o', '//p4ts/consumer']);
    yield* write(['delete', join(workspace, 'wire/deleted.txt')]);
    yield* write(['submit', '-d', 'Wire deleted head fixture']);
    const submitted = yield* run(['-Mj', '-z', 'tag', 'changes', '-m', '1']);
    const lastChange = decodeChange(submitted.stdout.trim()).change;
    yield* capture('client-version', ['-V'], 'plain');
    const normal: Array<[string, string[], Mode?]> = [
      ['info', ['info'], 'plain'],
      ['settings', ['set', '-q'], 'plain'],
      ['clients', ['clients', '-u', env.P4USER ?? '']],
      ['depots', ['depots']],
      ['dirs', ['dirs', '//p4ts/main/*']],
      ['files', ['files', '//p4ts/main/wire/*']],
      [
        'files-existing',
        ['files', '-e', '-m', '50', `//p4ts/main/wire/*@${lastChange}`],
      ],
      [
        'changes-submitted',
        ['changes', '-s', 'submitted', '-l', '-m', '5', '//p4ts/main/wire/...'],
      ],
      ['describe-submitted', ['describe', '-s', lastChange]],
      ['users', ['users', '-m', '50']],
      ['streams', ['streams', '-m', '50', '//p4ts/...']],
      ['stream-spec', ['stream', '-o', '//p4ts/main']],
      ['client-spec', ['client', '-o']],
      ['fstat', ['fstat', '-m', '50', '//p4ts/main/wire/*']],
      ['fstat-size', ['fstat', '-Ol', '-m', '1', file]],
      ['fstat-fields', ['fstat', '-T', 'depotFile headType headRev', file]],
      ['fstat-fields-without-path', ['fstat', '-T', 'headType headRev', file]],
      ['where', ['where', file]],
      ['filelog', ['filelog', '-l', '-m', '10', file]],
      ['filelog-integrations', ['filelog', '-l', '-i', '-m', '10', file]],
      ['annotate', ['annotate', '-q', '-c', file]],
      ['annotate-integrations', ['annotate', '-q', '-c', '-I', file]],
      ['print', ['print', '-q', `${file}#head`], 'plain'],
      ['print-utf16', ['print', '-q', '//p4ts/main/wire/wide.txt'], 'plain'],
      [
        'print-materialize',
        [
          'print',
          '-q',
          '-k',
          '-o',
          join(workspace, 'printed.txt'),
          `${file}#1`,
        ],
        'plain',
      ],
      ['property-empty', ['property', '-l', '-n', 'fixture.setting']],
      ['have', ['have', file]],
    ];
    for (const [name, args, mode] of normal) yield* capture(name, args, mode);
    // 0.13 rearchitecture: info and content commands in structured modes.
    yield* capture('info-json', ['info']);
    yield* capture('info-short-json', ['info', '-s']);
    yield* capture('info-zprog', ['-zprog=p4client-ts', '-zversion=0.13.0', 'info', '-s']);
    yield* capture('print-json', ['print', '-q', file]);
    yield* capture('print-json-binary', ['print', '-q', '//p4ts/main/wire/full.uasset']);
    yield* capture('print-marshal-text', ['print', '-k', file], 'marshal');
    yield* capture('print-marshal-binary', ['print', '-k', '//p4ts/main/wire/full.uasset'], 'marshal');
    yield* capture('print-marshal-utf16', ['print', '-k', '//p4ts/main/wire/wide.txt'], 'marshal');
    yield* capture('print-marshal-missing', ['print', '-k', '//p4ts/main/missing.txt'], 'marshal');
    yield* capture(
      'print-marshal-batch',
      ['-x', '-', 'print', '-k'],
      'marshal',
      {},
      30_000,
      `${file}\n//p4ts/main/wire/full.uasset\n//p4ts/main/missing.txt\n//p4ts/main/wire/wide.txt\n`,
    );
    yield* capture('files-mixed', ['files', file, '//p4ts/main/missing.txt']);
    yield* capture('where-mixed', ['where', file, '//other/main/a.txt']);
    yield* capture('fstat-mixed-missing', ['fstat', file, '//p4ts/main/missing.txt']);
    yield* capture('users-mixed', ['users', env.P4USER ?? '', 'missing-user']);
    yield* capture('describe-submitted-shelved-flag', ['describe', '-S', '-s', lastChange]);
    yield* capture('filelog-wildcard-limit', ['filelog', '-l', '-m', '2', '//p4ts/main/wire/...']);
    yield* capture('fstat-mixed-revision', ['fstat', `${file}#999999`, '//p4ts/main/docs/guide/getting-started.md']);
    yield* write(['sync', `${file}#none`]);
    yield* capture('files-unsynced-have', ['files', `${file}#have`]);
    yield* write(['sync', file]);
    for (const mode of ['json', 'tagged', 'marshal'] as const) {
      yield* capture(`modes-${mode}-files`, ['files', file], mode);
      yield* capture(
        `modes-${mode}-empty`,
        ['files', '//p4ts/main/missing.txt'],
        mode,
      );
    }
    const missing = '//p4ts/main/missing.txt';
    for (const [name, args] of [
      ['files-empty', ['files', missing]],
      ['dirs-empty', ['dirs', '//p4ts/main/missing/*']],
      ['fstat-empty', ['fstat', missing]],
      ['filelog-empty', ['filelog', '-l', missing]],
      ['annotate-empty', ['annotate', '-q', '-c', missing]],
      ['print-empty', ['print', '-q', missing]],
      ['opened-empty', ['opened', file]],
      ['changes-empty', ['changes', '-s', 'submitted', '-l', '-m', '5', missing]],
      ['changes-pending-empty', ['changes', '-s', 'pending', '-l', '-m', '5']],
      ['changes-shelved-empty', ['changes', '-s', 'shelved', '-l', '-m', '5']],
      ['users-unknown', ['users', 'missing-user']],
      ['client-unknown', ['client', '-o', 'missing-client']],
      ['streams-empty', ['streams', '//p4ts/missing']],
      ['describe-unknown', ['describe', '-s', '999999']],
      ['files-bad-revision', ['files', `${file}#invalid`]],
      ['files-missing-revision', ['files', `${file}#999999`]],
      ['files-at-unknown-change', ['files', `${file}@=999999`]],
      ['sync-up-to-date', ['sync', '-n', file]],
      ['sync-not-in-view', ['sync', '-n', '//other/main/a.txt']],
      ['where-not-in-view', ['where', '//other/main/a.txt']],
      ['sync-outside-stream', ['sync', '-n', '//p4ts/elsewhere/a.txt']],
      ['have-not-on-client', ['have', missing]],
      ['diff-not-opened', ['diff', '-du', file]],
      ['diff2-bad-revision', ['diff2', '-du', `${file}#invalid`, `${file}#1`]],
      ['diff2-empty', ['diff2', '-du', `${missing}#1`, `${missing}#2`]],
      ['reconcile-empty', ['reconcile', '-n', file]],
      ['reconcile-modtime', ['reconcile', '-n', '-m', file]],
      ['reconcile-writable', ['reconcile', '-n', '-w', file]],
      ['status-preview', ['status', '-n', file]],
      ['sync-keep-preview', ['sync', '-n', '-k', file]],
      ['sync-force-preview', ['sync', '-n', '-f', file]],
    ] satisfies Array<[string, string[]]>)
      yield* capture(name, args);
    yield* capture('print-empty-plain', ['print', '-q', missing], 'plain');
    yield* capture('diff-not-opened-plain', ['diff', '-du', file], 'plain');
    yield* capture(
      'diff2-bad-revision-plain',
      ['diff2', '-du', `${file}#invalid`, `${file}#1`],
      'plain',
    );
    yield* capture('sync-unknown-client', ['sync', '-n', file], 'json', {
      P4CLIENT: 'missing-client',
    });
    yield* capture('unicode-charset-required', ['files', file], 'json', {
      P4CHARSET: 'none',
    });
    const reserved = '//p4ts/main/wire/literal%40%23%25.txt';
    yield* write(['edit', reserved]);
    yield* capture('opened-reserved', ['opened', reserved]);
    yield* capture('fstat-reserved', ['fstat', reserved]);
    yield* capture('where-reserved', ['where', reserved]);
    yield* write(['revert', reserved]);
    yield* capture('info-unknown-user', ['info'], 'plain', {
      P4USER: 'missing-user',
    });
    yield* write(['edit', local]);
    for (const mode of ['json', 'tagged', 'marshal'] as const)
      yield* capture(`opened-unchanged-${mode}`, ['sync', '-n', file], mode);
    yield* capture('opened-default', ['opened', '-c', 'default']);
    writeFileSync(local, 'one\nchanged line\n');
    yield* capture('diff-opened', ['diff', '-du', file], 'plain');
    yield* capture('diff-opened-json', ['diff', '-du', file]);
    yield* write(
      ['change', '-i'],
      `Change: new\nClient: ${env.P4CLIENT}\nUser: ${env.P4USER}\nDescription:\n\tPending wire fixture\n`,
    );
    const pending = yield* run([
      '-Mj',
      '-z',
      'tag',
      'changes',
      '-s',
      'pending',
      '-m',
      '1',
    ]);
    const pendingChange = decodeChange(pending.stdout.trim()).change;
    yield* write(['reopen', '-c', pendingChange, local]);
    yield* capture('changes-pending', [
      'changes',
      '-s',
      'pending',
      '-l',
      '-m',
      '5',
      '-u',
      env.P4USER ?? '',
      '-c',
      env.P4CLIENT ?? '',
    ]);
    yield* capture('describe-pending', ['describe', '-s', pendingChange]);
    yield* capture('changes-pending-long', [
      'changes',
      '-s',
      'pending',
      '-l',
      '-m',
      '5',
    ]);
    yield* capture('describe-shelved-empty', [
      'describe',
      '-S',
      '-s',
      pendingChange,
    ]);
    yield* write(['shelve', '-c', pendingChange]);
    yield* capture('changes-shelved', [
      'changes',
      '-s',
      'shelved',
      '-l',
      '-m',
      '5',
    ]);
    yield* capture('describe-shelved', ['describe', '-S', '-s', pendingChange]);
    yield* capture(
      'diff2-shelved',
      ['diff2', '-du', `${file}#1`, `${file}@=${pendingChange}`],
      'plain',
    );
    yield* write(['revert', local]);
    yield* write(['shelve', '-d', '-c', pendingChange]);
    yield* write(['change', '-d', pendingChange]);
    // A second client produces concurrent opens, exclusive-file failures and conflicting head revisions.
    const secondRoot = join(dirname(workspace), 'second-client');
    mkdirSync(secondRoot);
    const secondEnv = {
      P4CLIENT: 'wire_second',
      P4CONFIG: join(secondRoot, 'disabled'),
    };
    yield* write(
      ['client', '-i'],
      `Client: wire_second\nOwner: ${env.P4USER}\nRoot: ${secondRoot}\nOptions: allwrite clobber nocompress unlocked nomodtime rmdir\nLineEnd: local\nStream: //p4ts/main\n`,
      secondEnv,
    );
    yield* write(['sync', '//p4ts/main/wire/...'], undefined, secondEnv);
    yield* write(
      ['edit', '//p4ts/main/wire/exclusive.uasset'],
      undefined,
      secondEnv,
    );
    yield* write(
      ['lock', '//p4ts/main/wire/exclusive.uasset'],
      undefined,
      secondEnv,
    );
    yield* capture('fstat-exclusive-other', [
      'fstat',
      '//p4ts/main/wire/exclusive.uasset',
    ]);
    yield* capture('opened-other-client', [
      'opened',
      '-a',
      '//p4ts/main/wire/exclusive.uasset',
    ]);
    yield* capture('exclusive-edit-failure', [
      'edit',
      '//p4ts/main/wire/exclusive.uasset',
    ]);
    yield* write(
      ['revert', '//p4ts/main/wire/exclusive.uasset'],
      undefined,
      secondEnv,
    );
    yield* write(['edit', local]);
    writeFileSync(local, 'our conflicting line\n');
    yield* write(
      ['edit', file, '//p4ts/main/wire/clobber.txt'],
      undefined,
      secondEnv,
    );
    writeFileSync(
      join(secondRoot, 'wire/text.txt'),
      'their conflicting line\n',
    );
    writeFileSync(join(secondRoot, 'wire/clobber.txt'), 'clobber head\n');
    yield* write(['submit', '-d', 'Second client head'], undefined, secondEnv);
    yield* capture('sync-opened-new-head-preview', ['sync', '-n', file]);
    yield* capture(
      'sync-opened-new-head-tagged',
      ['sync', '-n', file],
      'tagged',
    );
    yield* capture(
      'sync-opened-new-head-marshal',
      ['sync', '-n', file],
      'marshal',
    );
    yield* capture('sync-opened-new-head', ['sync', file]);
    yield* capture('fstat-unresolved', ['fstat', file]);
    yield* capture('resolve-preview', ['resolve', '-n', file]);
    yield* write(['resolve', '-at', file]);
    yield* write(['revert', local]);
    yield* capture(
      'diff2-normal',
      ['diff2', '-du', `${file}#1`, `${file}#2`],
      'plain',
    );
    yield* capture('diff2-normal-json', ['diff2', '-du', `${file}#1`, `${file}#2`]);
    yield* capture('diff2-normal-marshal', ['diff2', '-du', `${file}#1`, `${file}#2`], 'marshal');
    // noclobber must be set explicitly: the canonical fixture normally permits clobbering.
    const spec = yield* run(['client', '-o']);
    yield* write(
      ['client', '-i'],
      spec.stdout.replace('allwrite clobber', 'noallwrite noclobber'),
    );
    writeFileSync(
      join(workspace, 'wire/clobber.txt'),
      'local writable content\n',
    );
    yield* capture('sync-clobber', ['sync', '//p4ts/main/wire/clobber.txt']);
    yield* write(['sync', '-f', '//p4ts/main/wire/clobber.txt']);
    // A directory occupying a file's local path makes the OS refuse the write.
    rmSync(local, { force: true });
    mkdirSync(join(local, 'occupied'), { recursive: true });
    yield* capture('sync-os-error-preview', ['sync', '-n', '-f', file]);
    yield* capture('sync-os-error', ['sync', '-f', file]);
    rmSync(local, { recursive: true, force: true });
    yield* write(['sync', '-f', file]);
    // Later scenarios edit this file offline, as they could before the forced sync.
    chmodSync(local, 0o666);
    // Reconcile reports data plus warnings. Reserved names remain escaped on the wire.
    writeFileSync(join(workspace, 'wire/new file.txt'), 'local add\n');
    writeFileSync(local, 'offline edit\n');
    yield* capture('reconcile-data', [
      'reconcile',
      '-n',
      '//p4ts/main/wire/...',
    ]);
    yield* capture('reconcile-progress', [
      '-I',
      'reconcile',
      '-n',
      '//p4ts/main/wire/...',
    ]);
    yield* write(['sync', '-f', file]);
    // Move actions appear in indexed describe and filelog integration arrays.
    yield* write(['edit', local]);
    yield* write(['move', local, join(workspace, 'wire/renamed.txt')]);
    yield* capture('opened-move', ['opened']);
    yield* write(['submit', '-d', 'Wire move fixture']);
    const moved = yield* run(['-Mj', '-z', 'tag', 'changes', '-m', '1']);
    const movedChange = decodeChange(moved.stdout.trim()).change;
    yield* capture('describe-move', ['describe', '-s', movedChange]);
    yield* capture('filelog-move', [
      'filelog',
      '-l',
      '-i',
      '//p4ts/main/wire/renamed.txt',
    ]);
    // Windows may require symlink privilege; record the failed case rather than using production.
    yield* Effect.gen(function* () {
      yield* Effect.try({
        try: () => symlinkSync('renamed.txt', join(workspace, 'wire/link')),
        catch: (error) =>
          new WireScriptError('Cannot create a fixture symlink.', error),
      });
      yield* write(['add', '-t', 'symlink', join(workspace, 'wire/link')]);
      yield* write(['submit', '-d', 'Wire symlink fixture']);
      yield* capture('files-symlink', ['files', '//p4ts/main/wire/link']);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* run(['revert', join(workspace, 'wire/link')]);
          writeFileSync(
            join(destination, 'gap-symlink.json'),
            JSON.stringify(
              {
                origin: 'disposable',
                gap: 'Windows symlink creation or add failed',
                detail: normalize(String(error)),
              },
              null,
              2,
            ) + '\n',
          );
        }),
      ),
    );
    const bulk = join(workspace, 'bulk');
    mkdirSync(bulk);
    for (let index = 0; index < 1001; index += 1)
      writeFileSync(
        join(bulk, `f${String(index).padStart(4, '0')}.txt`),
        'large describe fixture\n',
      );
    yield* write(['add', join(bulk, '...')]);
    yield* write(['submit', '-d', 'Wire 1001-file fixture']);
    const large = yield* run(['-Mj', '-z', 'tag', 'changes', '-m', '1']);
    const largeChange = decodeChange(large.stdout.trim()).change;
    yield* capture('describe-large', ['describe', '-s', largeChange]);
    // Enough untracked files for reconcile to have a chance to report -I progress through a pipe.
    for (let index = 0; index < 2000; index += 1)
      writeFileSync(
        join(bulk, `new${String(index).padStart(4, '0')}.txt`),
        'untracked reconcile fixture\n',
      );
    yield* capture('reconcile-progress-large', [
      '-I',
      'reconcile',
      '-n',
      '//p4ts/main/bulk/...',
    ]);
    for (let index = 0; index < 2000; index += 1)
      rmSync(join(bulk, `new${String(index).padStart(4, '0')}.txt`));
    yield* capture('changes-cursor-separated', [
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '5',
      '//p4ts/main/wire/...',
      '@4',
    ]);
    yield* capture('changes-cursor-scoped', [
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '5',
      '//p4ts/main/wire/...@4',
    ]);
    yield* capture('changes-multi-scope', [
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '5',
      '//p4ts/main/wire/...@4',
      '//p4ts/main/docs/...@4',
    ]);
    // Lines added, kept and changed across three submits, so annotate attributes each line to a change.
    const blame = join(workspace, 'blame/blame.txt');
    mkdirSync(dirname(blame), { recursive: true });
    writeFileSync(blame, 'first\nsecond\n');
    yield* write(['add', blame]);
    yield* write(['submit', '-d', 'Blame revision one']);
    yield* write(['edit', blame]);
    writeFileSync(blame, 'first\nsecond\nthird\n');
    yield* write(['submit', '-d', 'Blame revision two']);
    yield* write(['edit', blame]);
    writeFileSync(blame, 'first\nSECOND\nthird\n');
    yield* write(['submit', '-d', 'Blame revision three']);
    yield* capture('annotate-revisions', ['annotate', '-q', '-c', '//p4ts/main/blame/blame.txt']);
    yield* capture('filelog-revisions', ['filelog', '-l', '-m', '11', '//p4ts/main/blame/blame.txt']);
    // Permission failures can be errors or intentionally empty listings, depending on command.
    yield* write(
      ['user', '-f', '-i'],
      'User: limited\nEmail: limited@example.invalid\nFullName: Limited fixture\n',
    );
    yield* write(
      ['protect', '-i'],
      `Protections:\n\tsuper user ${env.P4USER} * //...\n\tlist user limited * //...\n`,
    );
    yield* capture(
      'print-permission',
      ['print', '-q', '//p4ts/main/wire/renamed.txt'],
      'json',
      {
        P4USER: 'limited',
      },
    );
    yield* capture(
      'files-permission',
      ['files', '//p4ts/main/wire/renamed.txt'],
      'json',
      {
        P4USER: 'limited',
      },
    );
    yield* write(
      ['group', '-i'],
      `Group: wire_timeout\nTimeout: 1\nUsers:\n\t${env.P4USER}\n`,
    );
    yield* write(['passwd'], 'WirePassword123!\nWirePassword123!\n');
    yield* write(['login'], 'WirePassword123!\n');
    yield* write(['configure', 'set', 'security=3']);
    yield* capture('changes-not-logged-in', ['changes', '-m', '1'], 'json', {
      P4PASSWD: '',
      P4TICKETS: join(workspace, 'empty-tickets'),
    });
    yield* write(['login'], 'WirePassword123!\n');
    // Server ticket timestamps have whole-second precision; allow for the boundary.
    yield* Effect.sleep('3 seconds');
    const expired = yield* capture('changes-ticket-expired', [
      'changes',
      '-m',
      '1',
    ]);
    if (
      !/session has expired|ticket.*expired/i.test(
        expired.stdout + expired.stderr,
      )
    ) {
      return yield* Effect.fail(
        new WireScriptError(
          'The disposable ticket did not expire as expected.',
        ),
      );
    }
    // Stopping our own server preserves its original endpoint for both transport cases.
    yield* Effect.tryPromise({
      try: fixture.pauseServer,
      catch: (error) => new WireScriptError(String(error), error),
    });
    yield* capture('server-unreachable', ['info']);
    yield* capture('server-unreachable-summary', ['info', '-s']);
    yield* capture('command-timeout', ['info'], 'json', {}, 1);
    console.log(
      `Recorded ${count} disposable command captures in tests/fixtures/wire.`,
    );
  });
}

if (import.meta.main) {
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Effect.tryPromise({
        try: () => startFixture({ unicode: true }),
        catch: (error) => new WireScriptError(String(error), error),
      });
      return yield* scenarios(fixture).pipe(
        Effect.ensuring(Effect.promise(fixture.stop)),
      );
    }),
  ).catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
