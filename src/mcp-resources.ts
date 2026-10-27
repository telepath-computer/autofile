/** Derives MCP resources from public Autofile records and type declarations. */

import { AutofileError, type Autofile, type AutofileRecord, type TypeDeclaration } from "./index.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const typeUriPattern = /^autofile:\/\/\/_types\/([a-z][a-z0-9-]*)$/u;
const recordUriPattern = /^autofile:\/\/\/[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const blobUriPattern = /^autofile:\/\/\/_blobs\/[^/]+$/u;

/** The public information used in an MCP resource listing. */
export interface StoreResource {
  uri: string;
  name: string;
  mimeType: string;
  title?: string;
  description?: string;
}
/** The text or binary contents of one resource. */
export type StoreResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };
/** Resource operations shared by the MCP server and its notification adapter. */
export interface Resources {
  listResources(): Promise<StoreResource[]>;
  getResourceMetadata(uri: string): Promise<StoreResource | undefined>;
  listTypeResources(type: string): Promise<StoreResource[]>;
  readResource(uri: string): Promise<StoreResourceContents | undefined>;
}

/** Builds resource operations using only the public library interface. */
export function buildResources(autofile: Autofile): Resources {
  async function listResources(): Promise<StoreResource[]> {
    const resources: StoreResource[] = [];
    for (const declaration of await autofile.types.list()) {
      resources.push(...await listTypeResources(declaration.type));
    }
    return resources.sort(compareResources);
  }

  async function getResourceMetadata(uri: string): Promise<StoreResource | undefined> {
    const type = typeUriPattern.exec(uri)?.[1];
    if (type !== undefined) {
      const declaration = await readable(() => autofile.types.get(type));
      return declaration === undefined ? undefined : declarationResource(declaration);
    }
    if (!recordUriPattern.test(uri)) return undefined;
    const record = await readable(() => autofile.records.get(uri));
    return record === undefined ? undefined : recordResource(record);
  }

  async function listTypeResources(type: string): Promise<StoreResource[]> {
    if (!typeNamePattern.test(type)) return [];
    const declaration = await readable(() => autofile.types.get(type));
    if (declaration === undefined) return [];
    const resources = [declarationResource(declaration)];
    let cursor: string | undefined;
    do {
      const page = await readable(() => autofile.records.find({ type, limit: 200, cursor }));
      if (page === undefined) break;
      resources.push(...page.records.map(recordResource));
      // Queries exclude records that fail schema validation. A direct public
      // read can still return them, including the problems needed to repair them.
      for (const { uri } of page.unreadable) {
        const record = await readable(() => autofile.records.get(uri));
        if (record !== undefined) resources.push(recordResource(record));
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return resources.sort(compareResources);
  }

  async function readResource(uri: string): Promise<StoreResourceContents | undefined> {
    if (blobUriPattern.test(uri)) {
      const blob = await autofile.blobs.get(uri);
      return blob === undefined ? undefined : {
        uri, mimeType: blob.mimeType, blob: Buffer.from(blob.bytes).toString("base64"),
      };
    }
    const type = typeUriPattern.exec(uri)?.[1];
    const document = type !== undefined
      ? await readable(() => autofile.types.get(type))
      : recordUriPattern.test(uri)
        ? await readable(() => autofile.records.get(uri))
        : undefined;
    if (document === undefined) return undefined;
    return { uri, mimeType: "application/json", text: serialize(document) };
  }

  return { listResources, getResourceMetadata, listTypeResources, readResource };
}

/** Checks addresses that can occur in an MCP resource-list cursor. */
export function isResourceUri(uri: string): boolean {
  return typeUriPattern.test(uri) || recordUriPattern.test(uri);
}

function declarationResource(declaration: TypeDeclaration): StoreResource {
  return {
    uri: declaration.uri,
    name: `Type: ${declaration.type}`,
    mimeType: "application/json",
    description: declaration.description,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
  };
}

function recordResource(record: AutofileRecord): StoreResource {
  return {
    uri: record.uri,
    name: `${record.type}: ${record.key}`,
    mimeType: "application/json",
    ...(record.title === undefined ? {} : { title: record.title }),
  };
}

function serialize(value: object): string {
  return `${JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )));
  }, 2)}\n`;
}

function compareResources(left: StoreResource, right: StoreResource): number {
  return left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0;
}

async function readable<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AutofileError) return undefined;
    throw error;
  }
}
