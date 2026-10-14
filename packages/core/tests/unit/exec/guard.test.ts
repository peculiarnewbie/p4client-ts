import { describe, expect, it } from 'bun:test';
import { checkCommand } from '../../../src/exec/guard.js';

const mutates = (args: string[], input?: string) => checkCommand(args, input).mutates;

describe('checkCommand', () => {
  it('finds the subcommand after global options', () => {
    expect(checkCommand(['-p', 'ssl:p4:1666', '-c', 'ws', '-Mj', '-z', 'tag', '-zprog=x', 'files', '//d/...']))
      .toEqual({ command: 'files', mutates: false });
  });

  it('accepts read commands', () => {
    for (const command of ['info', 'changes', 'describe', 'fstat', 'filelog', 'print', 'where', 'opened', 'diff2']) {
      expect(mutates([command])).toBe(false);
    }
  });

  it('accepts spec reads only with -o', () => {
    expect(mutates(['client', '-o'])).toBe(false);
    expect(mutates(['client', '-i'])).toBe(true);
    expect(mutates(['change', '-d', '12'])).toBe(true);
  });

  it('accepts previews only with -n', () => {
    expect(mutates(['sync', '-n', '//d/...'])).toBe(false);
    expect(mutates(['sync', '//d/...'])).toBe(true);
    expect(mutates(['reconcile', '-n'])).toBe(false);
    expect(mutates(['edit', '//d/a.txt'])).toBe(true);
    expect(mutates(['edit', '-n', '//d/a.txt'])).toBe(false);
  });

  it('accepts reading settings but not writing them', () => {
    expect(mutates(['set', '-q'])).toBe(false);
    expect(mutates(['set', 'P4CLIENT=ws'])).toBe(true);
    expect(mutates(['property', '-l', '-n', 'x'])).toBe(false);
    expect(mutates(['login', '-s'])).toBe(false);
    expect(mutates(['login'])).toBe(true);
  });

  it('fails closed for unknown commands and argument files', () => {
    expect(mutates(['obliterate', '-y', '//d/...'])).toBe(true);
    expect(mutates(['-x', 'args.txt', 'print'])).toBe(true);
    expect(mutates(['-xargs.txt', 'print'])).toBe(true);
  });

  it('inspects arguments read from stdin', () => {
    expect(mutates(['-x', '-', 'print'], '//d/a.txt\n//d/b.txt\n')).toBe(false);
    expect(mutates(['-x', '-', 'sync', '-n'], '-f\n//d/a.txt\n')).toBe(true);
  });

  it('reports invocations without a subcommand', () => {
    expect(checkCommand(['-V'])).toEqual({ command: null, mutates: false });
  });
});
