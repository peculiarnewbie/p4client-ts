import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runProductionRead,
  validateProductionRead,
} from '../scripts/prod-readonly-p4.js';

const scratch = join(tmpdir(), 'p4-guard-unit');
const forbidden = [
  'submit',
  'edit',
  'add',
  'delete',
  'move',
  'copy',
  'integrate',
  'merge',
  'resolve',
  'revert',
  'shelve',
  'unshelve',
  'lock',
  'unlock',
  'reopen',
  'change',
  'changelist',
  'fix',
  'label',
  'labelsync',
  'tag',
  'obliterate',
  'archive',
  'restore',
  'retype',
  'undo',
  'cherry-pick',
  'group',
  'protect',
  'triggers',
  'typemap',
  'job',
  'branch',
  'counter',
  'key',
  'admin',
  'configure',
  'flush',
  'clean',
  'login',
  'logout',
  'passwd',
  'trust',
];

describe('production read guard', () => {
  for (const command of forbidden) {
    it(`refuses ${command}, even with preview flags`, () => {
      expect(() => validateProductionRead([command, '-n'], scratch)).toThrow(
        'refused',
      );
    });
  }
  for (const args of [
    ['sync', '//depot/main/a'],
    ['sync', '-f', '-n', '-m', '1', '//depot/main/a'],
    ['reconcile', '//depot/main/a'],
    ['reconcile', '-n', '-w', '//depot/main/a'],
    ['status', '//depot/main/a'],
    ['client', '-i'],
    ['client', '-d', 'client1'],
    ['stream', '-i'],
    ['user', '-i'],
    ['property', '-a'],
    ['property', '-d'],
    ['set', 'P4CLIENT=client1'],
    ['set', '-q'],
    ['diff', '-f', '-sa', '//depot/main/a'],
    ['diff', '-du', '//depot/main/a'],
    ['-x', 'args.txt', 'info'],
    ['info', '-xargs.txt'],
    ['-p', 'other', 'info'],
    ['-z', 'other', 'info'],
    ['info', '\nsubmit'],
    ['fstat', '-m', '51', '//depot/main/a'],
    ['fstat', '-m', '1', '-Ol', '//depot/main/a'],
    ['files', '-m', '50', '//depot/...'],
    ['files', '//depot/main/a'],
    ['print', '-o', '../outside', '//depot/main/a'],
    ['print', '-o', scratch, '//depot/main/a'],
    ['print', '//depot/main/...'],
    ['describe', '-s', '1', '2'],
    ['info', 'submit'],
  ]) {
    it(`refuses unsafe arguments ${args.join(' ')}`, () => {
      expect(() => validateProductionRead(args, scratch)).toThrow('refused');
    });
  }
  it('allows reviewed reads with bounded output', () => {
    for (const args of [
      ['info'],
      ['set'],
      ['tickets'],
      ['-Mj', '-z', 'tag', 'sync', '-n', '-m', '50', '//depot/main/a'],
      ['-ztag', 'fstat', '-m', '1', '//depot/main/a'],
      ['-G', 'describe', '-s', '100'],
      ['client', '-o', 'client1'],
      ['stream', '-o', '//depot/main'],
      ['user', '-o', 'user1'],
      ['property', '-l', '-n', 'app.setting'],
      ['diff', '-sa', '//depot/main/a'],
      ['print', '-o', join(scratch, 'a.txt'), '//depot/main/a'],
      ['print', '-q', '//depot/main/a'],
      ['reconcile', '-n', '//depot/main/a'],
      ['status', '-n', '//depot/main/a'],
    ])
      expect(validateProductionRead(args, scratch)).toBeString();
  });
  it('refuses forbidden commands before launching an executable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p4-guard-'));
    try {
      await expect(
        runProductionRead(
          {
            port: 'invalid',
            user: 'user1',
            scratchDir: root,
            executable: 'missing-binary',
          },
          ['edit', '//depot/main/a'],
        ),
      ).rejects.toThrow('refused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('passes identity explicitly and logs subprocess exit codes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p4-guard-'));
    // Instead exercise a safe executable's own argument error; it proves an exit is logged without p4.
    try {
      const result = await runProductionRead(
        {
          port: 'invalid',
          user: 'user1',
          scratchDir: root,
          executable: process.execPath,
        },
        ['info'],
      );
      expect(result.exitCode).not.toBe(0);
      const records = readFileSync(join(root, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records[0].args).toEqual(['-p', 'invalid', '-u', 'user1', 'info']);
      expect(records[1].exitCode).toBe(result.exitCode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('releases the shared lock and logs a failed launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p4-guard-'));
    try {
      await expect(
        runProductionRead(
          {
            port: 'invalid',
            user: 'user1',
            scratchDir: root,
            executable: join(root, 'missing-executable'),
          },
          ['info'],
        ),
      ).rejects.toThrow('capture command');
      expect(existsSync(join(tmpdir(), 'p4client-prod-readonly.lock'))).toBe(
        false,
      );
      const records = readFileSync(join(root, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.event)).toEqual(['start', 'exit']);
      expect(records[1].exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
