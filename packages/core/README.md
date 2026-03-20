# p4-ts

Typed TypeScript helpers for the Perforce `p4` CLI.

- Run `p4` with a testable client abstraction
- Parse classic tagged output and newline-delimited JSON
- Query current Perforce environment with sensible fallbacks
- List and filter workspaces that are relevant to the local machine
- Preserve an Effect-based API that is easy to extract from `electroswag`

## Install

```bash
npm install p4-ts
```

## Quick Start

```ts
import { P4Client } from "p4-ts";

const p4 = new P4Client();

const environment = await p4.getEnvironment();
const workspaces = await p4.listWorkspaces();
const opened = await p4.run(["opened"]);
```

## Electroswag Extraction Path

If you want a near-direct move from the current `electroswag` code, the package also exports the same service-oriented entry points:

```ts
import { Effect } from "effect";
import { getP4Environment, listP4Workspaces } from "p4-ts";

const environment = await Effect.runPromise(getP4Environment(false));
const workspaces = await Effect.runPromise(listP4Workspaces(false));
```

## API

### `new P4Client(options?)`

Creates a reusable wrapper around the `p4` executable.

```ts
const p4 = new P4Client({
  executable: "p4",
  cwd: "C:/work/project",
});
```

### `run(args, options?)`

Run a raw `p4` command.

```ts
const result = await p4.run(["info"]);
console.log(result.stdout);
```

### `runTaggedJson(args, options?)`

Run a command with `-Mj -z tag` and parse newline-delimited JSON output.

```ts
const clients = await p4.runTaggedJson(["clients", "-u", "builduser"]);
```

### `getEnvironment(options?)`

Resolve common environment values from `p4 info` plus process env fallbacks.

```ts
const env = await p4.getEnvironment();
// { hostName, p4Port, p4User, p4Client }
```

### `listWorkspaces(options?)`

List user workspaces and, by default, keep only workspaces that appear local to the current machine.

```ts
const workspaces = await p4.listWorkspaces();
```

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```
