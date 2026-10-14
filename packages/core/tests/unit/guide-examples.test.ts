import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('published guide examples', () => {
  for (const name of ['index', 'getting-started', 'effect-service', 'testing-and-fixtures']) {
    it(`keeps ${name} examples identical to their typechecked source`, () => {
      const path = name === 'index' ? `${name}.mdx` : `guides/${name}.mdx`;
      const document = readFileSync(join(import.meta.dir, '../../../www/src/content/docs', path), 'utf8');
      const examples = [...document.matchAll(/```ts\r?\n([\s\S]*?)```/g)]
        .map((match) => match[1]).join('\n')
        .replaceAll("'p4client-ts/promise'", "'../../src/promise/index.js'")
        .replaceAll("'p4client-ts/node'", "'../../src/node/index.js'")
        .replaceAll("'p4client-ts/testing'", "'../../src/testing/index.js'")
        .replaceAll("'p4client-ts'", "'../../src/index.js'")
        .replaceAll('\r\n', '\n').trim();
      const typed = readFileSync(join(import.meta.dir, `../types/guide-${name}.ts`), 'utf8')
        .replaceAll('\r\n', '\n').split('\n').slice(1).join('\n').trim();
      expect(typed).toBe(examples);
    });
  }
});
