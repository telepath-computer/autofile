/**
 * Builds Autofile's transport-independent MCP server. The store owns all
 * persistence semantics; this module only describes the protocol surface and
 * translates plain store values into MCP results.
 */

import { createRequire } from "node:module";

import {
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  type CallToolResult,
  type ListResourcesResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";

import {
  isResourceUri,
  type CreateRecordInput,
  type CreateTypeInput,
  type DeleteRecordInput,
  type DeleteTypeInput,
  type FindRecordsInput,
  type GetRecordInput,
  type GetTypeInput,
  type JsonObject,
  type Store,
  type UpdateRecordInput,
  type UpdateTypeInput,
} from "./store.js";

const SERVER_DESCRIPTION = "Typed records that agents file and retrieve, kept as JSON files in a folder the user owns.";
const BASE_INSTRUCTIONS = "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.";
const RESOURCE_PAGE_SIZE = 100;
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

const findRecordsSchema = fromJsonSchema<FindRecordsInput>({
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
});
const getRecordSchema = fromJsonSchema<GetRecordInput>({
  type: "object",
  properties: { uri: { type: "string", description: "The URI of the record." } },
  required: ["uri"],
  additionalProperties: false,
});
const createRecordSchema = fromJsonSchema<CreateRecordInput>({
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
});
const updateRecordSchema = fromJsonSchema<UpdateRecordInput>({
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
});
const deleteRecordSchema = fromJsonSchema<DeleteRecordInput>({
  type: "object",
  properties: { uri: { type: "string", description: "The URI of the record." } },
  required: ["uri"],
  additionalProperties: false,
});
const listTypesSchema = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});
const getTypeSchema = fromJsonSchema<GetTypeInput>({
  type: "object",
  properties: { type: { type: "string", description: "The name of the type." } },
  required: ["type"],
  additionalProperties: false,
});
const createTypeSchema = fromJsonSchema<CreateTypeInput>({
  type: "object",
  properties: {
    type: { type: "string", description: "The name of the type." },
    description: { type: "string", description: "What belongs in the folder." },
    schema: { type: "object", description: "The JSON Schema for records of the type." },
    titleField: {
      type: "string",
      description: "A top-level field of the record whose string value is shown as its title.",
    },
    view: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "The top-level field containing the main prose in Markdown.",
        },
        panel: {
          type: "array",
          items: { type: "string" },
          description: "The top-level fields shown in the panel, in order.",
        },
      },
      additionalProperties: false,
      description: "How clients lay out a record: `body` names the top-level prose field and `panel` lists top-level panel fields in order.",
    },
  },
  required: ["type", "description", "schema"],
  additionalProperties: false,
});
const updateTypeSchema = fromJsonSchema<UpdateTypeInput>({
  type: "object",
  properties: {
    type: { type: "string", description: "The name of the type." },
    description: { type: "string", description: "The new description." },
    schema: { type: "object", description: "The new JSON Schema." },
    titleField: {
      type: ["string", "null"],
      description: "The new title field; `null` removes it.",
    },
    view: {
      type: ["object", "null"],
      properties: {
        body: {
          type: "string",
          description: "The top-level field containing the main prose in Markdown.",
        },
        panel: {
          type: "array",
          items: { type: "string" },
          description: "The top-level fields shown in the panel, in order.",
        },
      },
      additionalProperties: false,
      description: "The new view; `null` removes it.",
    },
  },
  required: ["type"],
  additionalProperties: false,
});
const deleteTypeSchema = fromJsonSchema<DeleteTypeInput>({
  type: "object",
  properties: { type: { type: "string", description: "The name of the type." } },
  required: ["type"],
  additionalProperties: false,
});

