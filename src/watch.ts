import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { watch } from "chokidar";

import { BLOB_NAME_PATTERN } from "./blobs.js";
import type { Store, StoreResource } from "./store.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const keyPattern = /^[a-z0-9][a-z0-9-]*$/u;
const BATCH_WINDOW_MS = 150;
const readFailed = Symbol("read failed");
const unknownMetadata = Symbol("unknown metadata");

type WatchStore = Pick<
  Store,
  "getResourceMetadata" | "listResourceFolder" | "listResources" | "listTypeResources"
>;
type FileEvent = "add" | "change" | "unlink";
type ResourceMetadata = Pick<StoreResource, "description" | "title">;
type CachedMetadata = ResourceMetadata | typeof unknownMetadata;

export type ResourceChangeKind = "created" | "changed" | "deleted";
const resourceChangeKinds: Record<FileEvent, ResourceChangeKind> = {
  add: "created",
  change: "changed",
  unlink: "deleted",
};

export interface ResourceChange {
  uri: string;
  kind: ResourceChangeKind;
  listChanged: boolean;
}

export interface ResourceChangeBatch {
  changes: ResourceChange[];
  listChanged: boolean;
}

export interface StoreWatcher {
  close(): Promise<void>;
}

interface PendingResource {
  membershipChanged: boolean;
  lastEvent: FileEvent;
}

/** Returns the exact resource, folder, and root URIs notified for one change. */
export function resourceNotificationUris(uri: string): [string, string, string] {
  return [uri, uri.slice(0, uri.lastIndexOf("/")), "autofile:///"];
}

