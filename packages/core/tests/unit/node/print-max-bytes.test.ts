import { afterAll, describe, expect, it } from 'vite-plus/test';
import { Layer } from 'effect';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printFile } from '../../../src/commands/print.js';
import { P4Executor } from '../../../src/exec/executor.js';
import { runNodeProcess } from '../../../src/node/executor.js';
import { run } from '../commands/support.js';

const scratch = mkdtempSync(join(tmpdir(), 'p4ts-print-cut-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A stand-in for `p4 -G print` of a 1 GiB revision: a stat record, then 64 KiB content records
// for as long as anyone reads them. It never exits on its own.
const ENDLESS_PRINT = `
const fs = require('node:fs');
fs.writeFileSync(process.env.P4TS_PID_FILE, String(process.pid));
const str = (value) => { const bytes = Buffer.from(value, 'latin1'); const length = Buffer.alloc(4); length.writeInt32LE(bytes.length); return Buffer.concat([Buffer.from('s'), length, bytes]); };
const record = (fields) => Buffer.concat([Buffer.from('{'), ...Object.entries(fields).flatMap(([key, value]) => [str(key), str(value)]), Buffer.from('0')]);
process.stdout.write(record({ code: 'stat', depotFile: '//d/Hero.uasset', rev: '4', type: 'binary+l', fileSize: '1073741824' }));
const chunk = record({ code: 'binary', data: 'x'.repeat(65536) });
const pump = () => { while (process.stdout.write(chunk)) {} process.stdout.once('drain', pump); };
pump();
`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe('printFile maxBytes with a real process', () => {
  it('kills p4 once it has the first bytes, instead of reading the whole revision', async () => {
    const pidFile = join(scratch, 'pid');

    const executor = Layer.succeed(P4Executor, {
      run: (invocation) => runNodeProcess({
        ...invocation,
        executable: process.execPath,
        args: ['-e', ENDLESS_PRINT],
        env: { ...invocation.env, P4TS_PID_FILE: pidFile },
      }),
    });

    const printed = await run(printFile, { file: '//d/Hero.uasset', revision: 4, maxBytes: 512 * 1024 }, executor);
    expect(printed).toMatchObject({ fileSize: 1_073_741_824, isTruncated: true });
    expect(printed.content.length).toBe(512 * 1024);
    expect(printed.content.every((byte) => byte === 0x78)).toBe(true);
    expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  });
});
