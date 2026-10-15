/** Exercises Autofile's MCP surface through a modern in-process client. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildServer } from "../dist/server.js";
import { openStore, type Store } from "../dist/store.js";

const roots: string[] = [];
const connections: TestConnection[] = [];
const serverDescription = "Typed records that agents file and retrieve, kept as JSON files in a folder the user owns.";
const instructions = "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.";
const taskSchema = {
  type: "object",
  required: ["title", "status"],
  properties: {
    title: { type: "string" },
    status: { type: "string", enum: ["active", "complete"] },
  },
  additionalProperties: false,
};

interface TestStore {
  dataFolder: string;
  store: Store;
}

interface TestConnection {
  client: Client;
  close(): Promise<void>;
}

async function makeStore(): Promise<TestStore> {
  const root = await mkdtemp(join(tmpdir(), "autofile-server-"));
  roots.push(root);
  const dataFolder = join(root, "data");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(root, "autofile-home", "write.lock"),
  });
  return { dataFolder, store };
}

async function connect(store: Store): Promise<Client> {
  const handler = createMcpHandler(() => buildServer(store), { legacy: "reject" });
  const transport = new StreamableHTTPClientTransport(new URL("http://autofile.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "autofile-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  connections.push({
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  });
  return client;
}

function assertToolJson(
  result: CallToolResult,
  expected: unknown,
  options: { isError?: boolean } = {},
): void {
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.ok(content !== undefined && content.type === "text");
  assert.deepEqual(JSON.parse(content.text) as unknown, expected);
  if (options.isError === true) assert.equal(result.isError, true);
  else assert.notEqual(result.isError, true);
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function createTasksType(store: Store): Promise<void> {
  assert.deepEqual(await store.createType({
    type: "tasks",
    description: "Things to do.",
    titleField: "title",
    schema: taskSchema,
  }), { uri: "autofile:///_types/tasks" });
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
});

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("discovery sends the package version, exact description, capabilities, and build-time type instructions", async () => {
  const empty = await makeStore();
  const emptyClient = await connect(empty.store);
  const packageJson = asObject(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as unknown);

  assert.equal(emptyClient.getServerVersion()?.version, packageJson.version);
  assert.equal(emptyClient.getServerVersion()?.description, serverDescription);
  assert.deepEqual(emptyClient.getServerCapabilities()?.resources, {
    subscribe: true,
    listChanged: true,
  });
  assert.equal(
    emptyClient.getInstructions(),
    `${instructions}\n\nTypes: none yet. This list was taken when the session began; call \`list_types\` for types created since.`,
  );

  const populated = await makeStore();
  for (const type of ["tasks", "contacts", "organizations"]) {
    await populated.store.createType({
      type,
      description: `${type} description`,
      schema: { type: "object" },
    });
  }
  const populatedClient = await connect(populated.store);
  assert.equal(
    populatedClient.getInstructions(),
    `${instructions}\n\nTypes: contacts, organizations, tasks. This list was taken when the session began; call \`list_types\` for types created since.`,
  );

  const resources = populatedClient.getServerCapabilities()?.resources;
  assert.deepEqual(resources, { subscribe: true, listChanged: true });
});

test("tools are listed in spec order with exact descriptions and described closed JSON Schemas", async () => {
  const { store } = await makeStore();
  const client = await connect(store);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), [
    {
      name: "find_records",
      description: "Searches the records of one type and returns matching records in URI order. It reads past nonmatching files until the page has `limit` results, reaches 64 KB of JSON, or no files remain; the size cap never prevents the first result. `fields` selects top-level fields to return, while matching uses the whole record. A schema-invalid record is listed in `errors` only when it matches the search; a file that cannot be read or parsed as JSON is always listed. Autofile is where the user keeps durable information.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The type to search." },
          q: {
            type: "string",
            description: "Words that must all appear, ignoring case, in the string values of a record at any depth.",
          },
          where: {
            type: "object",
            description: "Fields to match by value using MongoDB query syntax. An array field matches when any item equals the value, and `null` also matches a missing field. Keys starting with `$`, and the keys `__proto__`, `constructor` and `prototype`, are not supported at any depth or in dotted paths.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 50,
            description: "The most results the page returns, counting records and entries in `errors`. From 1 to 200; defaults to 50.",
          },
          fields: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Top-level fields to return in `value`. All fields are returned when absent; matching still uses the whole record.",
          },
          cursor: {
            type: "string",
            description: "An opaque cursor returned by the previous page. The next page starts after the last record file that page read, even if that file was deleted.",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
    {
      name: "get_record",
      description: "Returns one record by URI: its `uri`, `createdAt` and `updatedAt` times, and `value`. A record that does not match its type is still returned, with what must change in `error`.",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string", description: "The URI of the record." } },
        required: ["uri"],
        additionalProperties: false,
      },
    },
    {
      name: "create_record",
      description: "Creates a record and returns its URI. `record` is the full record and must match the schema of its type, which `get_type` returns. `key` is optional and generated when absent. Autofile is where the user keeps durable information.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The type of the record." },
          key: {
            type: "string",
            description: "The key of the new record: lowercase letters, digits and hyphens, starting with a letter or digit. Generated when absent.",
          },
          record: {
            type: "object",
            description: "The full record, which must match the schema of its type. A blob field may hold the absolute path of a local file or a `data:` URI with base64 contents; Autofile stores the file and puts its blob URI in the field.",
          },
        },
        required: ["type", "record"],
        additionalProperties: false,
      },
    },
    {
      name: "update_record",
      description: "Changes a record and returns its URI.",
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "The URI of the record." },
          patch: {
            type: "object",
            description: "A [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396): fields in the patch are set, a field set to `null` is removed, nested objects are merged, and arrays are replaced whole. A blob field may hold the absolute path of a local file or a `data:` URI with base64 contents; Autofile stores the file and puts its blob URI in the field.",
          },
        },
        required: ["uri", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_record",
      description: "Deletes a record, removes the links to it from other records, and returns its URI.",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string", description: "The URI of the record." } },
        required: ["uri"],
        additionalProperties: false,
      },
    },
    {
      name: "list_types",
      description: "Returns every type, ordered by name, with the URI of its declaration, its description, and its `title` and `titlePlural` when it has them.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_type",
      description: "Returns the declaration of a type with its URI added.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", description: "The name of the type." } },
        required: ["type"],
        additionalProperties: false,
      },
    },
    {
      name: "create_type",
      description: "Declares a type and returns the URI of its declaration.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The name of the type." },
          description: { type: "string", description: "What belongs in the folder." },
          schema: { type: "object", description: "The JSON Schema for records of the type." },
          titleField: {
            type: "string",
            description: "A top-level field of the record whose string value is shown as its title.",
          },
          title: {
            type: "string",
            description: "The name of the type in words, in the singular, such as \"Journal entry\", shown to people in place of the type name.",
          },
          titlePlural: {
            type: "string",
            description: "The plural of title, such as \"Journal entries\", shown where records of the type are named together. Clients add \"s\" to title when it is absent.",
          },
        },
        required: ["type", "description", "schema"],
        additionalProperties: false,
      },
    },
    {
      name: "update_type",
      description: "Replaces the description, schema, title field, title or plural title of a type, or any of them.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The name of the type." },
          description: { type: "string", description: "The new description." },
          schema: { type: "object", description: "The new JSON Schema." },
          titleField: {
            type: ["string", "null"],
            description: "The new title field; `null` removes it.",
          },
          title: {
            type: ["string", "null"],
            description: "The new title; `null` removes it.",
          },
          titlePlural: {
            type: ["string", "null"],
            description: "The new plural title; `null` removes it.",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_type",
      description: "Deletes a type and returns its URI.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", description: "The name of the type." } },
        required: ["type"],
        additionalProperties: false,
      },
    },
  ]);
  for (const tool of tools) {
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    const properties = asObject(tool.inputSchema.properties ?? {});
    for (const argument of Object.values(properties)) {
      const argumentSchema = asObject(argument);
      assert.ok(
        typeof argumentSchema.description === "string" && argumentSchema.description.length > 0,
      );
    }
  }
});

test("all ten tools map store results to matching structured and text JSON", async () => {
  const { store } = await makeStore();
  const client = await connect(store);

  const createdType = await client.callTool({
    name: "create_type",
    arguments: {
      type: "tasks",
      description: "Things to do.",
      title: "Task",
      titlePlural: "Tasks",
      titleField: "title",
      schema: taskSchema,
    },
  });
  assertToolJson(createdType, { uri: "autofile:///_types/tasks" });

  const listedTypes = await client.callTool({ name: "list_types", arguments: {} });
  assertToolJson(listedTypes, {
    types: [{
      uri: "autofile:///_types/tasks",
      type: "tasks",
      description: "Things to do.",
      title: "Task",
      titlePlural: "Tasks",
    }],
  });

  const gotType = await client.callTool({ name: "get_type", arguments: { type: "tasks" } });
  assertToolJson(gotType, {
    uri: "autofile:///_types/tasks",
    description: "Things to do.",
    title: "Task",
    titlePlural: "Tasks",
    titleField: "title",
    schema: taskSchema,
  });

  const createdRecord = await client.callTool({
    name: "create_record",
    arguments: {
      type: "tasks",
      key: "book-dentist",
      record: { title: "Book dentist", status: "active" },
    },
  });
  assertToolJson(createdRecord, { uri: "autofile:///tasks/book-dentist" });

  const foundRecords = await client.callTool({
    name: "find_records",
    arguments: {
      type: "tasks",
      q: "active",
      where: { status: "active" },
      fields: ["title", "unknown"],
    },
  });
  const found = asObject(foundRecords.structuredContent);
  assert.ok(Array.isArray(found.records));
  assert.equal(found.records.length, 1);
  assert.equal(asObject(found.records[0]).uri, "autofile:///tasks/book-dentist");
  assert.deepEqual(asObject(found.records[0]).value, { title: "Book dentist" });
  assert.deepEqual(found.errors, []);
  assertToolJson(foundRecords, found);

  const gotRecord = await client.callTool({
    name: "get_record",
    arguments: { uri: "autofile:///tasks/book-dentist" },
  });
  const record = asObject(gotRecord.structuredContent);
  assert.equal(record.uri, "autofile:///tasks/book-dentist");
  assert.deepEqual(record.value, { title: "Book dentist", status: "active" });
  assert.equal(typeof record.createdAt, "string");
  assert.equal(record.updatedAt, record.createdAt);
  assertToolJson(gotRecord, record);

  const updatedRecord = await client.callTool({
    name: "update_record",
    arguments: {
      uri: "autofile:///tasks/book-dentist",
      patch: { status: "complete" },
    },
  });
  assertToolJson(updatedRecord, { uri: "autofile:///tasks/book-dentist" });

  const updatedType = await client.callTool({
    name: "update_type",
    arguments: {
      type: "tasks",
      description: "Completed and active tasks.",
      title: "To-do",
      titlePlural: null,
    },
  });
  assertToolJson(updatedType, { uri: "autofile:///_types/tasks", errors: [] });

  const gotUpdatedType = await client.callTool({
    name: "get_type",
    arguments: { type: "tasks" },
  });
  assertToolJson(gotUpdatedType, {
    uri: "autofile:///_types/tasks",
    description: "Completed and active tasks.",
    title: "To-do",
    titleField: "title",
    schema: taskSchema,
  });

  const deletedRecord = await client.callTool({
    name: "delete_record",
    arguments: { uri: "autofile:///tasks/book-dentist" },
  });
  assertToolJson(deletedRecord, { uri: "autofile:///tasks/book-dentist" });

  const deletedType = await client.callTool({ name: "delete_type", arguments: { type: "tasks" } });
  assertToolJson(deletedType, { uri: "autofile:///_types/tasks" });
});

test("find_records returns complete records and error-only pages as successful results", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "book-dentist",
    record: { title: "Book dentist", status: "active" },
  });
  await writeFile(join(dataFolder, "tasks", "a-broken.json"), "{\n");
  const stored = await store.getRecord({ uri: "autofile:///tasks/book-dentist" });
  assert.ok("value" in stored);
  const client = await connect(store);

  const errorOnlyPage = await client.callTool({
    name: "find_records",
    arguments: { type: "tasks", limit: 1 },
  });
  const errorOnlyBody = asObject(errorOnlyPage.structuredContent);
  assert.equal(typeof errorOnlyBody.cursor, "string");
  assertToolJson(errorOnlyPage, {
    records: [],
    errors: [{
      uri: "autofile:///tasks/a-broken",
      message: "record file cannot be read as JSON",
    }],
    cursor: errorOnlyBody.cursor,
  });

  const recordPage = await client.callTool({
    name: "find_records",
    arguments: { type: "tasks", cursor: errorOnlyBody.cursor },
  });
  assertToolJson(recordPage, {
    records: [{
      uri: stored.uri,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      value: stored.value,
    }],
    errors: [],
  });

  assert.deepEqual(errorOnlyBody.errors, [{
    uri: "autofile:///tasks/a-broken",
    message: "record file cannot be read as JSON",
  }]);

  const refusals = [
    [{ type: "tasks", where: { status: { $in: ["active"] } } }, {
      errors: [{ message: "where: the operator $in is not supported" }],
    }],
    [{ type: "tasks", cursor: "not-a-cursor" }, {
      errors: [{ message: "cursor: is invalid" }],
    }],
  ] as const;
  for (const [argumentsValue, expected] of refusals) {
    const refusal = await client.callTool({ name: "find_records", arguments: argumentsValue });
    assertToolJson(refusal, expected, { isError: true });
  }
});

test("find_records enforces byte-capped paging through MCP", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "entries",
    description: "Long entries.",
    schema: {
      type: "object",
      required: ["body"],
      properties: { body: { type: "string" } },
      additionalProperties: false,
    },
  });
  for (const key of ["a", "b", "c"]) {
    await store.createRecord({
      type: "entries",
      key,
      record: { body: `${key}${"🙂".repeat(9_000)}` },
    });
  }
  const client = await connect(store);

  const uris: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.callTool({
      name: "find_records",
      arguments: { type: "entries", limit: 200, ...(cursor === undefined ? {} : { cursor }) },
    });
    const page = asObject(result.structuredContent);
    assert.ok(Array.isArray(page.records));
    assert.ok(Array.isArray(page.errors));
    assert.equal(page.records.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify({
      records: page.records,
      errors: page.errors,
    }), "utf8") <= 64 * 1024);
    uris.push(...page.records.map((record) => String(asObject(record).uri)));
    cursor = typeof page.cursor === "string" ? page.cursor : undefined;
    assertToolJson(result, page);
  } while (cursor !== undefined);

  assert.deepEqual(uris, [
    "autofile:///entries/a",
    "autofile:///entries/b",
    "autofile:///entries/c",
  ]);
});

test("tool refusals are errors, accepted type changes with record errors are not", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "unfinished",
    record: { title: "Unfinished", status: "active" },
  });
  const client = await connect(store);

  const refused = await client.callTool({
    name: "get_record",
    arguments: { uri: "autofile:///tasks/missing" },
  });
  assertToolJson(refused, {
    errors: [{ uri: "autofile:///tasks/missing", message: "record does not exist" }],
  }, { isError: true });

  const accepted = await client.callTool({
    name: "update_type",
    arguments: {
      type: "tasks",
      schema: {
        type: "object",
        required: ["title", "status"],
        properties: {
          title: { type: "string" },
          status: { const: "complete" },
        },
        additionalProperties: false,
      },
    },
  });
  const acceptedBody = asObject(accepted.structuredContent);
  assert.equal(acceptedBody.uri, "autofile:///_types/tasks");
  assert.ok(Array.isArray(acceptedBody.errors));
  assert.equal(acceptedBody.errors.length, 1);
  assert.deepEqual(asObject(acceptedBody.errors[0]).uri, "autofile:///tasks/unfinished");
  assertToolJson(accepted, acceptedBody);
  assert.notEqual(accepted.isError, true);
});

test("record link writes and deletes return their results and refusals through MCP", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "sources",
    description: "Optional links.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        target: { type: "string", format: "uri" },
      },
      additionalProperties: false,
    },
  });
  await store.createType({
    type: "blockers",
    description: "Required links.",
    schema: {
      type: "object",
      required: ["target"],
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  const targetUri = "autofile:///targets/one";
  const sourceUri = "autofile:///sources/one";
  const blockerUri = "autofile:///blockers/one";
  const missingUri = "autofile:///targets/missing";
  await store.createRecord({ type: "targets", key: "one", record: {} });
  await store.createRecord({
    type: "sources",
    key: "one",
    record: { name: "Source", target: targetUri },
  });
  await store.createRecord({
    type: "blockers",
    key: "one",
    record: { target: targetUri },
  });
  const client = await connect(store);

  const refusedCreate = await client.callTool({
    name: "create_record",
    arguments: {
      type: "sources",
      key: "dangling",
      record: { name: "Dangling", target: missingUri },
    },
  });
  assertToolJson(refusedCreate, {
    errors: [{
      uri: "autofile:///sources/dangling",
      message: `target: links to a record that does not exist: ${missingUri}`,
    }],
  }, { isError: true });

  const beforeUpdate = await client.callTool({
    name: "get_record",
    arguments: { uri: sourceUri },
  });
  const beforeUpdateBody = asObject(beforeUpdate.structuredContent);
  const refusedUpdate = await client.callTool({
    name: "update_record",
    arguments: { uri: sourceUri, patch: { target: missingUri } },
  });
  assertToolJson(refusedUpdate, {
    errors: [{
      uri: sourceUri,
      message: `target: links to a record that does not exist: ${missingUri}`,
    }],
  }, { isError: true });
  const afterUpdate = await client.callTool({
    name: "get_record",
    arguments: { uri: sourceUri },
  });
  assertToolJson(afterUpdate, beforeUpdateBody);

  const refusedDelete = await client.callTool({
    name: "delete_record",
    arguments: { uri: targetUri },
  });
  assertToolJson(refusedDelete, {
    errors: [{ uri: blockerUri, message: "missing required property: target" }],
  }, { isError: true });

  const removedBlocker = await client.callTool({
    name: "delete_record",
    arguments: { uri: blockerUri },
  });
  assertToolJson(removedBlocker, { uri: blockerUri });
  const deletedTarget = await client.callTool({
    name: "delete_record",
    arguments: { uri: targetUri },
  });
  assertToolJson(deletedTarget, { uri: targetUri });

  const sourceAfterDelete = await client.callTool({
    name: "get_record",
    arguments: { uri: sourceUri },
  });
  const sourceAfterDeleteBody = asObject(sourceAfterDelete.structuredContent);
  assert.deepEqual(sourceAfterDeleteBody.value, { name: "Source" });
  assertToolJson(sourceAfterDelete, sourceAfterDeleteBody);

  const malformedTargetUri = "autofile:///targets/malformed";
  const malformedBlockerUri = "autofile:///blockers/malformed";
  const malformedTargetPath = join(dataFolder, "targets", "malformed.json");
  const malformedBlockerPath = join(dataFolder, "blockers", "malformed.json");
  await store.createRecord({ type: "targets", key: "malformed", record: {} });
  await store.createRecord({
    type: "blockers",
    key: "malformed",
    record: { target: malformedTargetUri },
  });
  await writeFile(malformedTargetPath, "{\n");
  const filesBeforeMalformedDelete = await Promise.all([
    readFile(malformedTargetPath, "utf8"),
    readFile(malformedBlockerPath, "utf8"),
  ]);

  const refusedMalformedDelete = await client.callTool({
    name: "delete_record",
    arguments: { uri: malformedTargetUri },
  });
  assertToolJson(refusedMalformedDelete, {
    errors: [
      { uri: malformedBlockerUri, message: "missing required property: target" },
      { uri: malformedTargetUri, message: "record file cannot be read as JSON" },
    ],
  }, { isError: true });
  assert.deepEqual(await Promise.all([
    readFile(malformedTargetPath, "utf8"),
    readFile(malformedBlockerPath, "utf8"),
  ]), filesBeforeMalformedDelete);
});

test("tool argument objects reject additional properties before calling the store", async () => {
  const { store } = await makeStore();
  const client = await connect(store);

  const rejected = await client.callTool({
    name: "list_types",
    arguments: { unexpected: true },
  });

  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent, undefined);
  assert.equal(rejected.content.length, 1);
  assert.equal(rejected.content[0]?.type, "text");
});

test("resources list every stored kind in URI order with their exact metadata", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.updateType({ type: "tasks", title: "Task" });
  await store.createRecord({
    type: "tasks",
    key: "book-dentist",
    record: { title: "Book dentist", status: "active" },
  });
  const storedRecord = await store.getRecord({ uri: "autofile:///tasks/book-dentist" });
  assert.ok("updatedAt" in storedRecord);
  const blobName = `${"a".repeat(64)}.pdf`;
  const blob = Buffer.from("%PDF-1.7\nAutofile test\n", "utf8");
  const unknownBlobName = `${"c".repeat(64)}.madeup`;
  const unknownBlob = Buffer.from("unknown media type\n", "utf8");
  await mkdir(join(dataFolder, "_blobs"), { recursive: true });
  await Promise.all([
    writeFile(join(dataFolder, "_blobs", blobName), blob),
    writeFile(join(dataFolder, "_blobs", unknownBlobName), unknownBlob),
  ]);
  const client = await connect(store);

  const result = await client.listResources();
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, "private");
  assert.deepEqual(result.resources, [
    {
      uri: `autofile:///_blobs/${blobName}`,
      name: `_blobs/${blobName}`,
      mimeType: "application/pdf",
      size: blob.byteLength,
    },
    {
      uri: `autofile:///_blobs/${unknownBlobName}`,
      name: `_blobs/${unknownBlobName}`,
      mimeType: "application/octet-stream",
      size: unknownBlob.byteLength,
    },
    {
      uri: "autofile:///_types/tasks",
      name: "_types/tasks",
      title: "Task",
      mimeType: "application/json",
      description: "Things to do.",
    },
    {
      uri: "autofile:///tasks/book-dentist",
      name: "tasks/book-dentist",
      title: "Book dentist",
      mimeType: "application/json",
      annotations: { lastModified: storedRecord.updatedAt },
    },
  ]);
});

test("resources/list pages after a deleted cursor URI and rejects invalid cursors with -32602", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "items",
    description: "Paging fixtures.",
    titleField: "name",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  });
  const timestamp = "2026-10-07T09:14:00Z";
  await Promise.all(Array.from({ length: 205 }, async (_, index) => {
    const key = `item-${String(index).padStart(3, "0")}`;
    await writeFile(join(dataFolder, "items", `${key}.json`), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { name: `Item ${String(index)}` },
    }, null, 2)}\n`);
  }));
  const client = await connect(store);

  let cursor: string | undefined;
  let pages = 0;
  let deletedCursorUri: string | undefined;
  const uris: string[] = [];
  do {
    const page = await client.request({
      method: "resources/list",
      ...(cursor === undefined ? {} : { params: { cursor } }),
    });
    pages += 1;
    assert.ok(pages < 20, "resources/list cursor did not advance");
    assert.equal(page.ttlMs, 0);
    assert.equal(page.cacheScope, "private");
    assert.ok(page.resources.length > 0);
    if (pages === 1) {
      const lastResource = page.resources.at(-1);
      assert.ok(lastResource !== undefined && lastResource.uri.startsWith("autofile:///items/"));
      deletedCursorUri = lastResource.uri;
      assert.deepEqual(await store.deleteRecord({ uri: deletedCursorUri }), { uri: deletedCursorUri });
    } else if (pages === 2) {
      assert.ok(deletedCursorUri !== undefined);
      const firstResource = page.resources[0];
      assert.ok(firstResource !== undefined && firstResource.uri > deletedCursorUri);
    }
    uris.push(...page.resources.map(({ uri }) => uri));
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  assert.ok(pages > 1);
  assert.equal(uris.length, 206);
  assert.deepEqual(uris, [...uris].sort());

  await assert.rejects(
    client.request({ method: "resources/list", params: { cursor: "not-a-valid-cursor" } }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, -32602);
      return true;
    },
  );
  const nonResourceCursor = Buffer.from("not a resource URI", "utf8").toString("base64url");
  await assert.rejects(
    client.request({ method: "resources/list", params: { cursor: nonResourceCursor } }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, -32602);
      return true;
    },
  );
});

test("resources/read returns exact stored text, blob bytes, cache fields, and not-found errors", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "book-dentist",
    record: { title: "Book dentist", status: "active" },
  });
  const blobName = `${"b".repeat(64)}.pdf`;
  const blob = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
  await mkdir(join(dataFolder, "_blobs"), { recursive: true });
  await writeFile(join(dataFolder, "_blobs", blobName), blob);
  const [declarationText, recordText] = await Promise.all([
    readFile(join(dataFolder, "_types", "tasks.json"), "utf8"),
    readFile(join(dataFolder, "tasks", "book-dentist.json"), "utf8"),
  ]);
  const client = await connect(store);

  const declaration = await client.readResource({ uri: "autofile:///_types/tasks" });
  assert.deepEqual({
    contents: declaration.contents,
    ttlMs: declaration.ttlMs,
    cacheScope: declaration.cacheScope,
  }, {
    contents: [{
      uri: "autofile:///_types/tasks",
      mimeType: "application/json",
      text: declarationText,
    }],
    ttlMs: 0,
    cacheScope: "private",
  });

  const record = await client.readResource({ uri: "autofile:///tasks/book-dentist" });
  assert.deepEqual({
    contents: record.contents,
    ttlMs: record.ttlMs,
    cacheScope: record.cacheScope,
  }, {
    contents: [{
      uri: "autofile:///tasks/book-dentist",
      mimeType: "application/json",
      text: recordText,
    }],
    ttlMs: 0,
    cacheScope: "private",
  });

  const readBlob = await client.readResource({ uri: `autofile:///_blobs/${blobName}` });
  assert.deepEqual({
    contents: readBlob.contents,
    ttlMs: readBlob.ttlMs,
    cacheScope: readBlob.cacheScope,
  }, {
    contents: [{
      uri: `autofile:///_blobs/${blobName}`,
      mimeType: "application/pdf",
      blob: blob.toString("base64"),
    }],
    ttlMs: 0,
    cacheScope: "private",
  });

  await assert.rejects(
    client.readResource({ uri: "autofile:///tasks/missing" }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, -32602);
      return true;
    },
  );
});
