/** Translates the library operations into the existing MCP tool result shapes. */

import { AutofileError, type Autofile, type AutofileRecord, type JsonObject, type RecordQuery } from "./index.js";
import { uploadBlob, type UploadBlobInput, type UploadBlobOptions } from "./mcp-upload.js";
export type { UploadBlobInput } from "./mcp-upload.js";

/** One reason a tool request was refused. */
export interface StoreError { uri?: string; message: string }
/** The MCP refusal body, before protocol formatting. */
export interface Refusal { errors: StoreError[] }
/** Arguments to find_records. */
export type FindRecordsInput = RecordQuery;
/** Arguments to get_record. */
export interface GetRecordInput { uri: string }
/** Arguments to create_record. */
export interface CreateRecordInput { type: string; key?: string; record: JsonObject }
/** Arguments to update_record. */
export interface UpdateRecordInput { uri: string; patch: JsonObject }
/** Arguments to delete_record. */
export interface DeleteRecordInput { uri: string }
/** Arguments to get_type. */
export interface GetTypeInput { type: string }
/** Arguments to create_type. */
export interface CreateTypeInput {
  type: string;
  description: string;
  schema: JsonObject;
  titleField?: string;
}
/** Arguments to update_type. */
export interface UpdateTypeInput {
  type: string;
  description?: string;
  schema?: JsonObject;
  titleField?: string | null;
}
/** Arguments to delete_type. */
export interface DeleteTypeInput { type: string }
/** A successful MCP write names the changed resource. */
export interface UriResult { uri: string }
/** A page returned by find_records. */
export interface FindRecordsResult {
  records: RecordResult[];
  errors: StoreError[];
  cursor?: string;
}
/** The record envelope exposed by MCP tools. */
export interface RecordResult extends UriResult {
  title?: string;
  createdAt: string;
  updatedAt: string;
  value: JsonObject;
  error?: string;
}
/** A declaration summary returned by list_types. */
export interface TypeSummary extends UriResult { type: string; description: string }
/** The list_types result body. */
export interface ListTypesResult { types: TypeSummary[] }
/** A full declaration returned by get_type. */
export interface TypeResult extends UriResult {
  description: string;
  schema: JsonObject;
  titleField?: string;
}
/** A successful type update also reports records invalid under its schema. */
export interface UpdateTypeResult extends UriResult { errors: StoreError[] }
/** Plain tool handlers used by the protocol boundary. */
export interface Tools {
  findRecords(input: FindRecordsInput): Promise<FindRecordsResult | Refusal>;
  getRecord(input: GetRecordInput): Promise<RecordResult | Refusal>;
  createRecord(input: CreateRecordInput): Promise<UriResult | Refusal>;
  updateRecord(input: UpdateRecordInput): Promise<UriResult | Refusal>;
  uploadBlob(input: UploadBlobInput, options?: UploadBlobOptions): Promise<UriResult | Refusal>;
  deleteRecord(input: DeleteRecordInput): Promise<UriResult | Refusal>;
  listTypes(input: Record<string, never>): Promise<ListTypesResult>;
  getType(input: GetTypeInput): Promise<TypeResult | Refusal>;
  createType(input: CreateTypeInput): Promise<UriResult | Refusal>;
  updateType(input: UpdateTypeInput): Promise<UpdateTypeResult | Refusal>;
  deleteType(input: DeleteTypeInput): Promise<UriResult | Refusal>;
}

/** Builds tool handlers that use the class for every store operation. */
export function buildTools(autofile: Autofile): Tools {
  return {
    findRecords: (input) => withRefusal(async () => {
      const result = await autofile.records.find(input);
      return {
        records: result.records.map(recordResult),
        errors: result.unreadable,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      };
    }),
    getRecord: ({ uri }) => withRefusal(async () => {
      const record = await autofile.records.get(uri);
      if (record === undefined) {
        // The library returns undefined for either missing part of this address;
        // MCP has always named the missing declaration when the type is absent.
        const type = uri.slice("autofile:///".length).split("/")[0];
        if (await autofile.types.get(type) === undefined) {
          return { errors: [{ uri: `autofile:///_types/${type}`, message: "type does not exist" }] };
        }
        return { errors: [{ uri, message: "record does not exist" }] };
      }
      return recordResult(record);
    }),
    createRecord: ({ type, record, key }) => withRefusal(async () => {
      const created = await autofile.records.create(type, record, { key });
      return { uri: created.uri };
    }),
    updateRecord: ({ uri, patch }) => withRefusal(async () => {
      const updated = await autofile.records.update(uri, patch);
      return { uri: updated.uri };
    }),
    uploadBlob: (input, options = {}) => withRefusal(() => uploadBlob(autofile, input, options)),
    deleteRecord: ({ uri }) => withRefusal(async () => {
      await autofile.records.delete(uri);
      return { uri };
    }),
    async listTypes() {
      const declarations = await autofile.types.list();
      return { types: declarations.map(({ uri, type, description }) => ({ uri, type, description })) };
    },
    getType: ({ type }) => withRefusal(async () => {
      const declaration = await autofile.types.get(type);
      if (declaration === undefined) {
        return { errors: [{ uri: `autofile:///_types/${type}`, message: "type does not exist" }] };
      }
      const { type: _type, ...result } = declaration;
      return result;
    }),
    createType: ({ type, ...declaration }) => withRefusal(async () => {
      const created = await autofile.types.create(type, declaration);
      return { uri: created.uri };
    }),
    updateType: ({ type, ...changes }) => withRefusal(async () => {
      const updated = await autofile.types.update(type, changes);
      return { uri: updated.uri, errors: updated.problems ?? [] };
    }),
    deleteType: ({ type }) => withRefusal(async () => {
      await autofile.types.delete(type);
      return { uri: `autofile:///_types/${type}` };
    }),
  };
}

function recordResult(record: AutofileRecord): RecordResult {
  const { type: _type, key: _key, problems = [], ...result } = record;
  return {
    ...result,
    ...(problems.length === 0 ? {} : { error: problems.map(({ message }) => message).join("; ") }),
  };
}

async function withRefusal<T>(operation: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AutofileError) return { errors: error.problems };
    throw error;
  }
}
