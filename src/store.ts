/**
 * Reads and writes Autofile's on-disk types and records, and exposes recognized
 * records, declarations, and blobs as plain resource data. Each operation reads
 * current files and keeps protocol-specific behavior outside the store.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { lookup as lookupMimeType } from "mime-types";
import { Query } from "mingo";
import lockfile from "proper-lockfile";

import {
  BLOB_NAME_PATTERN,
  BLOB_URI_PATTERN,
  MAX_BLOB_BYTES,
  blobNameFromUri,
  blobUri,
  deleteBlobUris,
  prepareBlob,
  writePreparedBlobs,
  type PreparedBlob,
} from "./blobs.js";
import { getStorage, getWriteLockPath } from "./config.js";
import type { JsonObject, JsonValue } from "./json.js";
import { prepareSchema, SchemaRefusal, type PreparedSchema } from "./schema.js";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const keyPattern = /^[a-z0-9][a-z0-9-]*$/u;
const recordUriPattern = /^autofile:\/\/\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/u;
const typeUriPattern = /^autofile:\/\/\/_types\/([a-z][a-z0-9-]*)$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_FIND_RECORDS_PAGE_BYTES = 64 * 1024;
const tidAlphabet = "234567abcdefghijklmnopqrstuvwxyz";
const invalidTypeMessage = "type: must use lowercase letters, digits, and hyphens and start with a letter";
const invalidKeyMessage = "key: must use lowercase letters, digits, and hyphens and start with a letter or digit";
const invalidRecordUriMessage = "uri: must be a record URI, such as autofile:///task/book-the-dentist";
const clockIdentifier = BigInt(randomBytes(2).readUInt16BE() & 0x3ff);
let lastTidTimestamp = 0n;

export interface StoreError {
  uri?: string;
  message: string;
}

export interface Refusal {
  errors: StoreError[];
}

export interface OpenStoreOptions {
  dataFolder?: string;
  writeLockPath?: string;
}

/** Transport-sensitive permissions for a record write. */
export interface RecordWriteOptions {
  allowLocalPaths?: boolean;
}

export interface Store {
  findRecords(input: FindRecordsInput): Promise<FindRecordsResult | Refusal>;
  getRecord(input: GetRecordInput): Promise<RecordResult | Refusal>;
  createRecord(input: CreateRecordInput, options?: RecordWriteOptions): Promise<UriResult | Refusal>;
  updateRecord(input: UpdateRecordInput, options?: RecordWriteOptions): Promise<UriResult | Refusal>;
  deleteRecord(input: DeleteRecordInput): Promise<UriResult | Refusal>;
  listTypes(input: Record<string, never>): Promise<ListTypesResult>;
  getType(input: GetTypeInput): Promise<TypeResult | Refusal>;
  createType(input: CreateTypeInput): Promise<UriResult | Refusal>;
  updateType(input: UpdateTypeInput): Promise<UpdateTypeResult | Refusal>;
  deleteType(input: DeleteTypeInput): Promise<UriResult | Refusal>;
  listResources(): Promise<StoreResource[]>;
  getResourceMetadata(uri: string): Promise<StoreResource | undefined>;
  listResourceFolder(folder: string): Promise<StoreResource[]>;
  listTypeResources(type: string): Promise<StoreResource[]>;
  readResource(uri: string): Promise<StoreResourceContents | undefined>;
}

export interface FindRecordsInput {
  type: string;
  q?: string;
  where?: JsonObject;
  limit?: number;
  fields?: string[];
  cursor?: string;
}
export interface GetRecordInput { uri: string }
export interface CreateRecordInput { type: string; key?: string; record: JsonObject }
export interface UpdateRecordInput { uri: string; patch: JsonObject }
export interface DeleteRecordInput { uri: string }
export interface GetTypeInput { type: string }
export interface CreateTypeInput {
  type: string;
  description: string;
  schema: JsonObject;
  titleField?: string;
  title?: string;
}
export interface UpdateTypeInput {
  type: string;
  description?: string;
  schema?: JsonObject;
  titleField?: string | null;
  title?: string | null;
}
export interface DeleteTypeInput { type: string }

export interface UriResult { uri: string }
export interface FindRecordsResult {
  records: RecordResult[];
  errors: StoreError[];
  cursor?: string;
}
export interface RecordResult extends UriResult {
  createdAt: string;
  updatedAt: string;
  value: JsonObject;
  error?: string;
}
export interface TypeSummary extends UriResult {
  type: string;
  description: string;
  title?: string;
}
export interface ListTypesResult { types: TypeSummary[] }
export interface TypeResult extends UriResult {
  description: string;
  schema: JsonObject;
  titleField?: string;
  title?: string;
}
export interface UpdateTypeResult extends UriResult { errors: StoreError[] }

/** Plain metadata for one resource recognized in the data folder. */
export interface StoreResource extends UriResult {
  name: string;
  mimeType: string;
  title?: string;
  description?: string;
  size?: number;
  lastModified?: string;
}

/** Exact contents of a recognized text or binary resource. */
export type StoreResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

interface TypeDeclaration {
  description: string;
  schema: JsonObject;
  titleField?: string;
  title?: string;
}

interface StoredRecord {
  createdAt: string;
  updatedAt: string;
  value: JsonObject;
}

type ReadResult<T> =
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "invalid"; message: string };

type TextReadResult<T> =
  | { status: "found"; value: T; text: string }
  | { status: "missing" }
  | { status: "invalid"; message: string };

/** Opens a store, creating its data folder when it does not exist. */
export async function openStore(options: OpenStoreOptions = {}): Promise<Store> {
  const dataFolder = resolve(options.dataFolder ?? await getStorage());
  const writeLockPath = resolve(options.writeLockPath ?? getWriteLockPath());
  await Promise.all([
    mkdir(dataFolder, { recursive: true }),
    mkdir(dirname(writeLockPath), { recursive: true }),
  ]);
  return createStore(dataFolder, writeLockPath);
}

