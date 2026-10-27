/**
 * Autofile owns one data folder: record and type operations, blob uploads and
 * reads, and shared change subscriptions. Operations read current files;
 * protocol adapters translate these values without owning a second persistence
 * implementation.
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
  MAX_BLOB_BYTES,
  blobNameFromUri,
  deleteBlobUris,
  blobReferenceProblem,
  blobSizeProblem,
  isMediaType,
  writeBlob,
} from "./blobs.js";
import { getWriteLockPath } from "./config.js";
import { jsonObjectProblem, type JsonObject, type JsonValue } from "./json.js";
import { prepareSchema, SchemaRefusal, type PreparedSchema } from "./schema.js";

import { watchFolder, type FolderWatcher } from "./watch.js";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const keyPattern = /^[a-z0-9][a-z0-9-]*$/u;
const recordUriPattern = /^autofile:\/\/\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_FIND_RECORDS_PAGE_BYTES = 64 * 1024;
const tidAlphabet = "234567abcdefghijklmnopqrstuvwxyz";
const invalidTypeMessage = "type: must use lowercase letters, digits, and hyphens and start with a letter";
const invalidKeyMessage = "key: must use lowercase letters, digits, and hyphens and start with a letter or digit";
const invalidRecordUriMessage = "uri: must be a record URI, such as autofile:///task/book-the-dentist";
const clockIdentifier = BigInt(randomBytes(2).readUInt16BE() & 0x3ff);
let lastTidTimestamp = 0n;

/** One reason an operation was refused, with an address when applicable. */
export interface AutofileProblem { uri?: string; message: string }

/** A refused operation, with every problem the caller can correct. */
export class AutofileError extends Error {
  readonly problems: AutofileProblem[];

  constructor(problems: AutofileProblem[]) {
    super(problems.map(({ message }) => message).join("; "));
    this.name = "AutofileError";
    this.problems = problems;
  }
}

/** A record with its address, identity, and optional display title. */
export interface AutofileRecord {
  uri: string;
  type: string;
  key: string;
  title?: string;
  problems?: AutofileProblem[];
  createdAt: string;
  updatedAt: string;
  value: JsonObject;
}

/** Optional filters and paging controls; where and fields apply only to value. */
export interface RecordQuery {
  type?: string | string[];
  q?: string;
  where?: JsonObject;
  fields?: string[];
  limit?: number;
  cursor?: string;
}

/** One page of matching records and records that could not be returned. */
export interface RecordQueryResult {
  records: AutofileRecord[];
  unreadable: { uri: string; message: string }[];
  cursor?: string;
}

/** The fields stored in a type declaration. */
export interface TypeDefinition {
  description: string;
  schema: JsonObject;
  titleField?: string;
}

/** A type declaration together with its name and address. */
export interface TypeDeclaration extends TypeDefinition {
  uri: string;
  type: string;
  problems?: AutofileProblem[];
}

/** Changes to a declaration; null removes the title field. */
export type TypeChanges = Partial<Omit<TypeDefinition, "titleField">> & { titleField?: string | null };

/** A record or type was created, changed, or deleted. */
export interface ChangeEvent { uri: string; kind: "created" | "changed" | "deleted" }

type ChangeListener = (changes: ChangeEvent[]) => void | Promise<void>;

/** Handles failures from this subscription or from change monitoring. */
export interface WatchOptions { onError?: (error: Error) => void }

interface ChangeSubscription {
  onChange: ChangeListener;
  onError?: (error: Error) => void;
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

/** The store implementation. Construction resolves paths but performs no I/O. */
export class Autofile {
  readonly #dataFolder: string;
  readonly #typeFolder: string;
  readonly #blobFolder: string;
  readonly #writeLockPath: string;
  #ready: Promise<void> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #watcher: Promise<FolderWatcher> | undefined;
  #notifications = Promise.resolve();
  readonly #listeners = new Set<ChangeSubscription>();
  readonly #watchTypes = new Set<string>();

  constructor(options: { folder: string }) {
    if (typeof options?.folder !== "string" || options.folder.length === 0) {
      refuse("folder: must be a non-empty string");
    }
    this.#dataFolder = resolve(options.folder);
    this.#typeFolder = join(this.#dataFolder, "_types");
    this.#blobFolder = join(this.#dataFolder, "_blobs");
    // Keep the existing process-home lock policy until a separate change moves it.
    this.#writeLockPath = resolve(getWriteLockPath());
  }

