import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCachedBinary } from '../scripts/test-perforce-e2e.js';

const GOOD = new TextEncoder().encode('pinned build');
const BAD = new TextEncoder().encode('republished build');
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const binary = { name: 'p4.exe', sha256: hash(GOOD) };

describe('E2E binary cache', () => {
  let cacheDirectory: string;
  let cachedPath: string;
  let downloads: string[];
  const download = (bytes: Uint8Array) => async (url: string) => {
    downloads.push(url);
    return bytes;
  };

  beforeEach(() => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'p4-ts-binary-cache-'));
    const directory = join(cacheDirectory, 'r26.1', 'bin.ntx64');
    cachedPath = join(directory, binary.name);
    mkdirSync(directory, { recursive: true });
    downloads = [];
  });

  afterEach(() => {
    rmSync(cacheDirectory, { recursive: true, force: true });
  });

  it('uses a verified cached binary without downloading', async () => {
    writeFileSync(cachedPath, GOOD);
    const path = await resolveCachedBinary('bin.ntx64', binary, { cacheDirectory, download: download(BAD) });
    expect(path).toBe(cachedPath);
    expect(downloads).toEqual([]);
  });

  it('downloads a missing binary into the cache', async () => {
    const path = await resolveCachedBinary('bin.ntx64', binary, { cacheDirectory, download: download(GOOD) });
    expect(downloads).toEqual(['https://ftp.perforce.com/perforce/r26.1/bin.ntx64/p4.exe']);
    expect(hash(readFileSync(path))).toBe(binary.sha256);
  });

  it('downloads a mismatched cached binary once more and replaces it', async () => {
    writeFileSync(cachedPath, BAD);
    const path = await resolveCachedBinary('bin.ntx64', binary, { cacheDirectory, download: download(GOOD) });
    expect(downloads).toHaveLength(1);
    expect(hash(readFileSync(path))).toBe(binary.sha256);
    expect(readdirSync(join(cacheDirectory, 'r26.1', 'bin.ntx64'))).toEqual([binary.name]);
  });

  it('fails with every hash when the fresh download also mismatches', async () => {
    writeFileSync(cachedPath, BAD);
    const failure = resolveCachedBinary('bin.ntx64', binary, { cacheDirectory, download: download(BAD) });
    await expect(failure).rejects.toThrow(`pinned:     ${binary.sha256}`);
    await expect(failure).rejects.toThrow(`downloaded: ${hash(BAD)}`);
    await expect(failure).rejects.toThrow(`cached:     ${hash(BAD)}`);
    await expect(failure).rejects.toThrow('bin.ntx64/SHA256SUMS');
    expect(downloads).toHaveLength(1);
    expect(readFileSync(cachedPath)).toEqual(Buffer.from(BAD));
  });

  it('does not cache a mismatched first download', async () => {
    await expect(
      resolveCachedBinary('bin.ntx64', binary, { cacheDirectory, download: download(BAD) })
    ).rejects.toThrow(`downloaded: ${hash(BAD)}`);
    expect(readdirSync(join(cacheDirectory, 'r26.1', 'bin.ntx64'))).toEqual([]);
  });
});