/** Builds one MCP server around a store, without choosing its transport. */
export async function buildServer(store: Store): Promise<McpServer> {
  const { types } = await store.listTypes({});
  const typeNames = types.map(({ type }) => type).sort();
  const typeSummary = typeNames.length === 0 ? "none yet" : typeNames.join(", ");
  const server = new McpServer(
    {
      name: "autofile",
      version: packageJson.version,
      description: SERVER_DESCRIPTION,
    },
    {
      instructions: `${BASE_INSTRUCTIONS}\n\nTypes: ${typeSummary}. This list was taken when the session began; call \`list_types\` for types created since.`,
    },
  );

  server.registerTool(
    "find_records",
    {
      description: "Searches the records of one type and returns matching records in URI order. It reads past nonmatching files until the page has `limit` results, reaches 64 KB of JSON, or no files remain; the size cap never prevents the first result. `fields` selects top-level fields to return, while matching uses the whole record. A schema-invalid record is listed in `errors` only when it matches the search; a file that cannot be read or parsed as JSON is always listed. Autofile is where the user keeps durable information.",
      inputSchema: findRecordsSchema,
    },
    async (input) => toolResult(await store.findRecords(input)),
  );
  server.registerTool(
    "get_record",
    {
      description: "Returns one record by URI: its `uri`, `createdAt` and `updatedAt` times, and `value`. A record that does not match its type is still returned, with what must change in `error`.",
      inputSchema: getRecordSchema,
    },
    async (input) => toolResult(await store.getRecord(input)),
  );
  server.registerTool(
    "create_record",
    {
      description: "Creates a record and returns its URI. `record` is the full record and must match the schema of its type, which `get_type` returns. `key` is optional and generated when absent. Autofile is where the user keeps durable information.",
      inputSchema: createRecordSchema,
    },
    async (input, context) => toolResult(await store.createRecord(input, {
      allowLocalPaths: context.http === undefined,
    })),
  );
  server.registerTool(
    "update_record",
    { description: "Changes a record and returns its URI.", inputSchema: updateRecordSchema },
    async (input, context) => toolResult(await store.updateRecord(input, {
      allowLocalPaths: context.http === undefined,
    })),
  );
  server.registerTool(
    "delete_record",
    {
      description: "Deletes a record, removes the links to it from other records, and returns its URI.",
      inputSchema: deleteRecordSchema,
    },
    async (input) => toolResult(await store.deleteRecord(input)),
  );
  server.registerTool(
    "list_types",
    {
      description: "Returns every type, ordered by name, with the URI of its declaration and its description.",
      inputSchema: listTypesSchema,
    },
    async (input) => toolResult(await store.listTypes(input)),
  );
  server.registerTool(
    "get_type",
    { description: "Returns the declaration of a type with its URI added.", inputSchema: getTypeSchema },
    async (input) => toolResult(await store.getType(input)),
  );
  server.registerTool(
    "create_type",
    { description: "Declares a type and returns the URI of its declaration.", inputSchema: createTypeSchema },
    async (input) => toolResult(await store.createType(input)),
  );
  server.registerTool(
    "update_type",
    {
      description: "Replaces the description, schema, title field or view of a type, or any of them.",
      inputSchema: updateTypeSchema,
    },
    async (input) => toolResult(await store.updateType(input)),
  );
  server.registerTool(
    "delete_type",
    { description: "Deletes a type and returns its URI.", inputSchema: deleteTypeSchema },
    async (input) => toolResult(await store.deleteType(input)),
  );

  // The high-level resource API returns every resource at once. These
  // handlers stay at the low-level boundary where cursors remain explicit;
  // the process-level watcher supplies the advertised change notices.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler("resources/list", async (request): Promise<ListResourcesResult> => {
    const resources = await store.listResources();
    const cursor = request.params?.cursor;
    let start = 0;
    if (cursor !== undefined) {
      const previousUri = decodeCursor(cursor);
      if (previousUri === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid resource cursor");
      }
      const nextIndex = resources.findIndex(({ uri }) => uri > previousUri);
      start = nextIndex < 0 ? resources.length : nextIndex;
    }

    const page = resources.slice(start, start + RESOURCE_PAGE_SIZE);
    const last = page.at(-1);
    return {
      resources: page.map(({ lastModified, ...resource }) => ({
        ...resource,
        ...(lastModified === undefined ? {} : { annotations: { lastModified } }),
      })),
      ...(last !== undefined && start + page.length < resources.length
        ? { nextCursor: encodeCursor(last.uri) }
        : {}),
      ttlMs: 0,
      cacheScope: "private",
    };
  });

  server.server.setRequestHandler("resources/read", async (request): Promise<ReadResourceResult> => {
    const contents = await store.readResource(request.params.uri);
    if (contents === undefined) throw new ResourceNotFoundError(request.params.uri);
    return { contents: [contents], ttlMs: 0, cacheScope: "private" };
  });

  return server;
}

function toolResult(result: object): CallToolResult {
  const body = result as JsonObject;
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    ...("errors" in body && !("uri" in body) && !("records" in body) ? { isError: true } : {}),
  };
}

function encodeCursor(uri: string): string {
  return Buffer.from(uri, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return undefined;
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) return undefined;
  try {
    const uri = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isResourceUri(uri) ? uri : undefined;
  } catch {
    return undefined;
  }
}
