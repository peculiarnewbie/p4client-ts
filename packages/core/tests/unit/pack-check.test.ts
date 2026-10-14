import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPackage } from '../../scripts/pack-check.js';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(files = '["dist"]'): string {
  const directory = mkdtempSync(join(tmpdir(), 'p4-pack-check-'));
  scratch.push(directory);
  writeFileSync(join(directory, 'package.json'), `{
    "name": "pack-check-fixture", "version": "1.0.0", "files": ${files},
    "main": "./dist/index.js", "types": "./dist/index.d.ts",
    "exports": {
      ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
      "./node": { "import": "./dist/node/index.js", "types": "./dist/node/index.d.ts" },
      "./promise": { "import": "./dist/promise/index.js", "types": "./dist/promise/index.d.ts" },
      "./testing": { "import": "./dist/testing/index.js", "types": "./dist/testing/index.d.ts" }
    }
  }`);
  return directory;
}

function build(directory: string, omitted = ''): void {
  for (const entry of ['', 'node/', 'promise/', 'testing/']) {
    mkdirSync(join(directory, 'dist', entry), { recursive: true });
    for (const extension of ['js', 'd.ts']) {
      const file = `${entry}index.${extension}`;
      if (file !== omitted) writeFileSync(join(directory, 'dist', file), 'export {};\n');
    }
  }
}

describe('package entry point validation', () => {
  it('accepts a complete package', () => {
    const directory = fixture();
    build(directory);
    expect(checkPackage(directory)).toBe(9);
  });

  it('rejects absent dist even when an incremental build cache remains', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'tsconfig.tsbuildinfo'), '{}');
    expect(() => checkPackage(directory)).toThrow('./dist/index.js');
  });

  for (const entry of ['', 'node/', 'promise/', 'testing/']) {
    for (const extension of ['js', 'd.ts']) {
      const omitted = `${entry}index.${extension}`;
      it(`rejects a package missing ${omitted}`, () => {
        const directory = fixture();
        build(directory, omitted);
        expect(() => checkPackage(directory)).toThrow(`./dist/${omitted}`);
      });
    }
  }

  it('rejects an entry present on disk but excluded from the package', () => {
    const directory = fixture('["dist/index.js", "dist/index.d.ts"]');
    build(directory);
    expect(() => checkPackage(directory)).toThrow('./dist/promise/index.js');
  });
});
