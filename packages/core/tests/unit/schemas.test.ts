import { describe, expect, it } from 'bun:test';
import { P4ClientPath, P4DepotPath, P4FileAction, P4LocalPath } from '../../src/index.js';

describe('public brand constructors', () => {
  it('validates the same values as the exported schemas', () => {
    expect(String(P4DepotPath.make('//depot/file#3'))).toBe('//depot/file#3');
    expect(String(P4ClientPath.make('//client/file'))).toBe('//client/file');
    expect(String(P4LocalPath.make('folder/file'))).toBe('folder/file');
    expect(String(P4FileAction.make('move/add'))).toBe('move/add');
    expect(() => P4DepotPath.make('local/file')).toThrow();
    expect(() => P4ClientPath.make('')).toThrow();
    expect(() => P4LocalPath.make('bad' + String.fromCharCode(10) + 'path')).toThrow();
    expect(() => P4FileAction.make('Move/Add')).toThrow();
  });
});
