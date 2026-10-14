// Published guide examples; typechecked by the repository.
import { createP4Client } from '../../src/promise/index.js';
import { printedText } from '../../src/index.js';

const client = createP4Client({
  cwd: '/work/project',
  connection: {
    port: 'ssl:perforce:1666',
    user: 'alice',
    client: 'alice_ws',
    isolated: true,
  },
  timeoutMs: 30_000,
});
try {
  const environment = await client.getEnvironment({});
  const opened = await client.listOpenedFiles({});
  const printed = await client.printFile({ file: '//depot/main/README.md' });
  console.log(environment.client, opened.items, printedText(printed));
} finally {
  await client.dispose();
}

const writable = client.with({ allowMutation: true });
try {
  const preview = await client.previewSync({ fileSpec: '//depot/main/...' });
  if (preview.failures.length > 0) throw new Error('Incomplete sync preview.');
  if (preview.items.length > 0) {
    const synced = await writable.sync({ fileSpec: '//depot/main/...' });
    console.log(synced.items, synced.failures);
  }
} finally {
  await writable.dispose();
}

const controller = new AbortController();
const handle = client.watch.previewSync({
  fileSpec: '//depot/main/...',
  progressIntervalMs: 250,
  signal: controller.signal,
});
for await (const event of handle.events) {
  if (event._tag === 'progress') console.log(event.progress);
  if (event._tag === 'failure') console.log(event.failure);
}
const result = await handle.result;
console.log(result.items);

import { Schema } from 'effect';

const rows = await client.runTagged({
  args: ['files', '//depot/main/...'],
  schema: Schema.Struct({ depotFile: Schema.String }),
});
console.log(rows.items.map((row) => row.depotFile));

const projectCwd = '/work/project';
const probe = createP4Client({ cwd: projectCwd });
try {
  const resolved = await probe.resolveConnection({ sources: ['p4'] });
  console.log(resolved.sources); // { port: 'p4', user: 'p4', ... }
  const connected = probe.with({ connection: resolved.connection });
  try {
    const info = await connected.getEnvironment({});
    const user = resolved.connection.user ?? info.user;
    if (user === null || user === undefined) throw new Error('Choose a Perforce user.');
    const owned = await connected.listWorkspaces({ user });
    const match = await connected.findWorkspaceForPath({ path: projectCwd, user, altRoots: true });
    if (match.match === null) throw new Error('No workspace contains this project.');
    if (resolved.connection.port === undefined) throw new Error('Choose a Perforce server.');
    const project = connected.with({ connection: {
      ...resolved.connection, user, client: match.match.workspace.client, isolated: true,
    } });
    try {
      console.log(owned.items, await project.listOpenedFiles({}));
    } finally { await project.dispose(); }
  } finally { await connected.dispose(); }
} finally { await probe.dispose(); }

const openedForMapping = await client.listOpenedFiles({});
if (openedForMapping.items.length > 0) {
  const mapped = await client.whereFiles({
    fileSpec: openedForMapping.items.map((file) => {
      const spec = file.clientFile ?? file.depotFile;
      if (spec === null) throw new Error('Opened file has no mapping spec.');
      return spec;
    }),
  });
  if (mapped.failures.length > 0) throw new Error('Incomplete workspace mappings.');
  const localFiles = openedForMapping.items.map((file) => {
    const rows = mapped.items.filter((row) => row.depotFile === file.depotFile);
    const usable = rows.filter((row) => !row.isExcluded && row.localFile !== null);
    if (rows.some((row) => row.isExcluded) || usable.length !== 1) {
      throw new Error(`Missing or ambiguous mapping for ${file.depotFile}`);
    }
    return { file, localFile: usable[0]!.localFile! };
  });
  console.log(localFiles);
}

const syncAbort = new AbortController();
const syncClient = createP4Client({
  connection: { port: 'ssl:perforce:1666', user: 'alice', client: 'alice_ws', isolated: true },
  allowMutation: true,
});
const syncWatch = syncClient.watch.sync({ fileSpec: '//depot/main/...', signal: syncAbort.signal });
let latestPath: string | null = null;
try {
  for await (const event of syncWatch.events) {
    if (event._tag === 'item') latestPath = event.item.depotFile;
    if (event._tag === 'progress') {
      console.log(latestPath, event.progress.completed, event.progress.total);
    }
    if (event._tag === 'failure') console.error(event.failure.spec, event.failure.reason);
    if (event._tag === 'message') console.log(event.message.text);
  }
  const synced = await syncWatch.result;
  if (synced.failures.length > 0) throw new Error('Sync completed with item failures.');
} catch (error) {
  console.error(syncAbort.signal.aborted ? syncAbort.signal.reason : error);
} finally {
  syncAbort.abort(new Error('Closing sync view'));
  await syncWatch.result.catch(() => undefined);
  await syncClient.dispose();
}

const specs = ['//depot/main/a', '//depot/main/b'];
const batchRows = await client.runTagged({
  args: ['-x', '-', 'diff', '-se'], input: specs.join('\n') + '\n',
  policy: { no_such_file: 'item', not_in_view: 'item' },
});
if (batchRows.failures.length > 0) throw new Error('Incomplete diff evidence.');

import { runNodeProcessPromise } from '../../src/node/index.js';

const processOutput = await runNodeProcessPromise({
  executable: 'p4', args: ['-p', 'ssl:perforce:1666', 'info', '-s'],
  cwd: '/work/project', env: {}, input: undefined,
}, { signal: new AbortController().signal });
console.log(processOutput.stdout, processOutput.stderr, processOutput.exitCode);