  readonly records = {
    find: (query: RecordQuery = {}): Promise<RecordQueryResult> => this.#operation(() => this.#findRecords(query)),
    get: (uri: string): Promise<AutofileRecord | undefined> => this.#operation(() => this.#getRecord(uri)),
    create: (type: string, value: JsonObject, options: { key?: string } = {}): Promise<AutofileRecord> => this.#operation(() => {
      if (!isJsonObject(options)) return refuse("options: must be an object");
      const problem = jsonObjectProblem(value);
      if (problem !== undefined) return refuse(`record: ${problem}`);
      // Snapshot checked JSON before asynchronous storage work begins.
      return this.#createRecord(type, JSON.parse(JSON.stringify(value)) as JsonObject, { key: options.key });
    }),
    update: (uri: string, patch: JsonObject): Promise<AutofileRecord> => this.#operation(() => {
      const problem = jsonObjectProblem(patch);
      if (problem !== undefined) return refuse(`patch: ${problem}`, uri);
      return this.#updateRecord(uri, JSON.parse(JSON.stringify(patch)) as JsonObject);
    }),
    delete: (uri: string): Promise<void> => this.#operation(() => this.#deleteRecord(uri)),
  };

  readonly types = {
    list: (): Promise<TypeDeclaration[]> => this.#operation(() => this.#listTypes()),
    get: (name: string): Promise<TypeDeclaration | undefined> => this.#operation(() => this.#getType(name)),
    create: (name: string, definition: TypeDefinition): Promise<TypeDeclaration> => this.#operation(() => this.#createType(name, definition)),
    update: (name: string, changes: TypeChanges): Promise<TypeDeclaration> => this.#operation(() => this.#updateType(name, changes)),
    delete: (name: string): Promise<void> => this.#operation(() => this.#deleteType(name)),
  };

  readonly blobs = {
    put: (bytes: Uint8Array, mediaType: string): Promise<string> => this.#operation(() => {
      if (!(bytes instanceof Uint8Array)) return refuse("bytes: must be a Uint8Array");
      if (bytes.byteLength > MAX_BLOB_BYTES) return refuse(blobSizeProblem(bytes.byteLength));
      if (!isMediaType(mediaType)) return refuse("mediaType: must be a valid media type, such as application/pdf");
      const snapshot = Buffer.from(bytes);
      if (snapshot.length > MAX_BLOB_BYTES) return refuse(blobSizeProblem(snapshot.length));
      return this.#withWriteLock(() => writeBlob(this.#blobFolder, snapshot, mediaType));
    }),
    get: (uri: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> => this.#operation(() => this.#getBlob(uri)),
  };

  /** Checks a schema without accessing storage or checking link targets. */
  static async prepareSchema(schema: JsonObject): Promise<PreparedSchema> {
    return prepareDeclarationSchema(snapshotSchema(schema));
  }

  /** Subscribes after the shared watcher is ready; the returned function unsubscribes. */
  async watch(onChange: ChangeListener, options: WatchOptions = {}): Promise<() => Promise<void>> {
    await this.#operation(() => this.#ensureReady());
    // Each call is a subscription, even if callers reuse the same function.
    const listener: ChangeSubscription = { onChange, ...options };
    this.#listeners.add(listener);
    this.#watcher ??= this.#startWatcher();
    try {
      await this.#watcher;
      this.#assertOpen();
    } catch (error) {
      this.#listeners.delete(listener);
      this.#watcher = undefined;
      if (hasErrorCode(error)) throw new Error("Change monitoring failed");
      throw error;
    }
    return async () => { this.#listeners.delete(listener); };
  }

  /** Stops change subscriptions. Future operations on this instance are refused. */
  close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    this.#closing ??= (async () => {
      const watcher = await this.#watcher;
      await this.#operation(async () => watcher?.close());
    })();
    return this.#closing;
  }

  async #operation<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (hasErrorCode(error)) throw new Error("Storage operation failed");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) refuse("Autofile is closed");
  }

  async #ensureReady(): Promise<void> {
    this.#assertOpen();
    this.#ready ??= Promise.all([
      mkdir(this.#dataFolder, { recursive: true }),
      mkdir(dirname(this.#writeLockPath), { recursive: true }),
    ]).then(() => undefined);
    await this.#ready;
    this.#assertOpen();
  }

  #reportWatchError(): void {
    const failure = new Error("Change monitoring failed");
    for (const listener of this.#listeners) reportSubscriptionError(listener, failure);
  }

  async #startWatcher(): Promise<FolderWatcher> {
    const watcher = await watchFolder(this.#dataFolder, (changes) => {
      // Delivery is ordered independently of the filesystem watcher so a
      // subscriber may await close without waiting for its own callback.
      this.#notifications = this.#notifications.then(async () => {
        await this.#watcher;
        if (this.#closed) return;
        const events = await this.#logicalChanges(changes);
        if (events.length === 0) return;
        for (const subscription of [...this.#listeners]) {
          if (!this.#listeners.has(subscription)) continue;
          try { await subscription.onChange(events); }
          catch (error) { reportSubscriptionError(subscription, toError(error)); }
        }
      }).catch(() => this.#reportWatchError());
    }, () => this.#reportWatchError());
    try {
      for (const declaration of await this.#listTypes()) this.#watchTypes.add(declaration.type);
      return watcher;
    } catch {
      await watcher.close();
      throw new Error("Change monitoring failed");
    }
  }

  async #logicalChanges(changes: ChangeEvent[]): Promise<ChangeEvent[]> {
    const previousTypes = new Set(this.#watchTypes);
    const uncertainTypes = new Set<string>();
    const events: ChangeEvent[] = [];
    for (const change of changes) {
      if (!change.uri.startsWith("autofile:///_types/")) continue;
      const type = change.uri.slice("autofile:///_types/".length);
      try {
        const declaration = await readValidDeclaration(this.#typeFolder, type);
        if (declaration === undefined) this.#watchTypes.delete(type);
        else this.#watchTypes.add(type);
      } catch {
        // An unavailable declaration does not prove a type disappeared. Retain
        // known membership and forward this batch's affected hints for rereading.
        uncertainTypes.add(type);
        this.#reportWatchError();
      }
      if (previousTypes.has(type) || this.#watchTypes.has(type) || uncertainTypes.has(type)) events.push(change);
    }
    for (const change of changes) {
      const record = parseRecordUri(change.uri);
      if (record !== undefined && (previousTypes.has(record.type) || this.#watchTypes.has(record.type) || uncertainTypes.has(record.type))) {
        events.push(change);
      }
    }
    return events;
  }

  async #withWriteLock<T>(write: () => Promise<T>): Promise<T> {
    await this.#ensureReady();
    let release: () => Promise<void>;
    let retryDelay = 50;
    while (true) {
      try {
        release = await lockfile.lock(dirname(this.#writeLockPath), {
          lockfilePath: this.#writeLockPath,
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

  async #findRecords(
    input: RecordQuery,
  ): Promise<RecordQueryResult> {
    await this.#ensureReady();
    if (input === null || typeof input !== "object" || Array.isArray(input)) return refuse("query: must be an object");
    const requestedTypes = input.type === undefined ? undefined
      : typeof input.type === "string" ? [input.type] : input.type;
    if (requestedTypes !== undefined && (!Array.isArray(requestedTypes)
      || requestedTypes.some((type) => typeof type !== "string" || !typeNamePattern.test(type)))) {
      refuse(invalidTypeMessage);
    }
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
      : decodeRecordCursor(input.cursor, requestedTypes);
    if (input.cursor !== undefined && afterUri === undefined) {
      return refuse("cursor: is invalid");
    }

    const declarations = requestedTypes === undefined
      ? await this.#listTypes()
      : await Promise.all([...new Set(requestedTypes)].map(async (type) => {
        const declaration = await this.#getType(type);
        if (declaration === undefined) refuse("type does not exist", typeUri(type));
        return declaration;
      }));
    const entries: Array<{ type: string; key: string; name: string; uri: string; declaration: TypeDeclaration; schema: PreparedSchema }> = [];
    for (const declaration of declarations) {
      const schema = await preparedDeclarationSchema(declaration, declaration.uri);
      for (const entry of await recognizedRecordEntries(join(this.#dataFolder, declaration.type))) {
        const key = entry.name.slice(0, -".json".length);
        entries.push({ type: declaration.type, key, name: entry.name, uri: recordUri(declaration.type, key), declaration, schema });
      }
    }
    entries.sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
    const start = afterUri === undefined
      ? 0
      : entries.findIndex(({ uri }) => uri > afterUri);
    const firstPageIndex = start < 0 ? entries.length : start;
    const words = input.q?.trim().toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
    const query = new Query<JsonObject>(input.where ?? {}, { scriptEnabled: false });
    const fields = input.fields === undefined ? undefined : new Set(input.fields);
    const records: AutofileRecord[] = [];
    const errors: { uri: string; message: string }[] = [];
    let nextIndex = firstPageIndex;
    let lastReadUri: string | undefined;

    while (nextIndex < entries.length && records.length + errors.length < limit) {
      const current = entries[nextIndex];
      if (current === undefined) break;
      nextIndex += 1;
      const { type, key, name, uri, declaration, schema } = current;
      let stored: ReadResult<StoredRecord> | undefined;
      let record: AutofileRecord | undefined;
      let resultError: { uri: string; message: string } | undefined;
      try {
        stored = await readStoredRecord(join(this.#dataFolder, type, name));
      } catch (error) {
        resultError = { uri, message: recordReadError(error) };
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
            record = recordResult(type, key, declaration, stored.value);
            if (fields !== undefined) {
              record.value = Object.fromEntries(
                Object.entries(record.value).filter(([field]) => fields.has(field)),
              );
            }
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
        unreadable: nextErrors,
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
      unreadable: errors,
      ...(lastReadUri !== undefined && nextIndex < entries.length
        ? { cursor: encodeRecordCursor(lastReadUri) }
        : {}),
    };
  }

  async #getRecord(uri: string): Promise<AutofileRecord | undefined> {
    await this.#ensureReady();
    const parsed = parseRecordUri(uri);
    if (parsed === undefined) return refuse(invalidRecordUriMessage);
    const declaration = await readDeclaration(this.#typeFolder, parsed.type);
    if (declaration.status === "missing") return undefined;
    if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
    const stored = await readStoredRecord(recordPath(this.#dataFolder, parsed.type, parsed.key));
    if (stored.status === "missing") return undefined;
    if (stored.status !== "found") return recordReadRefusal(uri, stored);

    const schema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type));
    const validationErrors = await schema.validate(stored.value.value);
    const result = recordResult(parsed.type, parsed.key, declaration.value, stored.value);
    if (validationErrors.length > 0) result.problems = validationErrors.map((message) => ({ uri, message }));
    return result;
  }

  async #createRecord(
    type: string,
    value: JsonObject,
    options: { key?: string },
  ): Promise<AutofileRecord> {
    return this.#withWriteLock(async () => {
      if (typeof type !== "string" || !typeNamePattern.test(type)) return refuse(invalidTypeMessage);
      if (options.key !== undefined && (typeof options.key !== "string" || !keyPattern.test(options.key))) {
        return refuse(invalidKeyMessage);
      }
      if (!isJsonObject(value)) return refuse("record: must be a JSON object");

      const declaration = await readDeclaration(this.#typeFolder, type);
      if (declaration.status !== "found") return declarationRefusal(type, declaration);
      const schema = await preparedDeclarationSchema(declaration.value, typeUri(type));
      const sourceUri = options.key === undefined ? undefined : recordUri(type, options.key);
      const validationErrors = await schema.validate(value);
      if (validationErrors.length > 0) {
        throw new AutofileError(validationErrors.map((message) => ({ ...(sourceUri === undefined ? {} : { uri: sourceUri }), message })));
      }
      const linkErrors = await missingLinkErrors(
        this.#dataFolder,
        this.#typeFolder,
        schema,
        value,
        sourceUri,
      );
      if (linkErrors.length > 0) throw new AutofileError(linkErrors);

      await mkdir(join(this.#dataFolder, type), { recursive: true });
      let key = options.key;
      if (key === undefined) {
        do key = nextTid();
        while (await pathExists(recordPath(this.#dataFolder, type, key)));
      } else if (await pathExists(recordPath(this.#dataFolder, type, key))) {
        return refuse("a record with that key already exists", recordUri(type, key));
      }

      const uri = recordUri(type, key);
      const blobErrors = await missingBlobErrors(this.#blobFolder, schema, value, uri);
      if (blobErrors.length > 0) throw new AutofileError(blobErrors);

      const now = new Date().toISOString();
      const stored = { createdAt: now, updatedAt: now, value };
      await writeJsonAtomically(recordPath(this.#dataFolder, type, key), stored);
      return recordResult(type, key, declaration.value, stored);
    });
  }

  async #updateRecord(
    uri: string,
    patch: JsonObject,
  ): Promise<AutofileRecord> {
    return this.#withWriteLock(async () => {
      const parsed = parseRecordUri(uri);
      if (parsed === undefined) return refuse(invalidRecordUriMessage);
      if (!isJsonObject(patch)) return refuse("patch: must be a JSON object", uri);
      const declaration = await readDeclaration(this.#typeFolder, parsed.type);
      if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
      const path = recordPath(this.#dataFolder, parsed.type, parsed.key);
      const stored = await readStoredRecord(path);
      if (stored.status !== "found") return recordReadRefusal(uri, stored);

      const value = mergePatch(stored.value.value, patch);
      const problem = jsonObjectProblem(value);
      if (problem !== undefined) return refuse(`record: ${problem}`, uri);
      const schema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type));
      const validationErrors = await schema.validate(value);
      if (validationErrors.length > 0) {
        throw new AutofileError(validationErrors.map((message) => ({ uri, message })));
      }
      const errors = [
        ...await missingLinkErrors(this.#dataFolder, this.#typeFolder, schema, value, uri),
        ...await missingBlobErrors(this.#blobFolder, schema, value, uri),
      ];
      if (errors.length > 0) throw new AutofileError(errors);

      const previousBlobs = await blobsHeldByRecord(stored.value.value, schema);
      const updated = {
        createdAt: stored.value.createdAt,
        updatedAt: new Date().toISOString(),
        value,
      };
      await writeJsonAtomically(path, updated);
      await deleteUnheldBlobs(this.#dataFolder, this.#typeFolder, previousBlobs);
      return recordResult(parsed.type, parsed.key, declaration.value, updated);
    });
  }

  async #deleteRecord(targetUri: string): Promise<void> {
    return this.#withWriteLock(async () => {
      const parsed = parseRecordUri(targetUri);
      if (parsed === undefined) return refuse(invalidRecordUriMessage);
      const declaration = await readDeclaration(this.#typeFolder, parsed.type);
      if (declaration.status !== "found") return declarationRefusal(parsed.type, declaration);
      const path = recordPath(this.#dataFolder, parsed.type, parsed.key);
      if (!await isRegularFile(path)) return refuse("record does not exist", targetUri);

      const changes: Array<{ path: string; record: StoredRecord }> = [];
      const errors: AutofileProblem[] = [];
      let deletedRecord: StoredRecord | undefined;
      try {
        const target = await readStoredRecord(path);
        if (target.status === "missing") {
          errors.push({ uri: targetUri, message: "record does not exist" });
        } else if (target.status === "invalid") {
          errors.push({ uri: targetUri, message: target.message });
        } else {
          deletedRecord = target.value;
        }
      } catch (error) {
        errors.push({ uri: targetUri, message: recordReadError(error) });
      }
      const typeEntries = (await readDirectory(this.#typeFolder))
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && typeNamePattern.test(entry.name.slice(0, -".json".length))
        ))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const typeEntry of typeEntries) {
        const type = typeEntry.name.slice(0, -".json".length);
        const otherDeclaration = await readValidDeclaration(this.#typeFolder, type);
        if (otherDeclaration === undefined) continue;
        const schema = await preparedDeclarationSchema(otherDeclaration, typeUri(type));
        for (const entry of await recognizedRecordEntries(join(this.#dataFolder, type))) {
          const key = entry.name.slice(0, -".json".length);
          const uri = recordUri(type, key);
          if (uri === targetUri) continue;
          let stored: ReadResult<StoredRecord>;
          try {
            stored = await readStoredRecord(join(this.#dataFolder, type, entry.name));
          } catch (error) {
            errors.push({ uri, message: recordReadError(error) });
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
            if (containsStringValue(stored.value.value, targetUri)) {
              errors.push({
                uri,
                message: `record does not match its type and holds ${targetUri} as a string value`,
              });
            }
            continue;
          }

          const pointers = schema.formatFields(stored.value.value, "uri")
            .filter((field) => field.value === targetUri)
            .map(({ pointer }) => pointer);
          if (pointers.length === 0) continue;
          const value = removeFields(stored.value.value, pointers);
          const remainingErrors = await schema.validate(value);
          if (remainingErrors.length > 0) {
            errors.push({ uri, message: remainingErrors.join("; ") });
            continue;
          }
          changes.push({
            path: join(this.#dataFolder, type, entry.name),
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
        throw new AutofileError(errors);
      }

      let targetSchema: PreparedSchema | undefined;
      try { targetSchema = await preparedDeclarationSchema(declaration.value, typeUri(parsed.type)); }
      catch (error) { if (!(error instanceof AutofileError)) throw error; }
      const previousBlobs = deletedRecord === undefined
        ? new Set<string>()
        : targetSchema === undefined
          ? blobUrisIn(deletedRecord.value)
          : await blobsHeldByRecord(deletedRecord.value, targetSchema);
      for (const change of changes) await writeJsonAtomically(change.path, change.record);
      await unlink(path);
      await deleteUnheldBlobs(this.#dataFolder, this.#typeFolder, previousBlobs);
    });
  }

  async #listTypes(): Promise<TypeDeclaration[]> {
    await this.#ensureReady();
    const types: TypeDeclaration[] = [];
    for (const entry of await readDirectory(this.#typeFolder)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const type = entry.name.slice(0, -".json".length);
      if (!typeNamePattern.test(type)) continue;
      const declaration = await readValidDeclaration(this.#typeFolder, type);
      if (declaration !== undefined) types.push(typeResult(type, declaration));
    }
    return types.sort((left, right) => left.type.localeCompare(right.type));
  }

  async #getType(type: string): Promise<TypeDeclaration | undefined> {
    await this.#ensureReady();
    if (typeof type !== "string" || !typeNamePattern.test(type)) refuse(invalidTypeMessage);
    const declaration = await readDeclaration(this.#typeFolder, type);
    if (declaration.status === "missing") return undefined;
    if (declaration.status !== "found") return declarationRefusal(type, declaration);
    await preparedDeclarationSchema(declaration.value, typeUri(type));
    return typeResult(type, declaration.value);
  }

  async #createType(type: string, definition: TypeDefinition): Promise<TypeDeclaration> {
    if (typeof type !== "string" || !typeNamePattern.test(type)) return refuse(invalidTypeMessage);
    if (!isJsonObject(definition)) return refuse("declaration: must be an object");
    const { description, titleField } = definition;
    if (typeof description !== "string") return refuse("description: must be a string");
    if (titleField !== undefined && typeof titleField !== "string") {
      return refuse("titleField: must be a string");
    }
    // Validate and copy caller-owned data before acquiring the asynchronous lock.
    const declaration: TypeDefinition = {
      description,
      ...(titleField === undefined ? {} : { titleField }),
      schema: snapshotSchema(definition.schema),
    };
    return this.#withWriteLock(async () => {
      const declarationPath = join(this.#typeFolder, `${type}.json`);
      if (await pathExists(declarationPath)) {
        return refuse("type already exists", typeUri(type));
      }
      await prepareDeclarationSchema(declaration.schema, typeUri(type));

      await Promise.all([
        mkdir(this.#typeFolder, { recursive: true }),
        mkdir(join(this.#dataFolder, type), { recursive: true }),
      ]);
      await writeJsonAtomically(declarationPath, declaration);
      return typeResult(type, declaration);
    });
  }

  async #updateType(type: string, changes: TypeChanges): Promise<TypeDeclaration> {
    if (typeof type !== "string" || !typeNamePattern.test(type)) return refuse(invalidTypeMessage);
    if (!isJsonObject(changes)) return refuse("changes: must be an object");
    const { description, titleField: changedTitleField, schema: changedSchema } = changes;
    if (description !== undefined && typeof description !== "string") {
      return refuse("description: must be a string");
    }
    if (
      changedTitleField !== undefined
      && changedTitleField !== null
      && typeof changedTitleField !== "string"
    ) {
      return refuse("titleField: must be a string or null");
    }
    const schemaSnapshot = changedSchema === undefined ? undefined : snapshotSchema(changedSchema);
    return this.#withWriteLock(async () => {
      const current = await readDeclaration(this.#typeFolder, type);
      if (current.status !== "found") return declarationRefusal(type, current);

      const titleField = changedTitleField === null
        ? undefined
        : changedTitleField ?? current.value.titleField;
      const declaration: TypeDefinition = {
        description: description ?? current.value.description,
        ...(titleField === undefined ? {} : { titleField }),
        schema: schemaSnapshot ?? snapshotSchema(current.value.schema),
      };
      const schema = await prepareDeclarationSchema(declaration.schema, typeUri(type));

      await writeJsonAtomically(join(this.#typeFolder, `${type}.json`), declaration);
      const errors = await invalidRecords(this.#dataFolder, type, schema);
      const result = typeResult(type, declaration);
      if (errors.length > 0) result.problems = errors;
      return result;
    });
  }

  async #deleteType(type: string): Promise<void> {
    return this.#withWriteLock(async () => {
      if (typeof type !== "string" || !typeNamePattern.test(type)) return refuse(invalidTypeMessage);
      const declaration = await readDeclaration(this.#typeFolder, type);
      if (declaration.status !== "found") return declarationRefusal(type, declaration);
      try {
        await rmdir(join(this.#dataFolder, type));
      } catch (error) {
        // Keep the declaration whenever any stored data remains, including
        // entries that cannot be recognized or read as records.
        if (["ENOTDIR", "ENOTEMPTY", "EEXIST"].some((code) => hasCode(error, code))) {
          return refuse("type still has stored data", typeUri(type));
        }
        if (!hasCode(error, "ENOENT")) throw error;
      }
      await unlink(join(this.#typeFolder, `${type}.json`));
    });
  }

  async #getBlob(uri: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    await this.#ensureReady();
    const name = blobNameFromUri(uri);
    if (name === undefined || !await isDirectory(this.#blobFolder)) return undefined;
    const bytes = await readRegularFile(join(this.#blobFolder, name), MAX_BLOB_BYTES);
    return bytes === undefined ? undefined : { bytes, mimeType: mimeTypeForBlob(name) };
  }
}

function recordResult(type: string, key: string, declaration: TypeDefinition, stored: StoredRecord): AutofileRecord {
  const title = declaration.titleField === undefined ? undefined : stored.value[declaration.titleField];
  return {
    uri: recordUri(type, key), type, key,
    ...(typeof title === "string" ? { title } : {}),
    ...stored,
  };
}

function typeResult(type: string, definition: TypeDefinition): TypeDeclaration {
  return { uri: typeUri(type), type, ...definition };
}

function jsonText(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function snapshotSchema(schema: JsonObject): JsonObject {
  const problem = jsonObjectProblem(schema);
  if (problem !== undefined) refuse(`schema: ${problem}`);
  return JSON.parse(JSON.stringify(schema)) as JsonObject;
}

async function prepareDeclarationSchema(
  schema: JsonObject,
  uri?: string,
): Promise<PreparedSchema> {
  try {
    return await prepareSchema(schema);
  } catch (error) {
    if (error instanceof SchemaRefusal) {
      throw new AutofileError(error.messages.map((message) => ({ ...(uri === undefined ? {} : { uri }), message })));
    }
    throw error;
  }
}

async function preparedDeclarationSchema(
  declaration: TypeDefinition,
  uri?: string,
): Promise<PreparedSchema> {
  return prepareDeclarationSchema(declaration.schema, uri);
}

async function missingLinkErrors(
  dataFolder: string,
  typeFolder: string,
  schema: PreparedSchema,
  value: JsonObject,
  sourceUri?: string,
): Promise<AutofileProblem[]> {
  const errors: AutofileProblem[] = [];
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

async function missingBlobErrors(
  blobFolder: string,
  schema: PreparedSchema,
  value: JsonObject,
  uri: string,
): Promise<AutofileProblem[]> {
  const errors: AutofileProblem[] = [];
  const checked = new Map<string, string | undefined>();
  for (const field of schema.formatFields(value, "blob")) {
    if (typeof field.value !== "string") continue;
    if (!checked.has(field.value)) {
      checked.set(field.value, await blobReferenceProblem(blobFolder, field.value));
    }
    const problem = checked.get(field.value);
    if (problem !== undefined) errors.push(formatFieldError(uri, field.location, problem));
  }
  return errors;
}

function formatFieldError(uri: string, location: string, message: string): AutofileProblem {
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
    let declaration: ReadResult<TypeDefinition>;
    try {
      declaration = await readDeclaration(typeFolder, type);
    } catch (error) {
      if (!hasErrorCode(error)) throw error;
      declaration = { status: "invalid", message: "type declaration cannot be read" };
    }
    let schema: PreparedSchema | undefined;
    if (declaration.status === "found") {
      try { schema = await preparedDeclarationSchema(declaration.value, typeUri(type)); }
      catch (error) { if (!(error instanceof AutofileError)) throw error; }
    }

    let recordEntries;
    try {
      recordEntries = await recognizedRecordEntries(join(dataFolder, type));
    } catch (error) {
      if (hasErrorCode(error)) return undefined;
      throw error;
    }
    for (const entry of recordEntries) {
      let record: ReadResult<unknown>;
      try {
        record = await readJson(join(dataFolder, type, entry.name), "record");
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
): Promise<TypeDefinition | undefined> {
  const result = await readDeclaration(typeFolder, type);
  if (result.status !== "found") return undefined;
  try {
    await prepareSchema(result.value.schema);
  } catch (error) {
    if (error instanceof SchemaRefusal) return undefined;
    throw error;
  }
  return result.value;
}

async function invalidRecords(
  dataFolder: string,
  type: string,
  schema: PreparedSchema,
): Promise<AutofileProblem[]> {
  const errors: AutofileProblem[] = [];
  const entries = await recognizedRecordEntries(join(dataFolder, type));
  for (const entry of entries) {
    const key = entry.name.slice(0, -".json".length);
    const uri = recordUri(type, key);
    let record: ReadResult<StoredRecord>;
    try {
      record = await readStoredRecord(join(dataFolder, type, entry.name));
    } catch (error) {
      errors.push({ uri, message: recordReadError(error) });
      continue;
    }
    if (record.status !== "found") {
      errors.push({ uri, message: record.status === "invalid" ? record.message : "record does not exist" });
      continue;
    }
    const validationErrors = await schema.validate(record.value.value);
    if (validationErrors.length > 0) errors.push({ uri, message: validationErrors.join("; ") });
  }
  return errors;
}

async function readDeclaration(folder: string, type: string): Promise<ReadResult<TypeDefinition>> {
  if (!await isDirectory(folder)) return { status: "missing" };
  const result = await readJson(join(folder, `${type}.json`), "type declaration");
  if (result.status !== "found") return result;
  if (!isTypeDefinition(result.value)) {
    return { status: "invalid", message: "type declaration is not valid" };
  }
  return { status: "found", value: result.value };
}

async function readStoredRecord(path: string): Promise<ReadResult<StoredRecord>> {
  if (!await isDirectory(dirname(path))) return { status: "missing" };
  const result = await readJson(path, "record");
  if (result.status !== "found") return result;
  if (!isStoredRecord(result.value)) {
    return { status: "invalid", message: "record is not valid" };
  }
  return { status: "found", value: result.value };
}

async function readJson(path: string, label: string): Promise<ReadResult<unknown>> {
  const bytes = await readRegularFile(path);
  if (bytes === undefined) return { status: "missing" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { status: "found", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "invalid", message: `${label} is unavailable` };
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}`);
  const text = jsonText(value);
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
  if (typeof uri !== "string") return undefined;
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

function decodeRecordCursor(cursor: string, types?: string[]): string | undefined {
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
  return record !== undefined && (types === undefined || types.includes(record.type)) ? uri : undefined;
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

function recordReadError(_error: unknown): string {
  return "record is unavailable";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reportSubscriptionError(subscription: ChangeSubscription, error: Error): void {
  if (subscription.onError === undefined) process.emitWarning(error);
  else {
    try { subscription.onError(error); }
    catch (failure) { process.emitWarning(toError(failure)); }
  }
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

function refuse(message: string, uri?: string): never {
  throw new AutofileError([{ ...(uri === undefined ? {} : { uri }), message }]);
}

function declarationRefusal(type: string, result: ReadResult<TypeDefinition>): never {
  const uri = typeUri(type);
  if (result.status === "missing") return refuse("type does not exist", uri);
  if (result.status === "invalid") return refuse(result.message, uri);
  throw new Error("A found declaration is not a refusal");
}

function recordReadRefusal(uri: string, result: ReadResult<StoredRecord>): never {
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

function isTypeDefinition(value: unknown): value is TypeDefinition {
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
