/** Derives MCP resource-list hints from the changes published by Autofile. */

import type { Autofile, ChangeEvent } from "./index.js";
import { buildResources, type Resources, type StoreResource } from "./mcp-resources.js";

const readFailed = Symbol("read failed");
const unknownMetadata = Symbol("unknown metadata");
type ResourceMetadata = Pick<StoreResource, "description" | "title">;
type CachedMetadata = ResourceMetadata | typeof unknownMetadata;

/** One resource update and whether the batch changed the MCP resource list. */
export interface ResourceChange extends ChangeEvent {
  listChanged: boolean;
}

/** Resource updates coalesced by the underlying Autofile watcher. */
export interface ResourceChangeBatch {
  changes: ResourceChange[];
  listChanged: boolean;
}

/** An MCP subscription to the store's shared watcher. */
export interface ResourceWatcher {
  close(): Promise<void>;
}

interface PendingResource {
  membershipChanged: boolean;
  lastEvent: ChangeEvent["kind"];
}

/** Watches MCP metadata using the instance's existing change subscription API. */
export async function watchResources(
  store: Autofile,
  onChange: (batch: ResourceChangeBatch) => void | Promise<void>,
  onError: (error: Error) => void,
  resources: Resources = buildResources(store),
): Promise<ResourceWatcher> {
  const cache = new Map<string, CachedMetadata>();
  let pending = Promise.resolve();
  let initializing = true;
  const initialChanges: ChangeEvent[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    unsubscribe = await store.watch((changes) => {
      if (initializing) {
        initialChanges.push(...changes);
        return;
      }
      return enqueue(changes);
    }, { onError });
    for (const resource of await resources.listResources()) {
      cache.set(resource.uri, resourceMetadata(resource));
    }
    initializing = false;
    if (initialChanges.length > 0) await enqueue(initialChanges);
  } catch (error) {
    await unsubscribe?.();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return { close: () => closing ??= closeWatcher() };

  function enqueue(changes: ChangeEvent[]): Promise<void> {
    const batch = new Map<string, PendingResource>();
    for (const { uri, kind } of changes) addEvent(batch, uri, kind);
    pending = pending.then(() => processBatch(batch))
      .catch((error: unknown) => onError(toError(error)));
    return pending;
  }

  async function processBatch(batch: Map<string, PendingResource>): Promise<void> {
    const before = new Set(cache.keys());
    const supplied = new Map<string, StoreResource>();
    const failedUris = new Set<string>();
    let focusedReadFailed = false;
    const markReadFailed = (uri: string): void => {
      focusedReadFailed = true;
      failedUris.add(uri);
      cache.set(uri, unknownMetadata);
    };

    let metadataChanged = false;
    const affectedTypes = new Set<string>();
    for (const uri of batch.keys()) {
      const type = declarationType(uri);
      if (type === undefined || affectedTypes.has(type) || failedUris.has(uri)) continue;
      affectedTypes.add(type);
      const declarationUri = `autofile:///types/${type}`;
      const recordPrefix = `autofile:///records/${type}/`;
      const listed = await readSafely(() => resources.listTypeResources(type));
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
          addEvent(batch, scopedUri, isListed ? "created" : "deleted");
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
        ?? await readSafely(() => resources.getResourceMetadata(uri));
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
      kind: event.lastEvent,
      listChanged,
    }));
    if (changes.length > 0 || listChanged) await onChange({ changes, listChanged });
  }

  async function closeWatcher(): Promise<void> {
    await unsubscribe?.();
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

function addEvent(batch: Map<string, PendingResource>, uri: string, event: ChangeEvent["kind"]): void {
  const existing = batch.get(uri);
  if (existing === undefined) {
    batch.set(uri, { membershipChanged: event !== "changed", lastEvent: event });
  } else {
    existing.membershipChanged ||= event !== "changed";
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
  const match = /^autofile:\/\/\/types\/([a-z][a-z0-9-]*)$/u.exec(uri);
  return match?.[1];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
