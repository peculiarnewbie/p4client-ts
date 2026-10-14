import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorkspaceForPath, workspaceRootExists } from '../../../src/node/workspace.js';
import { scriptedExecutor } from '../../../src/testing/executor.js';
import { invocations, run } from '../commands/support.js';

const scratch = mkdtempSync(join(tmpdir(), 'p4ts-workspace-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const project = join(scratch, 'Project');
const nested = join(project, 'Plugins', 'Tool');
const alternate = join(scratch, 'Alternate');
mkdirSync(join(nested, 'Source'), { recursive: true });
mkdirSync(join(alternate, 'Content'), { recursive: true });

const clients = [
  { client: 'project', Owner: 'arif', Root: project },
  { client: 'tool', Owner: 'arif', Root: nested },
  { client: 'elsewhere', Owner: 'arif', Root: join(scratch, 'Missing') },
];

const executor = scriptedExecutor((invocation) => {
  const spec = invocation.args.indexOf('-o');
  if (spec >= 0) {
    const client = invocation.args[spec + 1];
    return { stdout: `${JSON.stringify(client === 'elsewhere' ? { Client: client, AltRoots0: alternate } : { Client: client })}\n` };
  }
  return { stdout: clients.map((row) => JSON.stringify(row)).join('\n') };
});

describe('findWorkspaceForPath', () => {
  it('prefers the deepest root containing the path', async () => {
    const found = await run(findWorkspaceForPath, { path: join(nested, 'Source') }, executor);
    expect(found.match).toMatchObject({ root: nested, relativePath: 'Source' });
    expect(found.match?.workspace.client).toBe('tool');
    expect(found.candidates.map((candidate) => candidate.workspace.client)).toEqual(['tool', 'project']);
  });

  it('matches regardless of case when asked to', async () => {
    const found = await run(findWorkspaceForPath, { path: join(project.toUpperCase(), 'x'), caseInsensitive: true }, executor);
    expect(found.match?.workspace.client).toBe('project');
  });

  it('finds nothing outside every root without reading alternate roots', async () => {
    const found = await run(findWorkspaceForPath, { path: join(alternate, 'Content') }, executor);
    expect(found).toMatchObject({ match: null, candidates: [] });
  });

  it('reads alternate roots only of workspaces whose root does not match', async () => {
    const path = join(alternate, 'Content');
    const found = await run(findWorkspaceForPath, { path, altRoots: true }, executor);
    expect(found.match).toMatchObject({ root: alternate, relativePath: 'Content' });
    expect(found.match?.workspace.client).toBe('elsewhere');
    const commands = await invocations(findWorkspaceForPath, { path: join(nested, 'Source'), altRoots: true, user: 'arif' }, (args) =>
      args.includes('-o') ? {} : { stdout: clients.map((row) => JSON.stringify(row)).join('\n') });
    expect(commands).toEqual([
      ['-Mj', '-z', 'tag', 'clients', '-u', 'arif'],
      ['-Mj', '-z', 'tag', 'client', '-o', 'elsewhere'],
    ]);
  });
});

describe('workspaceRootExists', () => {
  it('checks the root on disk', () => {
    expect(workspaceRootExists({ root: project })).toBe(true);
    expect(workspaceRootExists({ root: join(scratch, 'Missing') })).toBe(false);
  });
});