/** Starts one watcher after its initial scan and resource cache are ready. */
export async function watchStore(
  dataFolder: string,
  store: WatchStore,
  onChange: (batch: ResourceChangeBatch) => void | Promise<void>,
  onError: (error: Error) => void,
): Promise<StoreWatcher> {
  const root = resolve(dataFolder);
  const stableParent = dirname(root);
  const watcher = watch(stableParent, {
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 10 },
    followSymlinks: false,
    ignoreInitial: true,
    ignored: (path) => isIgnoredWatchPath(stableParent, root, path),
  });
  const cache = new Map<string, CachedMetadata>();
  let queued = new Map<string, PendingResource>();
  let addedFolders = new Set<string>();
  let batchTimer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let initializing = true;
  const readyPromise = new Promise<void>((resolveWatcher, rejectWatcher) => {
    watcher.once("ready", resolveWatcher);
    watcher.once("error", (error) => rejectWatcher(toError(error)));
  });
  let stopping = false;

  watcher.on("add", (path) => queueFile("add", path));
  watcher.on("change", (path) => queueFile("change", path));
  watcher.on("unlink", (path) => queueFile("unlink", path));
  watcher.on("addDir", (path) => {
    if (stopping) return;
    const folder = resourceFolderForDirectory(root, path);
    if (folder === undefined) return;
    watcher.add(resolve(path));
    if (folder === "") return;
    addedFolders.add(folder);
    scheduleBatch();
  });
  watcher.on("unlinkDir", (path) => {
    if (stopping) return;
    const folder = resourceFolderForDirectory(root, path);
    if (folder === undefined) return;
    for (const uri of cache.keys()) {
      if (isResourceInFolder(uri, folder)) queueUri("unlink", uri);
    }
  });

  try {
    await readyPromise;
    watcher.on("error", (error) => onError(toError(error)));
    for (const resource of await store.listResources()) {
      cache.set(resource.uri, resourceMetadata(resource));
    }
    initializing = false;
    if (queued.size > 0 || addedFolders.size > 0) scheduleBatch();
  } catch (error) {
    await watcher.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    close: () => closing ??= closeWatcher(),
  };

  function queueFile(event: FileEvent, path: string): void {
    if (stopping) return;
    const uri = resourceUriForPath(root, path);
    if (uri !== undefined) queueUri(event, uri);
  }

  function queueUri(event: FileEvent, uri: string): void {
    addEvent(queued, uri, event);
    scheduleBatch();
  }

  function scheduleBatch(): void {
    if (initializing || batchTimer !== undefined) return;
    batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
  }

  function flushBatch(): void {
    batchTimer = undefined;
    if (queued.size === 0 && addedFolders.size === 0) return;
    const batch = queued;
    const folders = addedFolders;
    queued = new Map();
    addedFolders = new Set();
    pending = pending
      .then(() => processBatch(batch, folders))
      .catch((error: unknown) => onError(toError(error)));
  }

  async function processBatch(
    batch: Map<string, PendingResource>,
    folders: Set<string>,
  ): Promise<void> {
    const before = new Set(cache.keys());
    const supplied = new Map<string, StoreResource>();
    const failedUris = new Set<string>();
    let focusedReadFailed = false;
    const markReadFailed = (uri: string): void => {
      focusedReadFailed = true;
      failedUris.add(uri);
      cache.set(uri, unknownMetadata);
    };
    for (const folder of folders) {
      const resources = await readSafely(() => store.listResourceFolder(folder));
      if (resources === readFailed) {
        const affectedUris = new Set([...cache.keys(), ...batch.keys()]);
        for (const uri of affectedUris) {
          if (!isResourceInFolder(uri, folder)) continue;
          markReadFailed(uri);
        }
        continue;
      }
      for (const resource of resources) {
        supplied.set(resource.uri, resource);
        if (!cache.has(resource.uri)) addEvent(batch, resource.uri, "add");
      }
    }

    let metadataChanged = false;
    const affectedTypes = new Set<string>();
    for (const uri of batch.keys()) {
      const type = declarationType(uri);
      if (type === undefined || affectedTypes.has(type) || failedUris.has(uri)) continue;
      affectedTypes.add(type);
      const declarationUri = `autofile:///_types/${type}`;
      const recordPrefix = `autofile:///${type}/`;
      const listed = await readSafely(() => store.listTypeResources(type));
      if (listed === readFailed) {
        const affectedUris = new Set([...cache.keys(), ...batch.keys()]);
        for (const scopedUri of affectedUris) {
          if (scopedUri !== declarationUri && !scopedUri.startsWith(recordPrefix)) continue;
          markReadFailed(scopedUri);
        }
        continue;
      }
      const current = new Map(listed.map((resource) => [resource.uri, resource]));
      const scope = new Set(current.keys());
      for (const cachedUri of cache.keys()) {
        if (cachedUri === declarationUri || cachedUri.startsWith(recordPrefix)) {
          scope.add(cachedUri);
        }
      }
      for (const scopedUri of scope) {
        const wasListed = cache.has(scopedUri);
        const isListed = current.has(scopedUri);
        if (
          scopedUri.startsWith(recordPrefix)
          && wasListed !== isListed
          && !batch.has(scopedUri)
        ) {
          addEvent(batch, scopedUri, isListed ? "add" : "unlink");
        }
        metadataChanged = updateCache(cache, scopedUri, current.get(scopedUri))
          || metadataChanged;
      }
      for (const [currentUri, resource] of current) supplied.set(currentUri, resource);
    }

    for (const uri of [...batch.keys()]) {
      if (declarationType(uri) !== undefined) continue;
      if (failedUris.has(uri)) continue;
      const resource = supplied.get(uri)
        ?? await readSafely(() => store.getResourceMetadata(uri));
      if (resource === readFailed) {
        markReadFailed(uri);
        continue;
      }
      metadataChanged = updateCache(cache, uri, resource) || metadataChanged;
    }

    for (const uri of batch.keys()) {
      if (!before.has(uri) && !cache.has(uri) && !failedUris.has(uri)) batch.delete(uri);
    }

    const listChanged = focusedReadFailed
      || metadataChanged
      || [...batch.values()].some((event) => event.membershipChanged);
    const changes = [...batch.entries()].map(([uri, event]) => ({
      uri,
      kind: resourceChangeKinds[event.lastEvent],
      listChanged,
    }));
    if (changes.length > 0 || listChanged) await onChange({ changes, listChanged });
  }

  async function closeWatcher(): Promise<void> {
    stopping = true;
    await watcher.close();
    if (batchTimer !== undefined) clearTimeout(batchTimer);
    flushBatch();
    await pending;
  }

  async function readSafely<T>(read: () => Promise<T>): Promise<T | typeof readFailed> {
    try {
      return await read();
    } catch (error) {
      onError(toError(error));
      return readFailed;
    }
  }
}

