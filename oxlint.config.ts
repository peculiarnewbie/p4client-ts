// Lint configuration for both `vite.config.ts` and `effect-tsgo oxlint`, which loads this file
// directly: raw Oxlint cannot load `vite.config.ts`, and plain `vp lint` lacks the Effect plugin.
import { fileURLToPath } from 'node:url';
import { recommended as effectRecommended } from '@effect/tsgo/oxlint-presets';

const local = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default {
  extends: [effectRecommended],
  options: { typeAware: true, typeCheck: false },
  ignorePatterns: [
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
    '.tmp/**',
    '**/node_modules/**',
    '**/dist/**',
    'packages/core/.captures/**',
    'packages/www/.astro/**',
    'packages/www/dist/**',
    'tools/oxlint/anti-slop/**',
    'tools/oxlint/t3code/**',
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: local('./tools/oxlint/anti-slop/index.ts') },
    { name: 'anti-slop-effect', specifier: local('./tools/oxlint/anti-slop/effect/index.ts') },
    { name: 't3code', specifier: local('./tools/oxlint/t3code/index.ts') },
  ],
  rules: {
    'oxc/no-accumulating-spread': 'error',
    'anti-slop/no-array-filter-map': 'error',
    'anti-slop/no-reduce-accumulator-copy': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-readable-spacing': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop-effect/no-manual-effect-error-tag': 'error',
    'anti-slop-effect/no-manual-tag-comparison': 'error',
    'anti-slop-effect/no-manual-tagged-construction': 'error',
    'anti-slop-effect/no-service-constructor-imports': 'error',
    'anti-slop-effect/prefer-effect-match': 'error',
    't3code/no-inline-schema-compile': 'error',
    't3code/no-low-value-comments': 'error',
    't3code/prefer-effect-fn': 'error',
    't3code/require-suppression-reason': 'error',
  },
  overrides: [
    {
      files: ['packages/core/tests/**'],
      rules: { 't3code/prefer-effect-fn': 'off' },
    },
  ],
};
