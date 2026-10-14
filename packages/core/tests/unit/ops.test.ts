import { describe, expect, it } from 'bun:test';
import { ops } from '../../src/ops.js';
import type { P4ChangelistPage, ListChangelistsOptions, P4Changelist } from '../../src/commands/changelists.js';
import type { OpItem, OpOptions, OpResult } from '../../src/ops.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>(): T => true as T;

describe('operation registry', () => {
  it('names every operation after its method', () => {
    for (const [name, op] of Object.entries(ops)) expect(op.name).toBe(name);
  });

  it('exposes option, item and result types', () => {
    assert<Equal<OpOptions<'listChangelists'>, ListChangelistsOptions>>();
    assert<Equal<OpItem<'listChangelists'>, P4Changelist>>();
    assert<Equal<OpResult<'listChangelists'>, P4ChangelistPage>>();
  });
});
