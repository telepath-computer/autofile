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
  buildTools,
  type CreateRecordInput,
  type CreateTypeInput,
  type DeleteRecordInput,
  type DeleteTypeInput,
  type FindRecordsInput,
  type GetRecordInput,
  type GetTypeInput,
  type UpdateRecordInput,
  type UpdateTypeInput,
  type UploadBlobInput,
} from "./mcp-tools.js";
import { buildResources, isResourceUri, type ResourceOptions } from "./mcp-resources.js";
import type { Autofile, JsonObject } from "./index.js";

const SERVER_DESCRIPTION = "Typed records that agents file and retrieve.";
const BASE_INSTRUCTIONS = "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.";
const RESOURCE_PAGE_SIZE = 100;
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

const findRecordsSchema = fromJsonSchema<FindRecordsInput>({
  type: "object",
  properties: {
    type: {
      type: ["string", "array"],
      items: { type: "string" },
      description: "The type or types to search. All types when absent.",
    },
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
      description: "An opaque cursor returned by the previous page. The next page starts after the last record that page considered, even if that record was deleted.",
    },
  },
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
      description: "The full record, which must match the schema of its type. Blob fields hold existing blob URIs returned by `upload_blob`; the same URI may be used by multiple records.",
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
      description: "A [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396): fields in the patch are set, a field set to `null` is removed, nested objects are merged, and arrays are replaced whole. Blob fields hold existing blob URIs returned by `upload_blob`; the same URI may be used by multiple records.",
    },
  },
  required: ["uri", "patch"],
  additionalProperties: false,
});
const uploadBlobSchema = fromJsonSchema<UploadBlobInput>({
  type: "object",
  properties: {
    base64: { type: "string", description: "Canonical base64 contents. Requires mediaType; cannot be combined with path." },
    path: { type: "string", description: "An absolute local file path, accepted only over stdio. Cannot be combined with base64." },
    mediaType: { type: "string", description: "The media type of the contents. Required for base64; inferred from the file extension for a path when absent, falling back to application/octet-stream." },
  },
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
    description: { type: "string", description: "What belongs in the type." },
    schema: { type: "object", description: "The JSON Schema for records of the type." },
    titleField: {
      type: "string",
      description: "A top-level field of the record whose string value is shown as its title.",
    },
    title: {
      type: "string",
      description: "The name of the type in words, in the singular, such as \"Journal entry\", shown to people in place of the type name.",
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
    title: {
      type: ["string", "null"],
      description: "The new title; `null` removes it.",
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
export async function buildServer(autofile: Autofile, options: ResourceOptions = {}): Promise<McpServer> {
  const tools = buildTools(autofile);
  const resources = buildResources(autofile, options);
  const { types } = await tools.listTypes({});
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
      description: "Searches records and returns matching records in URI order. It skips nonmatching records until the page has `limit` results, reaches 64 KB of JSON, or no records remain; the size cap never prevents the first result. `fields` selects top-level fields to return, while matching uses the whole record. A schema-invalid record is listed in `errors` only when it matches the search; a record that cannot be read is always listed. Autofile is where the user keeps durable information.",
      inputSchema: findRecordsSchema,
    },
    async (input) => toolResult(await tools.findRecords(input)),
  );
  server.registerTool(
    "get_record",
    {
      description: "Returns one record by URI: its `uri`, optional `title`, `createdAt` and `updatedAt` times, and `value`. A record that does not match its type is still returned, with what must change in `error`.",
      inputSchema: getRecordSchema,
    },
    async (input) => toolResult(await tools.getRecord(input)),
  );
  server.registerTool(
    "create_record",
    {
      description: "Creates a record and returns its URI. `record` is the full record and must match the schema of its type, which `get_type` returns. `key` is optional and generated when absent. Autofile is where the user keeps durable information.",
      inputSchema: createRecordSchema,
    },
    async (input) => toolResult(await tools.createRecord(input)),
  );
  server.registerTool(
    "update_record",
    { description: "Changes a record and returns its URI.", inputSchema: updateRecordSchema },
    async (input) => toolResult(await tools.updateRecord(input)),
  );
  server.registerTool(
    "upload_blob",
    {
      description: "Uploads bytes and returns their blob URI for use in records. Supply canonical base64 and a media type, up to 7 MiB, or an absolute local path over stdio with no size limit.",
      inputSchema: uploadBlobSchema,
    },
    async (input, context) => toolResult(await tools.uploadBlob(input, { allowLocalPaths: context.http === undefined })),
  );
  server.registerTool(
    "delete_record",
    {
      description: "Deletes a record, removes the links to it from other records, and returns its URI.",
      inputSchema: deleteRecordSchema,
    },
    async (input) => toolResult(await tools.deleteRecord(input)),
  );
  server.registerTool(
    "list_types",
    {
      description: "Returns every type, ordered by name, with the URI of its declaration, its description, and its `title` when it has one.",
      inputSchema: listTypesSchema,
    },
    async (input) => toolResult(await tools.listTypes(input)),
  );
  server.registerTool(
    "get_type",
    { description: "Returns the declaration of a type with its URI added.", inputSchema: getTypeSchema },
    async (input) => toolResult(await tools.getType(input)),
  );
  server.registerTool(
    "create_type",
    { description: "Declares a type and returns the URI of its declaration.", inputSchema: createTypeSchema },
    async (input) => toolResult(await tools.createType(input)),
  );
  server.registerTool(
    "update_type",
    {
      description: "Replaces the description, schema, title field or title of a type, or any of them.",
      inputSchema: updateTypeSchema,
    },
    async (input) => toolResult(await tools.updateType(input)),
  );
  server.registerTool(
    "delete_type",
    { description: "Deletes a type and returns its URI.", inputSchema: deleteTypeSchema },
    async (input) => toolResult(await tools.deleteType(input)),
  );

  // The high-level resource API returns every resource at once. These
  // handlers stay at the low-level boundary where cursors remain explicit;
  // the process-level watcher supplies the advertised change notices.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler("resources/list", async (request): Promise<ListResourcesResult> => {
    const listed = await resources.listResources();
    const cursor = request.params?.cursor;
    let start = 0;
    if (cursor !== undefined) {
      const previousUri = decodeCursor(cursor);
      if (previousUri === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid resource cursor");
      }
      const nextIndex = listed.findIndex(({ uri }) => uri > previousUri);
      start = nextIndex < 0 ? listed.length : nextIndex;
    }

    const page = listed.slice(start, start + RESOURCE_PAGE_SIZE);
    const last = page.at(-1);
    return {
      resources: page,
      ...(last !== undefined && start + page.length < listed.length
        ? { nextCursor: encodeCursor(last.uri) }
        : {}),
      ttlMs: 0,
      cacheScope: "private",
    };
  });

  server.server.setRequestHandler("resources/read", async (request): Promise<ReadResourceResult> => {
    const contents = await resources.readResource(request.params.uri);
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