function createStore(dataFolder: string, writeLockPath: string): Store {
  const typeFolder = join(dataFolder, "_types");
  const blobFolder = join(dataFolder, "_blobs");

  async function withWriteLock<T>(write: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    let retryDelay = 50;
    while (true) {
      try {
        release = await lockfile.lock(dirname(writeLockPath), {
          lockfilePath: writeLockPath,
          stale: 10_000,
          update: 5_000,
          retries: 0,
        });
        break;
      } catch (error) {
        if (!hasCode(error, "ELOCKED")) throw error;
        await delay(retryDelay);
        retryDelay = Math.min(Math.ceil(retryDelay * 1.2), 1_000);
      }
    }
    try {
      return await write();
    } finally {
      await release();
    }
  }

  async function findRecords(
    input: FindRecordsInput,
  ): Promise<FindRecordsResult | Refusal> {
    if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
    if (input.q !== undefined && typeof input.q !== "string") {
      return refuse("q: must be a string");
    }
    if (input.where !== undefined && !isJsonObject(input.where)) {
      return refuse("where: must be a JSON object");
    }
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return refuse("limit: must be an integer from 1 to 200");
    }
    if (
      input.fields !== undefined
      && (!Array.isArray(input.fields) || input.fields.some((field) => (
        typeof field !== "string" || field.length === 0
      )))
    ) {
      return refuse("fields: must be an array of non-empty strings");
    }
    if (input.cursor !== undefined && typeof input.cursor !== "string") {
      return refuse("cursor: must be a string");
    }
    const whereRefusal = input.where === undefined
      ? undefined
      : findWhereRefusal(input.where);
    if (whereRefusal !== undefined) return refuse(whereRefusal);

    const afterUri = input.cursor === undefined
      ? undefined
      : decodeRecordCursor(input.cursor, input.type);
    if (input.cursor !== undefined && afterUri === undefined) {
      return refuse("cursor: is invalid");
    }

    const declaration = await readDeclaration(typeFolder, input.type);
    if (declaration.status !== "found") return declarationRefusal(input.type, declaration);
    const schema = await preparedDeclarationSchema(declaration.value, typeUri(input.type));
    if ("errors" in schema) return schema;

    const entries = (await recognizedRecordEntries(join(dataFolder, input.type)))
      .map((entry) => ({
        entry,
        uri: recordUri(input.type, entry.name.slice(0, -".json".length)),
      }))
      .sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
    const start = afterUri === undefined
      ? 0
      : entries.findIndex(({ uri }) => uri > afterUri);
    const firstPageIndex = start < 0 ? entries.length : start;
    const words = input.q?.trim().toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
    const query = new Query<JsonObject>(input.where ?? {}, { scriptEnabled: false });
    const fields = input.fields === undefined ? undefined : new Set(input.fields);
    const records: RecordResult[] = [];
    const errors: StoreError[] = [];
    let nextIndex = firstPageIndex;
    let lastReadUri: string | undefined;

    while (nextIndex < entries.length && records.length + errors.length < limit) {
      const current = entries[nextIndex];
      if (current === undefined) break;
      nextIndex += 1;
      const { entry, uri } = current;
      let stored: ReadResult<StoredRecord> | undefined;
      let record: RecordResult | undefined;
      let resultError: StoreError | undefined;
      try {
        stored = await readStoredRecord(join(dataFolder, input.type, entry.name));
      } catch (error) {
        resultError = { uri, message: recordFileReadError(error) };
      }
      if (stored !== undefined) {
        if (stored.status !== "found") {
          resultError = {
            uri,
            message: stored.status === "invalid" ? stored.message : "record does not exist",
          };
        } else if (
          stringValuesContainWords(stored.value.value, words)
          && query.test(stored.value.value)
        ) {
          const validationErrors = await schema.validate(stored.value.value);
          if (validationErrors.length > 0) {
            resultError = { uri, message: validationErrors.join("; ") };
          } else {
            record = {
              uri,
              createdAt: stored.value.createdAt,
              updatedAt: stored.value.updatedAt,
              value: fields === undefined
                ? stored.value.value
                : Object.fromEntries(
                  Object.entries(stored.value.value).filter(([field]) => fields.has(field)),
                ),
            };
          }
        }
      }

      if (record === undefined && resultError === undefined) {
        lastReadUri = uri;
        continue;
      }
      const nextRecords = record === undefined ? records : [...records, record];
      const nextErrors = resultError === undefined ? errors : [...errors, resultError];
      const nextPageBytes = Buffer.byteLength(JSON.stringify({
        records: nextRecords,
        errors: nextErrors,
      }), "utf8");
      if (records.length + errors.length > 0 && nextPageBytes > MAX_FIND_RECORDS_PAGE_BYTES) {
        // Reading the candidate is necessary to know its serialized size, but it belongs to the
        // next page. Leave its index unconsumed so the cursor resumes before it instead of dropping
        // it; only a page's first result may exceed the cap.
        nextIndex -= 1;
        break;
      }
      if (record !== undefined) records.push(record);
      if (resultError !== undefined) errors.push(resultError);
      lastReadUri = uri;
      if (nextPageBytes >= MAX_FIND_RECORDS_PAGE_BYTES) break;
    }

    return {
      records,
      errors,
      ...(lastReadUri !== undefined && nextIndex < entries.length
        ? { cursor: encodeRecordCursor(lastReadUri) }
        : {}),
    };
  }

  async function getRecord(input: GetRecordInput): Promise<RecordResult | Refusal> {
    const parsed = parseRecordUri(input.uri);
    if (parsed === undefined) return refuse(invalidRecordUriMessage);
    const declaration = await readDeclaration(typeFolder, parsed.type);
    if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
    const stored = await readStoredRecord(recordPath(dataFolder, parsed.type, parsed.key));
    if (stored.status !== "found") return recordReadRefusal(input.uri, stored);

    const schema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type));
    if ("errors" in schema) return schema;
    const validationErrors = await schema.validate(stored.value.value);
    const result: RecordResult = {
      uri: input.uri,
      createdAt: stored.value.createdAt,
      updatedAt: stored.value.updatedAt,
      value: stored.value.value,
    };
    if (validationErrors.length > 0) result.error = validationErrors.join("; ");
    return result;
  }

  async function createRecord(
    input: CreateRecordInput,
    options: RecordWriteOptions = {},
  ): Promise<UriResult | Refusal> {
    return withWriteLock(async () => {
      if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
      if (input.key !== undefined && !keyPattern.test(input.key)) {
        return refuse(invalidKeyMessage);
      }
      if (!isJsonObject(input.record)) return refuse("record: must be a JSON object");

      const declaration = await readDeclaration(typeFolder, input.type);
      if (declaration.status !== "found") return declarationRefusal(input.type, declaration);
      const schema = await preparedDeclarationSchema(declaration.value, typeUri(input.type));
      if ("errors" in schema) return schema;
      const validationErrors = await schema.validate(input.record);
      if (validationErrors.length > 0) {
        const uri = input.key === undefined ? undefined : recordUri(input.type, input.key);
        return { errors: validationErrors.map((message) => ({ ...(uri === undefined ? {} : { uri }), message })) };
      }

      const sourceUri = input.key === undefined ? undefined : recordUri(input.type, input.key);
      const linkErrors = await missingLinkErrors(
        dataFolder,
        typeFolder,
        schema,
        input.record,
        sourceUri,
      );
      if (linkErrors.length > 0) return { errors: linkErrors };

      await mkdir(join(dataFolder, input.type), { recursive: true });
      let key = input.key;
      if (key === undefined) {
        do key = nextTid();
        while (await pathExists(recordPath(dataFolder, input.type, key)));
      } else if (await pathExists(recordPath(dataFolder, input.type, key))) {
        return refuse("a record with that key already exists", recordUri(input.type, key));
      }

      const uri = recordUri(input.type, key);
      const materialized = await prepareRecordBlobs(
        blobFolder,
        schema,
        input.record,
        options.allowLocalPaths ?? true,
        uri,
      );
      if ("errors" in materialized) return materialized;
      const materializedLinkErrors = await missingLinkErrors(
        dataFolder,
        typeFolder,
        schema,
        materialized.value,
        uri,
      );
      if (materializedLinkErrors.length > 0) return { errors: materializedLinkErrors };

      const now = new Date().toISOString();
      await writePreparedBlobs(blobFolder, materialized.blobs);
      await writeJsonAtomically(recordPath(dataFolder, input.type, key), {
        createdAt: now,
        updatedAt: now,
        value: materialized.value,
      });
      return { uri };
    });
  }

  async function updateRecord(
    input: UpdateRecordInput,
    options: RecordWriteOptions = {},
  ): Promise<UriResult | Refusal> {
    return withWriteLock(async () => {
      const parsed = parseRecordUri(input.uri);
      if (parsed === undefined) return refuse(invalidRecordUriMessage);
      if (!isJsonObject(input.patch)) return refuse("patch: must be a JSON object", input.uri);
      const declaration = await readDeclaration(typeFolder, parsed.type);
      if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
      const path = recordPath(dataFolder, parsed.type, parsed.key);
      const stored = await readStoredRecord(path);
      if (stored.status !== "found") return recordReadRefusal(input.uri, stored);

      const value = mergePatch(stored.value.value, input.patch);
      const schema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type));
      if ("errors" in schema) return schema;
      const validationErrors = await schema.validate(value);
      if (validationErrors.length > 0) {
        return { errors: validationErrors.map((message) => ({ uri: input.uri, message })) };
      }

      const linkErrors = await missingLinkErrors(
        dataFolder,
        typeFolder,
        schema,
        value,
        input.uri,
      );
      if (linkErrors.length > 0) return { errors: linkErrors };

      const materialized = await prepareRecordBlobs(
        blobFolder,
        schema,
        value,
        options.allowLocalPaths ?? true,
        input.uri,
      );
      if ("errors" in materialized) return materialized;
      const materializedLinkErrors = await missingLinkErrors(
        dataFolder,
        typeFolder,
        schema,
        materialized.value,
        input.uri,
      );
      if (materializedLinkErrors.length > 0) return { errors: materializedLinkErrors };
      const previousBlobs = await blobsHeldByRecord(stored.value.value, schema);

      await writePreparedBlobs(blobFolder, materialized.blobs);
      await writeJsonAtomically(path, {
        createdAt: stored.value.createdAt,
        updatedAt: new Date().toISOString(),
        value: materialized.value,
      });
      await deleteUnheldBlobs(dataFolder, typeFolder, previousBlobs);
      return { uri: input.uri };
    });
  }

  async function deleteRecord(input: DeleteRecordInput): Promise<UriResult | Refusal> {
    return withWriteLock(async () => {
      const parsed = parseRecordUri(input.uri);
      if (parsed === undefined) return refuse(invalidRecordUriMessage);
      const declaration = await readDeclaration(typeFolder, parsed.type);
      if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
      const path = recordPath(dataFolder, parsed.type, parsed.key);
      if (!await isRegularFile(path)) return refuse("record does not exist", input.uri);

      const changes: Array<{ path: string; record: StoredRecord }> = [];
      const errors: StoreError[] = [];
      let deletedRecord: StoredRecord | undefined;
      try {
        const target = await readStoredRecord(path);
        if (target.status === "missing") {
          errors.push({ uri: input.uri, message: "record does not exist" });
        } else if (target.status === "invalid") {
          errors.push({ uri: input.uri, message: target.message });
        } else {
          deletedRecord = target.value;
        }
      } catch (error) {
        errors.push({ uri: input.uri, message: recordFileReadError(error) });
      }
      const typeEntries = (await readDirectory(typeFolder))
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && typeNamePattern.test(entry.name.slice(0, -".json".length))
        ))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const typeEntry of typeEntries) {
        const type = typeEntry.name.slice(0, -".json".length);
        const otherDeclaration = await readValidDeclaration(typeFolder, type);
        if (otherDeclaration === undefined) continue;
        const schema = await preparedDeclarationSchema(otherDeclaration, typeUri(type));
        if ("errors" in schema) continue;
        for (const entry of await recognizedRecordEntries(join(dataFolder, type))) {
          const key = entry.name.slice(0, -".json".length);
          const uri = recordUri(type, key);
          if (uri === input.uri) continue;
          let stored: ReadResult<StoredRecord>;
          try {
            stored = await readStoredRecord(join(dataFolder, type, entry.name));
          } catch (error) {
            errors.push({ uri, message: recordFileReadError(error) });
            continue;
          }
          if (stored.status !== "found") {
            errors.push({
              uri,
              message: stored.status === "invalid" ? stored.message : "record does not exist",
            });
            continue;
          }

          const validationErrors = await schema.validate(stored.value.value);
          if (validationErrors.length > 0) {
            if (containsStringValue(stored.value.value, input.uri)) {
              errors.push({
                uri,
                message: `record does not match its type and holds ${input.uri} as a string value`,
              });
            }
            continue;
          }

          const pointers = schema.formatFields(stored.value.value, "uri")
            .filter((field) => field.value === input.uri)
            .map(({ pointer }) => pointer);
          if (pointers.length === 0) continue;
          const value = removeFields(stored.value.value, pointers);
          const remainingErrors = await schema.validate(value);
          if (remainingErrors.length > 0) {
            errors.push({ uri, message: remainingErrors.join("; ") });
            continue;
          }
          changes.push({
            path: join(dataFolder, type, entry.name),
            record: {
              createdAt: stored.value.createdAt,
              updatedAt: timestampAfter(stored.value.updatedAt),
              value,
            },
          });
        }
      }
      if (errors.length > 0) {
        errors.sort((left, right) => {
          const uriOrder = (left.uri ?? "").localeCompare(right.uri ?? "");
          return uriOrder === 0 ? left.message.localeCompare(right.message) : uriOrder;
        });
        return { errors };
      }

      const targetSchema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type));
      const previousBlobs = deletedRecord === undefined
        ? new Set<string>()
        : "errors" in targetSchema
          ? blobUrisIn(deletedRecord.value)
          : await blobsHeldByRecord(deletedRecord.value, targetSchema);
      for (const change of changes) await writeJsonAtomically(change.path, change.record);
      await unlink(path);
      await deleteUnheldBlobs(dataFolder, typeFolder, previousBlobs);
      return { uri: input.uri };
    });
  }

  async function listTypes(_input: Record<string, never>): Promise<ListTypesResult> {
    const entries = await readDirectory(typeFolder);
    const types: TypeSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const type = entry.name.slice(0, -".json".length);
      if (!typeNamePattern.test(type)) continue;
      const declaration = await readValidDeclaration(typeFolder, type);
      if (declaration === undefined) continue;
      types.push({
        uri: typeUri(type),
        type,
        description: declaration.description,
        ...(declaration.title === undefined ? {} : { title: declaration.title }),
      });
    }
    types.sort((left, right) => left.type.localeCompare(right.type));
    return { types };
  }

  async function getType(input: GetTypeInput): Promise<TypeResult | Refusal> {
    if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
    const declaration = await readDeclaration(typeFolder, input.type);
    if (declaration.status !== "found") return declarationRefusal(input.type, declaration);
    const schema = await preparedDeclarationSchema(declaration.value, typeUri(input.type));
    if ("errors" in schema) return schema;
    return {
      uri: typeUri(input.type),
      description: declaration.value.description,
      ...(declaration.value.title === undefined ? {} : { title: declaration.value.title }),
      ...(declaration.value.titleField === undefined
        ? {}
        : { titleField: declaration.value.titleField }),
      schema: declaration.value.schema,
    };
  }

  async function createType(input: CreateTypeInput): Promise<UriResult | Refusal> {
    return withWriteLock(async () => {
      if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
      if (typeof input.description !== "string") return refuse("description: must be a string");
      if (input.titleField !== undefined && typeof input.titleField !== "string") {
        return refuse("titleField: must be a string");
      }
      if (input.title !== undefined && (typeof input.title !== "string" || input.title.length === 0)) {
        return refuse("title: must be a non-empty string");
      }
      if (!isJsonObject(input.schema)) return refuse("schema: must be a JSON object");
      const declarationPath = join(typeFolder, `${input.type}.json`);
      if (await pathExists(declarationPath)) {
        return refuse("type already exists", typeUri(input.type));
      }
      const schema = await prepareDeclarationSchema(input.schema, typeUri(input.type));
      if ("errors" in schema) return schema;

      await Promise.all([
        mkdir(typeFolder, { recursive: true }),
        mkdir(join(dataFolder, input.type), { recursive: true }),
      ]);
      await writeJsonAtomically(declarationPath, {
        description: input.description,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.titleField === undefined ? {} : { titleField: input.titleField }),
        schema: input.schema,
      });
      return { uri: typeUri(input.type) };
    });
  }

  async function updateType(input: UpdateTypeInput): Promise<UpdateTypeResult | Refusal> {
    return withWriteLock(async () => {
      if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
      const current = await readDeclaration(typeFolder, input.type);
      if (current.status !== "found") return declarationRefusal(input.type, current);
      if (input.description !== undefined && typeof input.description !== "string") {
        return refuse("description: must be a string");
      }
      if (
        input.titleField !== undefined
        && input.titleField !== null
        && typeof input.titleField !== "string"
      ) {
        return refuse("titleField: must be a string or null");
      }
      if (
        input.title !== undefined
        && input.title !== null
        && (typeof input.title !== "string" || input.title.length === 0)
      ) {
        return refuse("title: must be a non-empty string or null");
      }
      if (input.schema !== undefined && !isJsonObject(input.schema)) {
        return refuse("schema: must be a JSON object");
      }

      const titleField = input.titleField === null
        ? undefined
        : input.titleField ?? current.value.titleField;
      const title = input.title === null ? undefined : input.title ?? current.value.title;
      const declaration: TypeDeclaration = {
        description: input.description ?? current.value.description,
        ...(title === undefined ? {} : { title }),
        ...(titleField === undefined ? {} : { titleField }),
        schema: input.schema ?? current.value.schema,
      };
      const schema = await prepareDeclarationSchema(declaration.schema, typeUri(input.type));
      if ("errors" in schema) return schema;

      await writeJsonAtomically(join(typeFolder, `${input.type}.json`), declaration);
      const errors = await invalidRecords(dataFolder, input.type, schema);
      return { uri: typeUri(input.type), errors };
    });
  }

  async function deleteType(input: DeleteTypeInput): Promise<UriResult | Refusal> {
    return withWriteLock(async () => {
      if (!typeNamePattern.test(input.type)) return refuse(invalidTypeMessage);
      const declaration = await readDeclaration(typeFolder, input.type);
      if (declaration.status !== "found") return declarationRefusal(input.type, declaration);
      try {
        await rmdir(join(dataFolder, input.type));
      } catch (error) {
        if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) {
          return refuse("type folder is not empty", typeUri(input.type));
        }
        if (!hasCode(error, "ENOENT")) throw error;
      }
      await unlink(join(typeFolder, `${input.type}.json`));
      return { uri: typeUri(input.type) };
    });
  }

  async function listResources(): Promise<StoreResource[]> {
    const declarationEntries = await readDirectory(typeFolder);
    const resources: StoreResource[] = [];
    for (const entry of declarationEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      resources.push(...await listTypeResources(entry.name.slice(0, -".json".length)));
    }
    resources.push(...await listResourceFolder("_blobs"));

    resources.sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
    return resources;
  }

  async function getResourceMetadata(uri: string): Promise<StoreResource | undefined> {
    const typeMatch = typeUriPattern.exec(uri);
    const type = typeMatch?.[1];
    if (type !== undefined) {
      const declaration = await readValidDeclaration(typeFolder, type);
      return declaration === undefined ? undefined : declarationResource(type, declaration);
    }

    const blobName = BLOB_URI_PATTERN.exec(uri)?.[1];
    if (blobName !== undefined) {
      const size = await regularFileSize(join(blobFolder, blobName), MAX_BLOB_BYTES);
      return size === undefined ? undefined : {
        uri,
        name: `_blobs/${blobName}`,
        mimeType: mimeTypeForBlob(blobName),
        size,
      };
    }

    const record = parseRecordUri(uri);
    if (record === undefined) return undefined;
    const [declaration, stored] = await Promise.all([
      readValidDeclaration(typeFolder, record.type),
      readStoredRecord(recordPath(dataFolder, record.type, record.key)),
    ]);
    if (declaration === undefined || stored.status !== "found") return undefined;
    return recordResource(record.type, record.key, declaration, stored.value);
  }

  async function listTypeResources(type: string): Promise<StoreResource[]> {
    if (!typeNamePattern.test(type)) return [];
    const declaration = await readValidDeclaration(typeFolder, type);
    if (declaration === undefined) return [];
    const resources = [declarationResource(type, declaration)];
    const recordEntries = await recognizedRecordEntries(join(dataFolder, type));
    for (const entry of recordEntries) {
      const key = entry.name.slice(0, -".json".length);
      const stored = await readStoredRecord(join(dataFolder, type, entry.name));
      if (stored.status !== "found") continue;
      resources.push(recordResource(type, key, declaration, stored.value));
    }
    return resources;
  }

  async function listResourceFolder(folder: string): Promise<StoreResource[]> {
    if (folder === "_types") {
      const declarationEntries = await readDirectory(typeFolder);
      const resources: StoreResource[] = [];
      for (const entry of declarationEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const type = entry.name.slice(0, -".json".length);
        const resource = await getResourceMetadata(typeUri(type));
        if (resource !== undefined) resources.push(resource);
      }
      return resources;
    }
    if (folder === "_blobs") {
      const resources: StoreResource[] = [];
      for (const entry of await readDirectory(blobFolder)) {
        if (!entry.isFile() || !BLOB_NAME_PATTERN.test(entry.name)) continue;
        const resource = await getResourceMetadata(blobUri(entry.name));
        if (resource !== undefined) resources.push(resource);
      }
      return resources;
    }
    if (!typeNamePattern.test(folder)) return [];
    const recordPrefix = `autofile:///${folder}/`;
    return (await listTypeResources(folder)).filter(({ uri }) => uri.startsWith(recordPrefix));
  }

  async function readResource(uri: string): Promise<StoreResourceContents | undefined> {
    const typeMatch = typeUriPattern.exec(uri);
    const type = typeMatch?.[1];
    if (type !== undefined) {
      const declaration = await readValidDeclarationText(typeFolder, type);
      if (declaration === undefined) return undefined;
      return { uri, mimeType: "application/json", text: declaration.text };
    }

    const blobMatch = BLOB_URI_PATTERN.exec(uri);
    const blobName = blobMatch?.[1];
    if (blobName !== undefined) {
      if (!await isDirectory(blobFolder)) return undefined;
      const bytes = await readRegularFile(join(blobFolder, blobName), MAX_BLOB_BYTES);
      if (bytes === undefined) return undefined;
      return { uri, mimeType: mimeTypeForBlob(blobName), blob: bytes.toString("base64") };
    }

    const record = parseRecordUri(uri);
    if (record === undefined) return undefined;
    if (await readValidDeclaration(typeFolder, record.type) === undefined) return undefined;
    const stored = await readStoredRecordText(recordPath(dataFolder, record.type, record.key));
    if (stored.status !== "found") return undefined;
    return { uri, mimeType: "application/json", text: stored.text };
  }

  return {
    findRecords,
    getRecord,
    createRecord,
    updateRecord,
    deleteRecord,
    listTypes,
    getType,
    createType,
    updateType,
    deleteType,
    listResources,
    getResourceMetadata,
    listResourceFolder,
    listTypeResources,
    readResource,
  };
}

