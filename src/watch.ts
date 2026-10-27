/** Maps filesystem changes to Autofile addresses without reading stored values. */

import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { watch } from "chokidar";

import type { ChangeEvent } from "./store.js";

const typeNamePattern = /^[a-z][a-z0-9-]*$/u;
const keyPattern = /^[a-z0-9][a-z0-9-]*$/u;
const BATCH_WINDOW_MS = 150;

/** The filesystem watcher's lifetime, owned by one Autofile instance. */
export interface FolderWatcher {
  close(): Promise<void>;
}

/** Starts watching after the initial directory scan, without reporting existing files. */
export async function watchFolder(
  dataFolder: string,
  onChange: (changes: ChangeEvent[]) => void | Promise<void>,
  onError: (error: Error) => void,
): Promise<FolderWatcher> {
  const root = resolve(dataFolder);
  const stableParent = dirname(root);
  // Watching the parent keeps this instance alive when the whole data folder is
  // removed and restored. Siblings are excluded before chokidar descends into them.
  const watcher = watch(stableParent, {
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 10 },
    followSymlinks: false,
    ignoreInitial: true,
    // Exclude nonregular entries before chokidar remembers their names. Its
    // symlink tracking otherwise misses a later replacement by a regular file.
    ignored: (path, stats) => isIgnoredWatchPath(stableParent, root, path)
      || (stats !== undefined && !stats.isFile() && !stats.isDirectory()),
  });
  const knownUris = new Set<string>();
  let queued = new Map<string, ChangeEvent>();
  let batchTimer: NodeJS.Timeout | undefined;
  let pendingFiles = Promise.resolve();
  let pending = Promise.resolve();
  let initializing = true;
  let stopping = false;

  const readyPromise = new Promise<void>((resolveWatcher, rejectWatcher) => {
    watcher.once("ready", resolveWatcher);
    watcher.once("error", (error) => rejectWatcher(toError(error)));
  });
  watcher.on("add", (path) => queueFile("created", path));
  watcher.on("change", (path) => queueFile("changed", path));
  watcher.on("unlink", (path) => queueFile("deleted", path));
  watcher.on("addDir", (path) => {
    if (stopping || resourceFolderForDirectory(root, path) === undefined) return;
    watcher.add(resolve(path));
  });
  watcher.on("unlinkDir", (path) => {
    if (stopping) return;
    const folder = resourceFolderForDirectory(root, path);
    if (folder === undefined) return;
    queueFileCheck(() => {
      const prefix = `autofile:///${folder}/`;
      for (const uri of knownUris) {
        if (folder === "" || uri.startsWith(prefix)) {
          queueUri("deleted", uri);
        }
      }
    });
  });

  try {
    await readyPromise;
    watcher.on("error", (error) => onError(toError(error)));
    // The scan includes directories and symlinks too. Remember only regular
    // files so removing a directory cannot invent deletions for ignored entries.
    pendingFiles = pendingFiles.then(async () => {
      for (const [folder, filenames] of Object.entries(watcher.getWatched())) {
        for (const filename of filenames) {
          const path = resolve(folder, filename);
          const uri = resourceUriForPath(root, path);
          if (uri !== undefined && await isRegularFile(path)) knownUris.add(uri);
        }
      }
    });
    await pendingFiles;
    initializing = false;
    if (queued.size > 0) scheduleBatch();
  } catch (error) {
    await watcher.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return { close: () => closing ??= closeWatcher() };

  function queueFile(kind: ChangeEvent["kind"], path: string): void {
    if (stopping) return;
    const uri = resourceUriForPath(root, path);
    if (uri === undefined) return;
    queueFileCheck(async () => {
      // Chokidar's write-settling stats follow symlinks even with
      // followSymlinks disabled, so check the entry itself before notifying.
      queueUri(kind === "deleted" || !await isRegularFile(path) ? "deleted" : kind, uri);
    });
  }

  function queueFileCheck(check: () => void | Promise<void>): void {
    pendingFiles = pendingFiles.then(check).catch((error: unknown) => onError(toError(error)));
  }

  function queueUri(kind: ChangeEvent["kind"], uri: string): void {
    if (kind === "deleted") {
      if (!knownUris.delete(uri)) return;
    } else knownUris.add(uri);
    queued.set(uri, { uri, kind });
    scheduleBatch();
  }

  function scheduleBatch(): void {
    if (initializing || batchTimer !== undefined) return;
    batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
  }

  function flushBatch(): void {
    batchTimer = undefined;
    if (queued.size === 0) return;
    const changes = [...queued.values()];
    queued = new Map();
    pending = pending
      .then(() => onChange(changes))
      .catch((error: unknown) => onError(toError(error)));
  }

  async function closeWatcher(): Promise<void> {
    stopping = true;
    await watcher.close();
    await pendingFiles;
    if (batchTimer !== undefined) clearTimeout(batchTimer);
    flushBatch();
    await pending;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function resourceUriForPath(root: string, path: string): string | undefined {
  const localPath = relative(root, resolve(path));
  if (localPath === "" || localPath === ".." || isAbsolute(localPath)) return undefined;
  const parts = localPath.split(sep);
  if (parts.length !== 2 || parts.some((part) => part.startsWith("."))) return undefined;
  const [folder, name] = parts;
  if (folder === undefined || name === undefined) return undefined;
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
    && (folder === "_types" || typeNamePattern.test(folder))
    ? folder
    : undefined;
}

function isIgnoredWatchPath(stableParent: string, root: string, path: string): boolean {
  const resolvedPath = resolve(path);
  if (resolvedPath === stableParent || resolvedPath === root) return false;
  const localPath = relative(root, resolvedPath);
  return localPath === ".."
    || isAbsolute(localPath)
    || localPath.split(sep)[0] === "_blobs"
    || localPath.split(sep).some((part) => part.startsWith("."));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
