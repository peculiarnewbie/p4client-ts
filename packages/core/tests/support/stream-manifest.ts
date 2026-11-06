import { Schema } from 'effect';

/** `test-stream`'s `stream-manifest.json`: the fixture stream, its workspace and its seed files. */
export const StreamManifestSchema = Schema.Struct({
  stream: Schema.Struct({ name: Schema.String }),
  workspace: Schema.Struct({ rootFolderName: Schema.NonEmptyString }),
  seedRoot: Schema.NonEmptyString,
});

/** A decoded stream manifest. */
export type StreamManifest = typeof StreamManifestSchema.Type;

/** Decode `stream-manifest.json`'s text; throws when it is not a manifest. */
export const decodeStreamManifest = Schema.decodeUnknownSync(Schema.fromJsonString(StreamManifestSchema));
