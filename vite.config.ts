import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import lint from './oxlint.config.ts';

const local = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// The canonical E2E runner sets this after it starts a disposable p4d; nothing else runs those tests.
const e2e = process.env.P4_TS_E2E_P4_EXECUTABLE !== undefined;

export default defineConfig({
  run: {
    cache: { scripts: false },
  },
  test: {
    environment: 'node',
    maxWorkers: 4,
    projects: e2e
      ? [{
        test: {
          name: 'e2e',
          root: local('./packages/core'),
          include: ['tests/e2e/**/*.test.ts'],
          // Every scenario shares one fixture server and workspace.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      }]
      : [
        {
          test: {
            name: 'core',
            root: local('./packages/core'),
            include: ['tests/*.test.ts', 'tests/unit/**/*.test.ts'],
          },
        },
        {
          test: {
            name: 'lint-rules',
            root: local('./tools/oxlint/t3code'),
            include: ['**/*.test.ts'],
            testTimeout: 30_000,
          },
        },
      ],
  },
  lint,
});
