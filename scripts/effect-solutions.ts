import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = resolve(projectRoot, 'node_modules/effect-solutions/dist/cli.js');

if (!existsSync(cliPath)) {
  console.error('effect-solutions is not installed. Run `pnpm install` first.');
  process.exit(1);
}

// effect-solutions publishes a Bun build (`import.meta.require`), so run it on a downloaded Bun.
const vpPath = resolve(projectRoot, 'node_modules/vite-plus/bin/vp');

const result = spawnSync(process.execPath, [vpPath, 'dlx', '--silent', 'bun@1.3.10', cliPath, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Failed to run effect-solutions: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
