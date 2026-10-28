/** The embedding interface. Importing it starts no server or watcher. */

export { Autofile, AutofileError } from "./store.js";
export type {
  AutofileProblem,
  AutofileRecord,
  BlobRange,
  BlobStat,
  ChangeEvent,
  RecordQuery,
  RecordQueryResult,
  TypeChanges,
  TypeDeclaration,
  TypeDefinition,
  WatchOptions,
} from "./store.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export type { FormatField, PreparedSchema } from "./schema.js";
