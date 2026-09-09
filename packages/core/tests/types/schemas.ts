import { Schema } from 'effect';
import {
  P4Client, P4ClientPathSchema, P4DepotPathSchema, P4LocalPathSchema,
  P4JsonWorkspaceSchema, parseP4JsonLines
} from '../../src/public/index.js';
import type { P4ClientPath, P4DepotPath, P4LocalPath, P4JsonWorkspace } from '../../src/public/index.js';

// This file is compiled by typecheck, not executed by the unit test runner.
const Row = Schema.Struct({ revision: Schema.NumberFromString });
const decoded: Array<{ readonly revision: number }> = parseP4JsonLines('', Row);
const workspaces: P4JsonWorkspace[] = parseP4JsonLines('', P4JsonWorkspaceSchema);
const raw = parseP4JsonLines('');
// @ts-expect-error Raw fields remain unknown without a decoder.
const unsafeRaw: Array<{ revision: number }> = raw;
// @ts-expect-error A generic parameter alone is not runtime evidence of a row type.
parseP4JsonLines<{ revision: number }>('');
// @ts-expect-error The return type is the decoded type, not the encoded string.
const encoded: Array<{ revision: string }> = parseP4JsonLines('', Row);

const client = new P4Client();
const commandRows: Promise<Array<{ readonly revision: number }>> = client.runTaggedJson(
  ['files', '//depot/...'], { schema: Row }
);
const rawCommand: Promise<Record<string, unknown>[]> = client.runTaggedJson(['info']);
// @ts-expect-error Typed commands require a schema.
client.runTaggedJson<{ revision: number }>(['files']);
// @ts-expect-error Typed commands cannot infer a narrower type than the schema produces.
client.runTaggedJson<{ revision: string }>(['files'], { schema: Row });

const depot: P4DepotPath = Schema.decodeUnknownSync(P4DepotPathSchema)('//depot/file');
const workspace: P4ClientPath = Schema.decodeUnknownSync(P4ClientPathSchema)('//workspace/file');
const local: P4LocalPath = Schema.decodeUnknownSync(P4LocalPathSchema)('file.txt');
// @ts-expect-error Strings require runtime validation before becoming branded paths.
const unvalidated: P4DepotPath = '//depot/file';
// @ts-expect-error Client and depot paths have different semantic identities.
const mixed: P4DepotPath = workspace;
// @ts-expect-error A local path is not a Perforce client-syntax path.
const localAsClient: P4ClientPath = local;

void [decoded, workspaces, unsafeRaw, encoded, commandRows, rawCommand, depot, unvalidated, mixed, localAsClient];
