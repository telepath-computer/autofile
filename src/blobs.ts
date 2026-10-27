/** Stores explicitly uploaded attachments and checks their canonical addresses. */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { extension as extensionForMimeType } from "mime-types";

const BLOB_EXTENSION_PATTERN_SOURCE = "[a-z0-9_-]+";

/** Largest blob that fits in one MCP message after base64 encoding. */
export const MAX_BLOB_BYTES = 7_340_032;
/** Canonical names Autofile recognizes in its blob folder. */
export const BLOB_NAME_PATTERN = new RegExp(
  `^[a-f0-9]{64}(?:\\.${BLOB_EXTENSION_PATTERN_SOURCE})?$`,
  "u",
);
/** Canonical URIs Autofile recognizes for stored blobs. */
export const BLOB_URI_PATTERN = new RegExp(
  `^autofile:///_blobs/([a-f0-9]{64}(?:\\.${BLOB_EXTENSION_PATTERN_SOURCE})?)$`,
  "u",
);

const blobExtensionPattern = new RegExp(`^${BLOB_EXTENSION_PATTERN_SOURCE}$`, "u");

/** Stores one attachment atomically, reusing an existing regular file. */
export async function writeBlob(blobFolder: string, bytes: Buffer, mediaType: string): Promise<string> {
  const extension = extensionForMimeType(mediaType.toLowerCase());
  const suffix = extension === false ? undefined : normalizeExtension(extension);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const name = `${digest}${suffix === undefined ? "" : `.${suffix}`}`;
  await mkdir(blobFolder, { recursive: true });
  if (!await isDirectory(blobFolder)) {
    throw Object.assign(new Error("blob folder is not a directory"), { code: "ENOTDIR" });
  }
  const path = join(blobFolder, name);
  if (!await isRegularFile(path)) await writeBlobAtomically(path, bytes);
  return blobUri(name);
}

/** Reports unavailable or oversized bytes for a canonical attachment address. */
export async function blobReferenceProblem(blobFolder: string, uri: string): Promise<string | undefined> {
  const name = blobNameFromUri(uri);
  const details = name === undefined ? undefined : await storedBlobDetails(blobFolder, name);
  if (details === undefined) return `references a blob that does not exist: ${uri}`;
  return details.size > MAX_BLOB_BYTES ? blobSizeProblem(details.size) : undefined;
}

/** Checks the bare media type accepted by explicit uploads. */
export function isMediaType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  return new RegExp(`^${token}/${token}$`, "u").test(value);
}

/** Gives the upload size and the accepted limit in the existing refusal form. */
export function blobSizeProblem(size: number): string {
  return `blob is ${String(size)} bytes; limit is ${String(MAX_BLOB_BYTES)} bytes`;
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
  return `autofile:///_blobs/${name}`;
}

interface OpenedFile {
  handle: FileHandle;
  size: number;
}

function normalizeExtension(extension: string): string | undefined {
  const normalized = extension.toLowerCase();
  return blobExtensionPattern.test(normalized) ? normalized : undefined;
}

async function storedBlobDetails(blobFolder: string, name: string): Promise<{ size: number } | undefined> {
  if (!await isDirectory(blobFolder)) return undefined;
  const file = await openRegularFile(join(blobFolder, name));
  if (file === undefined) return undefined;
  try {
    return { size: file.size };
  } finally {
    await file.handle.close();
  }
}

async function openRegularFile(path: string): Promise<OpenedFile | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
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

async function writeBlobAtomically(path: string, bytes: Buffer): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
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