function declarationResource(type: string, declaration: TypeDeclaration): StoreResource {
  return {
    uri: typeUri(type),
    name: `_types/${type}`,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    mimeType: "application/json",
    description: declaration.description,
  };
}

function recordResource(
  type: string,
  key: string,
  declaration: TypeDeclaration,
  stored: StoredRecord,
): StoreResource {
  const title = declaration.titleField === undefined
    ? undefined
    : stored.value[declaration.titleField];
  return {
    uri: recordUri(type, key),
    name: `${type}/${key}`,
    ...(typeof title === "string" ? { title } : {}),
    mimeType: "application/json",
    lastModified: stored.updatedAt,
  };
}

async function prepareDeclarationSchema(
  schema: JsonObject,
  uri: string,
): Promise<PreparedSchema | Refusal> {
  try {
    return await prepareSchema(schema);
  } catch (error) {
    if (error instanceof SchemaRefusal) {
      return { errors: error.messages.map((message) => ({ uri, message })) };
    }
    throw error;
  }
}

async function preparedDeclarationSchema(
  declaration: TypeDeclaration,
  uri: string,
): Promise<PreparedSchema | Refusal> {
  return prepareDeclarationSchema(declaration.schema, uri);
}

async function missingLinkErrors(
  dataFolder: string,
  typeFolder: string,
  schema: PreparedSchema,
  value: JsonObject,
  sourceUri?: string,
): Promise<StoreError[]> {
  const errors: StoreError[] = [];
  const existence = new Map<string, boolean>();
  const checkedFields = new Set<string>();
  for (const field of schema.formatFields(value, "uri")) {
    if (typeof field.value !== "string" || !/^autofile:/iu.test(field.value)) continue;
    const fieldKey = `${field.pointer}\0${field.value}`;
    if (checkedFields.has(fieldKey)) continue;
    checkedFields.add(fieldKey);
    let exists = existence.get(field.value);
    if (exists === undefined) {
      exists = await recordExists(dataFolder, typeFolder, field.value);
      existence.set(field.value, exists);
    }
    if (exists) continue;
    errors.push({
      ...(sourceUri === undefined ? {} : { uri: sourceUri }),
      message: `${field.location}: links to a record that does not exist: ${field.value}`,
    });
  }
  return errors;
}

