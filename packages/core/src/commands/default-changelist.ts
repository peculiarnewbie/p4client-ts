import { Effect } from 'effect';
import { runCommand } from '../engine/command.js';
import { openedCommand } from './opened.js';
import type { P4ChangelistDescription } from './describe.js';
import type { P4OpenedFile } from './opened.js';
import type { FileSpecs } from './shared.js';

/** Which default changelist to read. */
export interface DefaultChangelistOptions {
  /** Files opened by this user. */
  readonly user?: string | undefined;
  /** The workspace whose default changelist to read. Defaults to the connection's workspace. */
  readonly client?: string | undefined;
  /** Only files matching these specs. */
  readonly fileSpec?: FileSpecs | undefined;
}

/** The default changelist and the opened files it was built from. */
export interface P4DefaultChangelist {
  readonly description: P4ChangelistDescription;
  /** Files open in the default changelist, as `opened` lists them. */
  readonly opened: P4OpenedFile[];
}

/**
 * Read the default changelist from one `p4 opened -c default`, since
 * `describe` cannot show it. Its owner and description come from the first
 * opened file, and its status is always pending.
 *
 * @param options Which default changelist.
 * @returns The changelist and its opened files.
 */
export function readDefaultChangelist(options: DefaultChangelistOptions) {
  return Effect.map(
    runCommand(openedCommand({ change: 'default', user: options.user, client: options.client, fileSpec: options.fileSpec })),
    (output): P4DefaultChangelist => {
      const first = output.items[0];
      return {
        description: {
          change: 'default',
          status: 'pending',
          user: options.user ?? first?.user ?? null,
          client: options.client ?? first?.client ?? null,
          description: first?.changeDescription ?? 'Default changelist',
          createdAt: null,
          files: output.items.flatMap((file) => file.depotFile === null ? [] : [{
            depotFile: file.depotFile,
            action: file.action,
            type: file.type,
            revision: file.revision,
            digest: null,
            fileSize: null,
          }]),
          messages: output.messages,
        },
        opened: output.items,
      };
    },
  );
}
