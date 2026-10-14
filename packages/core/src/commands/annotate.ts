import { Effect } from 'effect';
import { streamCommand } from '../engine/command.js';
import { drain, operation, progressCounter } from '../engine/operation.js';
import { depotPath, integer, malformed, optionalAction, optionalDepotPath, text } from './shared.js';
import type { P4DepotPath, P4FileAction } from '../schemas.js';
import type { P4Message } from '../wire/message.js';
import type { Row } from './shared.js';

/** Options for {@link annotateFile}. */
export interface AnnotateFileOptions {
  /** Depot, client or local file spec. */
  readonly file: string;
  /**
   * Revision to annotate: a number for `#n`, or a specifier starting with `#`
   * or `@` such as `@1234`. Defaults to the head revision.
   */
  readonly revision?: string | number | undefined;
  /** Attribute lines that came from an integration to their source (`annotate -I`). Defaults to `false`. */
  readonly followIntegrations?: boolean | undefined;
}

/** One line of an annotated file. */
export interface P4AnnotatedLine {
  /** Line number, from 1. */
  readonly line: number;
  /** Changelist that last changed the line. */
  readonly change: number;
  /** The line's text, without its line break. */
  readonly text: string;
  /**
   * With `followIntegrations`, the file the line was last changed in, which
   * can be an integration source. Otherwise `null`.
   */
  readonly depotFile: P4DepotPath | null;
}

/** A file annotated line by line with the changelist that last changed each line. */
export interface P4Annotation {
  /** The annotated file, or `null` when nothing matched. */
  readonly depotFile: P4DepotPath | null;
  /** The annotated revision. */
  readonly revision: number | null;
  /** The changelist that submitted that revision. */
  readonly change: number | null;
  readonly action: P4FileAction | null;
  readonly type: string | null;
  readonly lines: P4AnnotatedLine[];
  readonly messages: P4Message[];
}

interface Header {
  readonly _tag: 'header';
  readonly depotFile: P4DepotPath;
  readonly revision: number | null;
  readonly change: number | null;
  readonly action: P4FileAction | null;
  readonly type: string | null;
}

interface Line {
  readonly _tag: 'line';
  readonly change: number;
  readonly text: string;
  readonly depotFile: P4DepotPath | null;
}

function toAnnotationRecord(row: Row): Header | Line {
  if (row.lower !== undefined) {
    // `lower` is the change that introduced the line's current text; `upper` is the last it was present in.
    const change = integer(row.lower, row);
    if (change === null || typeof row.data !== 'string') throw malformed('Expected an annotated line.', row);
    return {
      _tag: 'line',
      change,
      text: row.data.replace(/\r?\n$/, ''),
      depotFile: optionalDepotPath(row.depotFile0, row),
    };
  }
  return {
    _tag: 'header',
    depotFile: depotPath(row.depotFile, row),
    revision: integer(row.rev, row),
    change: integer(row.change, row),
    action: optionalAction(row.action, row),
    type: text(row.type),
  };
}

function revisionSpec(file: string, revision: string | number | undefined): string {
  if (revision === undefined) return file;
  const value = String(revision);
  return value.startsWith('#') || value.startsWith('@') ? `${file}${value}` : `${file}#${value}`;
}

/**
 * Annotate a text file: each line with the changelist that last changed it
 * (`p4 annotate -q -c`). Join `change` with `getFileHistory` or
 * `describeChangelist` for authors and descriptions. A file that does not
 * exist gives no lines and an `empty` message.
 *
 * @returns The annotated file.
 */
export const annotateFile = operation<AnnotateFileOptions, P4AnnotatedLine, P4Annotation>('annotateFile', (options, sink) =>
  Effect.gen(function* () {
    const args = ['annotate', '-q', '-c'];
    if (options.followIntegrations) args.push('-I');
    args.push(revisionSpec(options.file, options.revision));
    const lines: P4AnnotatedLine[] = [];
    const output = yield* drain(sink, streamCommand({ args, format: 'json', decode: toAnnotationRecord }), {
      item: (record) => {
        if (record._tag === 'header') return null;
        const line = { line: lines.length + 1, change: record.change, text: record.text, depotFile: record.depotFile };
        lines.push(line);
        return line;
      },
      counter: progressCounter(sink, 'records'),
    });
    const header = output.items.find((record): record is Header => record._tag === 'header');
    return {
      depotFile: header?.depotFile ?? null,
      revision: header?.revision ?? null,
      change: header?.change ?? null,
      action: header?.action ?? null,
      type: header?.type ?? null,
      lines,
      messages: output.messages,
    };
  }));