interface MaterializedRecordBlobs {
  value: JsonObject;
  blobs: PreparedBlob[];
}

async function prepareRecordBlobs(
  blobFolder: string,
  schema: PreparedSchema,
  value: JsonObject,
  allowLocalPaths: boolean,
  uri: string,
): Promise<MaterializedRecordBlobs | Refusal> {
  const materialized = structuredClone(value);
  const preparedBlobs = new Map<string, PreparedBlob>();
  const errors: StoreError[] = [];
  const visitedPointers = new Set<string>();
  for (const field of schema.formatFields(value, "blob")) {
    if (visitedPointers.has(field.pointer)) continue;
    visitedPointers.add(field.pointer);
    if (typeof field.value !== "string") continue;
    const prepared = await prepareBlob(field.value, blobFolder, allowLocalPaths);
    if ("message" in prepared) {
      errors.push(formatFieldError(uri, field.location, prepared.message));
      continue;
    }
    setValueAtPointer(materialized, field.pointer, prepared.uri);
    preparedBlobs.set(prepared.uri, prepared);
  }
  if (errors.length > 0) return { errors };

  const validationErrors = await schema.validate(materialized);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((message) => ({ uri, message })) };
  }

  const finalBlobs = new Map<string, PreparedBlob>();
  const finalPointers = new Set<string>();
  for (const field of schema.formatFields(materialized, "blob")) {
    if (finalPointers.has(field.pointer)) continue;
    finalPointers.add(field.pointer);
    const fieldValue = typeof field.value === "string" ? field.value : undefined;
    if (fieldValue === undefined || blobNameFromUri(fieldValue) === undefined) {
      const message = "must hold a blob URI after storing";
      errors.push(formatFieldError(uri, field.location, message));
      continue;
    }

    let prepared = preparedBlobs.get(fieldValue);
    if (prepared === undefined) {
      const existing = await prepareBlob(fieldValue, blobFolder, false);
      if ("message" in existing) {
        errors.push(formatFieldError(uri, field.location, existing.message));
        continue;
      }
      prepared = existing;
    }
    finalBlobs.set(fieldValue, prepared);
  }
  if (errors.length > 0) return { errors };
  return { value: materialized, blobs: [...finalBlobs.values()] };
}

