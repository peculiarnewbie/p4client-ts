import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = resolve(projectRoot, 'node_modules/effect-solutions/dist/cli.js');

if (!existsSync(cliPath)) {
  console.error('effect-solutions is not installed. Run `bun install` first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Failed to run effect-solutions: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
