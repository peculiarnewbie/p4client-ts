import { Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const Manifest = Schema.Struct({
  main: Schema.String,
  types: Schema.String,
  exports: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
});
const PackedPackage = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
});
// npm 12 keys the report by package name; earlier versions print an array.
const PackReport = Schema.Union([Schema.Array(PackedPackage), Schema.Record(Schema.String, PackedPackage)]);

/**
 * Validate npm's actual file list against every declared runtime and type entry.
 * @param directory Package directory; defaults to the core package.
 * @returns Number of files npm would pack.
 * @throws When npm fails or a declared entry is absent from its package file list.
 */
export function checkPackage(directory = fileURLToPath(new URL('..', import.meta.url))): number {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  // npm.cmd needs cmd.exe on Windows. All shell arguments here are constant.
  const packed = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
      cwd: directory, encoding: 'utf8', windowsHide: true,
    })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: directory, encoding: 'utf8' });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const report = Schema.decodeUnknownSync(Schema.fromJsonString(PackReport))(packed.stdout);
  const reports: ReadonlyArray<typeof PackedPackage.Type> = Array.isArray(report) ? report : Object.values(report);
  if (reports.length !== 1) throw new Error('Expected exactly one npm pack report.');
  const paths = new Set(reports[0]!.files.map((file) => file.path));
  const entries = [manifest.main, manifest.types, ...Object.values(manifest.exports).flatMap(Object.values)];
  const missing = [...new Set(entries)].filter((entry) => !paths.has(entry.replace(/^\.\//, '')));
  if (missing.length > 0) {
    throw new Error(`Package is missing declared entry points:\n${missing.join('\n')}\nRun bun run clean && bun run build, then retry pack:core.`);
  }
  return paths.size;
}

if (import.meta.main) {
  console.log(`Pack check passed: ${checkPackage()} files; all declared entry points included.`);
}