function formatFieldError(uri: string, location: string, message: string): StoreError {
  return { uri, message: location === "" ? message : `${location}: ${message}` };
}

async function blobsHeldByRecord(
  value: JsonObject,
  schema: PreparedSchema,
): Promise<Set<string>> {
  const validationErrors = await schema.validate(value);
  if (validationErrors.length > 0) return blobUrisIn(value);
  return new Set(schema.formatFields(value, "blob").flatMap(({ value: fieldValue }) => (
    typeof fieldValue === "string" && blobNameFromUri(fieldValue) !== undefined
      ? [fieldValue]
      : []
  )));
}

async function deleteUnheldBlobs(
  dataFolder: string,
  typeFolder: string,
  candidates: ReadonlySet<string>,
): Promise<void> {
  if (candidates.size === 0) return;
  const held = await blobsHeldInStore(dataFolder, typeFolder);
  if (held === undefined) return;
  await deleteBlobUris(
    join(dataFolder, "_blobs"),
    [...candidates].filter((uri) => !held.has(uri)),
  );
}

async function blobsHeldInStore(
  dataFolder: string,
  typeFolder: string,
): Promise<Set<string> | undefined> {
  const held = new Set<string>();
  let typeEntries;
  try {
    typeEntries = (await readDirectory(typeFolder)).filter((entry) => (
      entry.isFile() && entry.name.endsWith(".json")
    ));
  } catch (error) {
    if (hasErrorCode(error)) return undefined;
    throw error;
  }
  for (const typeEntry of typeEntries) {
    const type = typeEntry.name.slice(0, -".json".length);
    if (!typeNamePattern.test(type)) continue;
    let declaration: ReadResult<TypeDeclaration>;
    try {
      declaration = await readDeclaration(typeFolder, type);
    } catch (error) {
      if (!hasErrorCode(error)) throw error;
      declaration = { status: "invalid", message: "type declaration cannot be read" };
    }
    let schema: PreparedSchema | undefined;
    if (declaration.status === "found") {
      const prepared = await preparedDeclarationSchema(declaration.value, typeUri(type));
      if (!("errors" in prepared)) schema = prepared;
    }

    let recordEntries;
    try {
      recordEntries = await recognizedRecordEntries(join(dataFolder, type));
    } catch (error) {
      if (hasErrorCode(error)) return undefined;
      throw error;
    }
    for (const entry of recordEntries) {
      let record: TextReadResult<unknown>;
      try {
        record = await readJsonText(join(dataFolder, type, entry.name), "record file");
      } catch (error) {
        if (hasErrorCode(error)) return undefined;
        throw error;
      }
      if (record.status === "invalid") return undefined;
      if (record.status === "missing") continue;
      if (schema !== undefined && isStoredRecord(record.value)) {
        for (const uri of await blobsHeldByRecord(record.value.value, schema)) held.add(uri);
      } else {
        for (const uri of blobUrisIn(record.value)) held.add(uri);
      }
    }
  }
  return held;
}

