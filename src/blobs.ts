/** Stores explicitly uploaded attachments and checks their canonical addresses. */

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { extension as extensionForMimeType } from "mime-types";

const BLOB_EXTENSION_PATTERN_SOURCE = "[a-z0-9_-]+";

/** Canonical names Autofile recognizes in its blob folder. */
export const BLOB_NAME_PATTERN = new RegExp(
  `^[a-f0-9]{64}(?:\\.${BLOB_EXTENSION_PATTERN_SOURCE})?$`,
  "u",
);
/** Canonical URIs Autofile recognizes for stored blobs. */
export const BLOB_URI_PATTERN = new RegExp(
  `^autofile:///blobs/([a-f0-9]{64}(?:\\.${BLOB_EXTENSION_PATTERN_SOURCE})?)$`,
  "u",
);

const blobExtensionPattern = new RegExp(`^${BLOB_EXTENSION_PATTERN_SOURCE}$`, "u");

/** Stores uploaded bytes through the same incremental writer as streamed sources. */
export async function writeBlob(blobFolder: string, bytes: Buffer, mediaType: string): Promise<string> {
  async function* chunks() { yield bytes; }
  return writeBlobStream(blobFolder, chunks(), mediaType);
}

/** Hashes and stores chunks in order, publishing only a complete attachment. */
export async function writeBlobStream(
  blobFolder: string,
  chunks: AsyncIterable<Uint8Array>,
  mediaType: string,
): Promise<string> {
  const extension = extensionForMimeType(mediaType.toLowerCase());
  const suffix = extension === false ? undefined : normalizeExtension(extension);
  const digest = createHash("sha256");
  await mkdir(blobFolder, { recursive: true });
  if (!await isDirectory(blobFolder)) {
    throw Object.assign(new Error("blob folder is not a directory"), { code: "ENOTDIR" });
  }
  const temporaryPath = join(blobFolder, `.upload.${String(process.pid)}.${randomUUID()}`);
  async function* hashedChunks() {
    for await (const chunk of chunks) {
      digest.update(chunk);
      yield chunk;
    }
  }
  try {
    // writeFile awaits each chunk write before advancing the iterable, so the
    // source is backpressured and attachments never accumulate in memory.
    await writeFile(temporaryPath, hashedChunks(), { flag: "wx" });
    const name = `${digest.digest("hex")}${suffix === undefined ? "" : `.${suffix}`}`;
    const path = join(blobFolder, name);
    if (await isRegularFile(path)) {
      await unlink(temporaryPath);
    } else {
      // Set the exact read-only mode before publishing the immutable attachment.
      await chmod(temporaryPath, 0o444);
      await rename(temporaryPath, path);
    }
    return blobUri(name);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!hasCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

/** Checks attachment existence without opening or reading its bytes. */
export async function blobReferenceProblem(blobFolder: string, uri: string): Promise<string | undefined> {
  const name = blobNameFromUri(uri);
  return name !== undefined && await isDirectory(blobFolder) && await isRegularFile(join(blobFolder, name))
    ? undefined
    : `references a blob that does not exist: ${uri}`;
}

/** Checks the bare media type accepted by explicit uploads. */
export function isMediaType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  return new RegExp(`^${token}/${token}$`, "u").test(value);
}

/** Deletes the named canonical blob resources when they still exist. */
export async function deleteBlobUris(blobFolder: string, uris: Iterable<string>): Promise<void> {
  if (!await isDirectory(blobFolder)) return;
  for (const uri of uris) {
    const name = blobNameFromUri(uri);
    if (name === undefined) continue;
    try {
      await unlink(join(blobFolder, name));
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error;
    }
  }
}

/** Returns the canonical blob name from a URI. */
export function blobNameFromUri(uri: string): string | undefined {
  return typeof uri === "string" ? BLOB_URI_PATTERN.exec(uri)?.[1] : undefined;
}

/** Builds the canonical URI for a recognized blob name. */
export function blobUri(name: string): string {
  return `autofile:///blobs/${name}`;
}

function normalizeExtension(extension: string): string | undefined {
  const normalized = extension.toLowerCase();
  return blobExtensionPattern.test(normalized) ? normalized : undefined;
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
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
