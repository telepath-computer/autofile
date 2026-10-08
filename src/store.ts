/**
 * Reads and writes Autofile's on-disk types and records. Each operation reads
 * current files, returns plain JSON, and maps correctable store problems to the
 * same error objects the MCP layer will later place in structured content.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import lockfile from "proper-lockfile";

import { getStorage, getWriteLockPath } from "./config.js";
import type { JsonObject, JsonValue } from "./json.js";
import { prepareSchema, SchemaRefusal, type PreparedSchema } from "./schema.js";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const keyPattern = /^[a-z0-9][a-z0-9-]*$/u;
const recordUriPattern = /^autofile:\/\/\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const tidAlphabet = "234567abcdefghijklmnopqrstuvwxyz";
const invalidTypeMessage = "type: must use lowercase letters, digits, and hyphens and start with a letter";
const invalidKeyMessage = "key: must use lowercase letters, digits, and hyphens and start with a letter or digit";
const invalidRecordUriMessage = "uri: must be a record URI, such as autofile:///tasks/book-the-dentist";
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

export interface Store {
  getRecord(input: GetRecordInput): Promise<RecordResult | Refusal>;
  createRecord(input: CreateRecordInput): Promise<UriResult | Refusal>;
  updateRecord(input: UpdateRecordInput): Promise<UriResult | Refusal>;
  deleteRecord(input: DeleteRecordInput): Promise<UriResult | Refusal>;
  listTypes(input: Record<string, never>): Promise<ListTypesResult>;
  getType(input: GetTypeInput): Promise<TypeResult | Refusal>;
  createType(input: CreateTypeInput): Promise<UriResult | Refusal>;
  updateType(input: UpdateTypeInput): Promise<UpdateTypeResult | Refusal>;
  deleteType(input: DeleteTypeInput): Promise<UriResult | Refusal>;
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
}
export interface UpdateTypeInput {
  type: string;
  description?: string;
  schema?: JsonObject;
  titleField?: string | null;
}
export interface DeleteTypeInput { type: string }

export interface UriResult { uri: string }
export interface RecordResult extends UriResult {
  created: string;
  updated: string;
  value: JsonObject;
  error?: string;
}
export interface TypeSummary extends UriResult {
  type: string;
  description: string;
}
export interface ListTypesResult { types: TypeSummary[] }
export interface TypeResult extends UriResult {
  description: string;
  schema: JsonObject;
  titleField?: string;
}
export interface UpdateTypeResult extends UriResult { errors: StoreError[] }

interface TypeDeclaration {
  description: string;
  schema: JsonObject;
  titleField?: string;
}

interface StoredRecord {
  created: string;
  updated: string;
  value: JsonObject;
}

type ReadResult<T> =
  | { status: "found"; value: T }
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
      created: stored.value.created,
      updated: stored.value.updated,
      value: stored.value.value,
    };
    if (validationErrors.length > 0) result.error = validationErrors.join("; ");
    return result;
  }

  async function createRecord(input: CreateRecordInput): Promise<UriResult | Refusal> {
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

      await mkdir(join(dataFolder, input.type), { recursive: true });
      let key = input.key;
      if (key === undefined) {
        do key = nextTid();
        while (await pathExists(recordPath(dataFolder, input.type, key)));
      } else if (await pathExists(recordPath(dataFolder, input.type, key))) {
        return refuse("a record with that key already exists", recordUri(input.type, key));
      }

      const uri = recordUri(input.type, key);
      const now = new Date().toISOString();
      await writeJsonAtomically(recordPath(dataFolder, input.type, key), {
        created: now,
        updated: now,
        value: input.record,
      });
      return { uri };
    });
  }

  async function updateRecord(input: UpdateRecordInput): Promise<UriResult | Refusal> {
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

      await writeJsonAtomically(path, {
        created: stored.value.created,
        updated: new Date().toISOString(),
        value,
      });
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
      await unlink(path);
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
      const declaration = await readDeclaration(typeFolder, type);
      if (declaration.status !== "found") continue;
      try {
        await prepareSchema(declaration.value.schema);
      } catch (error) {
        if (error instanceof SchemaRefusal) continue;
        throw error;
      }
      types.push({ uri: typeUri(type), type, description: declaration.value.description });
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
      if (input.schema !== undefined && !isJsonObject(input.schema)) {
        return refuse("schema: must be a JSON object");
      }

      const declaration: TypeDeclaration = {
        description: input.description ?? current.value.description,
        ...(
          input.titleField === null
            ? {}
            : { titleField: input.titleField ?? current.value.titleField }
        ),
        schema: input.schema ?? current.value.schema,
      };
      if (declaration.titleField === undefined) delete declaration.titleField;
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

  return {
    getRecord,
    createRecord,
    updateRecord,
    deleteRecord,
    listTypes,
    getType,
    createType,
    updateType,
    deleteType,
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
  const result = await readJson(join(folder, `${type}.json`), "type declaration");
  if (result.status !== "found") return result;
  if (!isTypeDeclaration(result.value)) {
    return { status: "invalid", message: "type declaration is not valid" };
  }
  return { status: "found", value: result.value };
}

async function readStoredRecord(path: string): Promise<ReadResult<StoredRecord>> {
  const result = await readJson(path, "record file");
  if (result.status !== "found") return result;
  if (!isStoredRecord(result.value)) {
    return { status: "invalid", message: "record file does not contain a valid record" };
  }
  return { status: "found", value: result.value };
}

async function readJson(path: string, label: string): Promise<ReadResult<unknown>> {
  if (!await isRegularFile(path)) return { status: "missing" };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { status: "missing" };
    throw error;
  }
  try {
    return { status: "found", value: JSON.parse(text) as unknown };
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

function recordPath(dataFolder: string, type: string, key: string): string {
  return join(dataFolder, type, `${key}.json`);
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
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
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
  if (Object.keys(value).some((key) => !["description", "titleField", "schema"].includes(key))) {
    return false;
  }
  if (typeof value.description !== "string" || !isJsonObject(value.schema)) return false;
  return value.titleField === undefined || typeof value.titleField === "string";
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isJsonObject(value)) return false;
  if (Object.keys(value).length !== 3) return false;
  if (!["created", "updated", "value"].every((key) => Object.hasOwn(value, key))) return false;
  return isTimestamp(value.created) && isTimestamp(value.updated) && isJsonObject(value.value);
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
  return error instanceof Error && "code" in error && error.code === code;
}