function blobUrisIn(value: unknown): Set<string> {
  const uris = new Set<string>();
  collectBlobUris(value, uris);
  return uris;
}

function collectBlobUris(value: unknown, uris: Set<string>): void {
  if (typeof value === "string") {
    if (blobNameFromUri(value) !== undefined) uris.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectBlobUris(item, uris);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectBlobUris(item, uris);
  }
}

function setValueAtPointer(value: JsonObject, pointer: string, replacement: string): void {
  const path = parseJsonPointer(pointer);
  const field = path.at(-1);
  if (field === undefined) return;
  let parent: JsonValue = value;
  for (const part of path.slice(0, -1)) {
    let next: JsonValue | undefined;
    if (Array.isArray(parent)) next = parent[Number(part)];
    else if (isJsonObject(parent)) next = parent[part];
    if (next === undefined) return;
    parent = next;
  }
  if (Array.isArray(parent)) parent[Number(field)] = replacement;
  else if (isJsonObject(parent)) {
    Object.defineProperty(parent, field, {
      value: replacement,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

async function recordExists(
  dataFolder: string,
  typeFolder: string,
  uri: string,
): Promise<boolean> {
  const parsed = parseRecordUri(uri);
  if (parsed === undefined) return false;
  if (await readValidDeclaration(typeFolder, parsed.type) === undefined) return false;
  const stored = await readStoredRecord(recordPath(dataFolder, parsed.type, parsed.key));
  return stored.status === "found";
}

async function readValidDeclaration(
  typeFolder: string,
  type: string,
): Promise<TypeDeclaration | undefined> {
  return (await readValidDeclarationText(typeFolder, type))?.value;
}

async function readValidDeclarationText(
  typeFolder: string,
  type: string,
): Promise<{ value: TypeDeclaration; text: string } | undefined> {
  const result = await readDeclarationText(typeFolder, type);
  if (result.status !== "found") return undefined;
  try {
    await prepareSchema(result.value.schema);
  } catch (error) {
    if (error instanceof SchemaRefusal) return undefined;
    throw error;
  }
  return { value: result.value, text: result.text };
}

async function invalidRecords(
  dataFolder: string,
  type: string,
  schema: PreparedSchema,
): Promise<StoreError[]> {
  const errors: StoreError[] = [];
  const entries = await recognizedRecordEntries(join(dataFolder, type));
  for (const entry of entries) {
    const key = entry.name.slice(0, -".json".length);
    const uri = recordUri(type, key);
    const record = await readStoredRecord(join(dataFolder, type, entry.name));
    if (record.status !== "found") {
      errors.push({ uri, message: record.status === "invalid" ? record.message : "record does not exist" });
      continue;
    }
    const validationErrors = await schema.validate(record.value.value);
    if (validationErrors.length > 0) errors.push({ uri, message: validationErrors.join("; ") });
  }
  return errors;
}

async function readDeclaration(folder: string, type: string): Promise<ReadResult<TypeDeclaration>> {
  const result = await readDeclarationText(folder, type);
  if (result.status !== "found") return result;
  return { status: "found", value: result.value };
}

async function readDeclarationText(
  folder: string,
  type: string,
): Promise<TextReadResult<TypeDeclaration>> {
  if (!await isDirectory(folder)) return { status: "missing" };
  const result = await readJsonText(join(folder, `${type}.json`), "type declaration");
  if (result.status !== "found") return result;
  if (!isTypeDeclaration(result.value)) {
    return { status: "invalid", message: "type declaration is not valid" };
  }
  return { status: "found", value: result.value, text: result.text };
}

async function readStoredRecord(path: string): Promise<ReadResult<StoredRecord>> {
  const result = await readStoredRecordText(path);
  if (result.status !== "found") return result;
  return { status: "found", value: result.value };
}

async function readStoredRecordText(
  path: string,
): Promise<TextReadResult<StoredRecord>> {
  if (!await isDirectory(dirname(path))) return { status: "missing" };
  const result = await readJsonText(path, "record file");
  if (result.status !== "found") return result;
  if (!isStoredRecord(result.value)) {
    return { status: "invalid", message: "record file does not contain a valid record" };
  }
  return { status: "found", value: result.value, text: result.text };
}

async function readJsonText(path: string, label: string): Promise<TextReadResult<unknown>> {
  const bytes = await readRegularFile(path);
  if (bytes === undefined) return { status: "missing" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { status: "invalid", message: `${label} is not valid UTF-8` };
  }
  try {
    return { status: "found", value: JSON.parse(text) as unknown, text };
  } catch {
    return { status: "invalid", message: `${label} cannot be read as JSON` };
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!hasCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

function mergePatch(target: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) {
      delete result[key];
    } else if (isJsonObject(patchValue)) {
      Object.defineProperty(result, key, {
        value: mergePatch(isJsonObject(result[key]) ? result[key] : {}, patchValue),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      Object.defineProperty(result, key, {
        value: patchValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}

function nextTid(): string {
  const now = BigInt(Date.now()) * 1_000n;
  lastTidTimestamp = now > lastTidTimestamp ? now : lastTidTimestamp + 1n;
  let value = (lastTidTimestamp << 10n) | clockIdentifier;
  let tid = "";
  for (let index = 0; index < 13; index += 1) {
    tid = `${tidAlphabet[Number(value & 31n)]}${tid}`;
    value >>= 5n;
  }
  return tid;
}

/** Returns whether a string is the canonical URI of an Autofile resource. */
export function isResourceUri(uri: string): boolean {
  return parseRecordUri(uri) !== undefined
    || typeUriPattern.test(uri)
    || BLOB_URI_PATTERN.test(uri);
}

function parseRecordUri(uri: string): { type: string; key: string } | undefined {
  const match = recordUriPattern.exec(uri);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { type: match[1], key: match[2] };
}

function recordUri(type: string, key: string): string {
  return `autofile:///${type}/${key}`;
}

function typeUri(type: string): string {
  return `autofile:///_types/${type}`;
}

function mimeTypeForBlob(name: string): string {
  return lookupMimeType(name) || "application/octet-stream";
}

function recordPath(dataFolder: string, type: string, key: string): string {
  return join(dataFolder, type, `${key}.json`);
}

function encodeRecordCursor(uri: string): string {
  return Buffer.from(uri, "utf8").toString("base64url");
}

function decodeRecordCursor(cursor: string, type: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return undefined;
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) return undefined;
  let uri: string;
  try {
    uri = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const record = parseRecordUri(uri);
  return record?.type === type ? uri : undefined;
}

function findWhereRefusal(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const refusal = findWhereRefusal(item);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("$")) return `where: the operator ${key} is not supported`;
    const unsafeKey = key.split(".").find((part) => (
      part === "__proto__" || part === "constructor" || part === "prototype"
    ));
    if (unsafeKey !== undefined) return `where: the key ${unsafeKey} is not supported`;
    const refusal = findWhereRefusal(item);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function recordFileReadError(error: unknown): string {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? `: ${error.code}`
    : "";
  return `record file cannot be read${code}`;
}

function stringValuesContainWords(value: JsonValue, words: string[]): boolean {
  if (words.length === 0) return true;
  const strings: string[] = [];
  collectStringValues(value, strings);
  const normalized = strings.map((item) => item.toLowerCase());
  return words.every((word) => normalized.some((item) => item.includes(word)));
}

function collectStringValues(value: JsonValue, strings: string[]): void {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, strings);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) collectStringValues(item, strings);
  }
}

function containsStringValue(value: JsonValue, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.some((item) => containsStringValue(item, expected));
  return isJsonObject(value)
    && Object.values(value).some((item) => containsStringValue(item, expected));
}

function removeFields(value: JsonObject, pointers: string[]): JsonObject {
  const result = structuredClone(value);
  const paths = [...new Set(pointers)].map(parseJsonPointer);
  paths.sort((left, right) => {
    const leftParent = left.slice(0, -1).join("\0");
    const rightParent = right.slice(0, -1).join("\0");
    if (leftParent === rightParent) {
      const leftIndex = Number(left.at(-1));
      const rightIndex = Number(right.at(-1));
      if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex)) {
        return rightIndex - leftIndex;
      }
    }
    return right.length - left.length;
  });
  for (const path of paths) {
    const field = path.at(-1);
    if (field === undefined) continue;
    let parent: JsonValue = result;
    let parentFound = true;
    for (const part of path.slice(0, -1)) {
      let next: JsonValue | undefined;
      if (Array.isArray(parent)) next = parent[Number(part)];
      else if (isJsonObject(parent)) next = parent[part];
      if (next === undefined) {
        parentFound = false;
        break;
      }
      parent = next;
    }
    if (!parentFound) continue;
    if (Array.isArray(parent)) parent.splice(Number(field), 1);
    else if (isJsonObject(parent)) delete parent[field];
  }
  return result;
}

function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((part) => (
    part.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
}

function timestampAfter(previous: string): string {
  return new Date(Math.max(Date.now(), new Date(previous).valueOf() + 1)).toISOString();
}

function refuse(message: string, uri?: string): Refusal {
  return { errors: [{ ...(uri === undefined ? {} : { uri }), message }] };
}

function declarationRefusal(type: string, result: ReadResult<TypeDeclaration>): Refusal {
  const uri = typeUri(type);
  if (result.status === "missing") return refuse("type does not exist", uri);
  if (result.status === "invalid") return refuse(result.message, uri);
  throw new Error("A found declaration is not a refusal");
}

function recordReadRefusal(uri: string, result: ReadResult<StoredRecord>): Refusal {
  if (result.status === "missing") return refuse("record does not exist", uri);
  if (result.status === "invalid") return refuse(result.message, uri);
  throw new Error("A found record is not a refusal");
}

async function recognizedRecordEntries(folder: string) {
  return (await readDirectory(folder))
    .filter((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      return keyPattern.test(entry.name.slice(0, -".json".length));
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readDirectory(path: string) {
  try {
    if (!(await lstat(path)).isDirectory()) return [];
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return [];
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

interface OpenedRegularFile {
  handle: FileHandle;
  size: number;
}

async function openRegularFile(path: string): Promise<OpenedRegularFile | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      hasCode(error, "ENOENT")
      || hasCode(error, "ENOTDIR")
      || hasCode(error, "ELOOP")
      || hasCode(error, "ENXIO")
      || hasCode(error, "ENODEV")
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      await handle.close();
      return undefined;
    }
    return { handle, size: details.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function regularFileSize(
  path: string,
  maximumBytes: number,
): Promise<number | undefined> {
  const file = await openRegularFile(path);
  if (file === undefined) return undefined;
  try {
    return file.size <= maximumBytes ? file.size : undefined;
  } finally {
    await file.handle.close();
  }
}

async function readRegularFile(
  path: string,
  maximumBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer | undefined> {
  const file = await openRegularFile(path);
  if (file === undefined) return undefined;
  try {
    if (file.size > maximumBytes) return undefined;
    const bytes = await file.handle.readFile();
    return bytes.byteLength <= maximumBytes ? bytes : undefined;
  } finally {
    await file.handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isTypeDeclaration(value: unknown): value is TypeDeclaration {
  if (!isJsonObject(value)) return false;
  if (
    Object.keys(value).some((key) => (
      !["description", "title", "titleField", "schema"].includes(key)
    ))
  ) {
    return false;
  }
  if (typeof value.description !== "string" || !isJsonObject(value.schema)) return false;
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length === 0)) {
    return false;
  }
  return value.titleField === undefined || typeof value.titleField === "string";
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isJsonObject(value)) return false;
  if (Object.keys(value).length !== 3) return false;
  if (!["createdAt", "updatedAt", "value"].every((key) => Object.hasOwn(value, key))) return false;
  return isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) && isJsonObject(value.value);
}

function isTimestamp(value: JsonValue | undefined): value is string {
  if (typeof value !== "string" || !timestampPattern.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return hasErrorCode(error) && error.code === code;
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