function addEvent(batch: Map<string, PendingResource>, uri: string, event: FileEvent): void {
  const existing = batch.get(uri);
  if (existing === undefined) {
    batch.set(uri, { membershipChanged: event !== "change", lastEvent: event });
  } else {
    existing.membershipChanged ||= event !== "change";
    existing.lastEvent = event;
  }
}

function updateCache(
  cache: Map<string, CachedMetadata>,
  uri: string,
  resource: StoreResource | undefined,
): boolean {
  const previous = cache.get(uri);
  const next = resource === undefined ? undefined : resourceMetadata(resource);
  if (next === undefined) cache.delete(uri);
  else cache.set(uri, next);
  return previous === unknownMetadata
    || previous?.title !== next?.title
    || previous?.description !== next?.description
    || (previous === undefined) !== (next === undefined);
}

function resourceMetadata(resource: StoreResource): ResourceMetadata {
  return { title: resource.title, description: resource.description };
}

function declarationType(uri: string): string | undefined {
  const match = /^autofile:\/\/\/_types\/([a-z][a-z0-9-]*)$/u.exec(uri);
  return match?.[1];
}

function resourceUriForPath(root: string, path: string): string | undefined {
  const localPath = relative(root, resolve(path));
  if (localPath === "" || localPath === ".." || isAbsolute(localPath)) return undefined;
  const parts = localPath.split(sep);
  if (parts.length !== 2 || parts.some((part) => part.startsWith("."))) return undefined;
  const [folder, name] = parts;
  if (folder === undefined || name === undefined) return undefined;
  if (folder === "_blobs") {
    return BLOB_NAME_PATTERN.test(name) ? `autofile:///_blobs/${name}` : undefined;
  }
  if (!name.endsWith(".json")) return undefined;
  const resourceName = name.slice(0, -".json".length);
  if (folder === "_types") {
    return typeNamePattern.test(resourceName)
      ? `autofile:///_types/${resourceName}`
      : undefined;
  }
  return typeNamePattern.test(folder) && keyPattern.test(resourceName)
    ? `autofile:///${folder}/${resourceName}`
    : undefined;
}

function resourceFolderForDirectory(root: string, path: string): string | undefined {
  const localPath = relative(root, resolve(path));
  if (localPath === "") return "";
  if (localPath === ".." || isAbsolute(localPath)) return undefined;
  const parts = localPath.split(sep);
  if (parts.length !== 1) return undefined;
  const folder = parts[0];
  return folder !== undefined
    && (folder === "_types" || folder === "_blobs" || typeNamePattern.test(folder))
    ? folder
    : undefined;
}

function isResourceInFolder(uri: string, folder: string): boolean {
  if (folder === "") return true;
  if (folder === "_types") return !uri.startsWith("autofile:///_blobs/");
  return uri.startsWith(`autofile:///${folder}/`);
}

function isIgnoredWatchPath(stableParent: string, root: string, path: string): boolean {
  const resolvedPath = resolve(path);
  if (resolvedPath === stableParent || resolvedPath === root) return false;
  const localPath = relative(root, resolvedPath);
  return localPath === ".."
    || isAbsolute(localPath)
    || localPath.split(sep).some((part) => part.startsWith("."));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
