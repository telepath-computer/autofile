/**
 * Parses, checks, and persists blob-field inputs. Candidate preparation is
 * deliberately separate from persistence so a refused record write cannot
 * leave a blob behind.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

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

const SOURCE_READ_CHUNK_BYTES = 64 * 1024;
const blobExtensionPattern = new RegExp(`^${BLOB_EXTENSION_PATTERN_SOURCE}$`, "u");

/** One checked blob which may still need to be copied into the store. */
export interface PreparedBlob {
  uri: string;
  name: string;
  bytes?: Buffer;
}

/** A user-correctable refusal for one blob field. */
interface BlobRefusal {
  message: string;
}

/** Returns whether the value has one of the three syntactic blob input forms. */
export function isBlobInput(value: unknown): value is string {
  return typeof value === "string"
    && (BLOB_URI_PATTERN.test(value) || isAbsolute(value) || parseDataUri(value) !== undefined);
}

/** Checks and materializes one candidate without changing the blob folder. */
export async function prepareBlob(
  value: string,
  blobFolder: string,
  allowLocalPaths: boolean,
): Promise<PreparedBlob | BlobRefusal> {
  const blobName = blobNameFromUri(value);
  if (blobName !== undefined) {
    const details = await storedBlobDetails(blobFolder, blobName);
    if (details === undefined) return { message: `references a blob that does not exist: ${value}` };
    if (details.size > MAX_BLOB_BYTES) return sizeRefusal(details.size);
    return { uri: value, name: blobName };
  }

  if (isAbsolute(value)) {
    if (!allowLocalPaths) {
      return { message: "local paths are accepted only over stdio, not HTTP" };
    }
    const source = await openRegularFile(value, false);
    if (source === undefined) return { message: `path does not exist or is not a file: ${value}` };
    try {
      if (source.size > MAX_BLOB_BYTES) return sizeRefusal(source.size);
      const bytes = await readSourceFile(source.handle);
      if ("message" in bytes) return bytes;
      return preparedBytes(bytes, pathExtension(value));
    } finally {
      await source.handle.close();
    }
  }

  const data = parseDataUri(value);
  if (data === undefined) return { message: "must be a blob URI, an absolute path, or a base64 data URI" };
  if (data.size > MAX_BLOB_BYTES) return sizeRefusal(data.size);
  return preparedBytes(Buffer.from(data.base64, "base64"), data.extension);
}

/** Stores checked blobs atomically, skipping any destination already present. */
export async function writePreparedBlobs(
  blobFolder: string,
  blobs: Iterable<PreparedBlob>,
): Promise<void> {
  const pending = [...blobs].filter((blob) => blob.bytes !== undefined);
  if (pending.length === 0) return;
  await mkdir(blobFolder, { recursive: true });
  if (!await isDirectory(blobFolder)) {
    throw Object.assign(new Error("blob folder is not a directory"), { code: "ENOTDIR" });
  }

  const written = new Set<string>();
  for (const blob of pending) {
    if (written.has(blob.name)) continue;
    written.add(blob.name);
    const path = join(blobFolder, blob.name);
    if (await isRegularFile(path)) continue;
    await writeBlobAtomically(path, blob.bytes ?? Buffer.alloc(0));
  }
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
  return BLOB_URI_PATTERN.exec(uri)?.[1];
}

/** Builds the canonical URI for a recognized blob name. */
export function blobUri(name: string): string {
  return `autofile:///_blobs/${name}`;
}

interface OpenedFile {
  handle: FileHandle;
  size: number;
}

interface ParsedDataUri {
  base64: string;
  extension?: string;
  size: number;
}

function preparedBytes(bytes: Buffer, extension?: string): PreparedBlob {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const name = `${digest}${extension === undefined ? "" : `.${extension}`}`;
  return { uri: blobUri(name), name, bytes };
}

function parseDataUri(value: string): ParsedDataUri | undefined {
  if (value.slice(0, "data:".length).toLowerCase() !== "data:") return undefined;
  const comma = value.indexOf(",", "data:".length);
  if (comma === -1) return undefined;
  const header = value.slice("data:".length, comma);
  const marker = ";base64";
  if (header.slice(-marker.length).toLowerCase() !== marker) return undefined;
  const metadata = header.slice(0, -marker.length);
  const base64 = value.slice(comma + 1);
  if (!isCanonicalBase64(base64)) return undefined;
  const [mediaType = "", ...parameters] = metadata.split(";");
  if (
    (mediaType !== "" && !isMediaType(mediaType))
    || parameters.some((parameter) => !isMediaTypeParameter(parameter))
  ) {
    return undefined;
  }
  const normalizedMediaType = mediaType === "" ? "text/plain" : mediaType.toLowerCase();
  const usualExtension = extensionForMimeType(normalizedMediaType);
  const extension = usualExtension === false ? undefined : normalizeExtension(usualExtension);
  return {
    base64,
    ...(extension === undefined ? {} : { extension }),
    size: decodedBase64Size(base64),
  };
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if (padding === 2 && contentLength % 4 !== 2) return false;
  if (padding === 1 && contentLength % 4 !== 3) return false;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 0x41 && code <= 0x5a)
      && !(code >= 0x61 && code <= 0x7a)
      && !(code >= 0x30 && code <= 0x39)
      && code !== 0x2b
      && code !== 0x2f
    ) {
      return false;
    }
  }
  if (padding > 0) {
    const finalCode = value.charCodeAt(contentLength - 1);
    const finalSextet = finalCode >= 0x41 && finalCode <= 0x5a
      ? finalCode - 0x41
      : finalCode >= 0x61 && finalCode <= 0x7a
        ? finalCode - 0x61 + 26
        : finalCode >= 0x30 && finalCode <= 0x39
          ? finalCode - 0x30 + 52
          : finalCode === 0x2b ? 62 : 63;
    const unusedBits = padding === 2 ? 4 : 2;
    if ((finalSextet & ((1 << unusedBits) - 1)) !== 0) return false;
  }
  return true;
}

function decodedBase64Size(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function isMediaType(value: string): boolean {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  return new RegExp(`^${token}/${token}$`, "u").test(value);
}

function isMediaTypeParameter(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\s,;]+$/u.test(value);
}

function pathExtension(path: string): string | undefined {
  return normalizeExtension(extname(basename(path)).slice(1));
}

function normalizeExtension(extension: string): string | undefined {
  const normalized = extension.toLowerCase();
  return blobExtensionPattern.test(normalized) ? normalized : undefined;
}

function sizeRefusal(size: number): BlobRefusal {
  return { message: `blob is ${String(size)} bytes; limit is ${String(MAX_BLOB_BYTES)} bytes` };
}

async function storedBlobDetails(blobFolder: string, name: string): Promise<{ size: number } | undefined> {
  if (!await isDirectory(blobFolder)) return undefined;
  const file = await openRegularFile(join(blobFolder, name), true);
  if (file === undefined) return undefined;
  try {
    return { size: file.size };
  } finally {
    await file.handle.close();
  }
}

async function readSourceFile(handle: FileHandle): Promise<Buffer | BlobRefusal> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    // The extra byte proves the source is too large without allowing a file that grew after stat,
    // or a regular special file with an inaccurate size, to make this read unbounded.
    const remainingWithSentinel = MAX_BLOB_BYTES + 1 - size;
    const buffer = Buffer.alloc(Math.min(SOURCE_READ_CHUNK_BYTES, remainingWithSentinel));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) return Buffer.concat(chunks, size);
    size += bytesRead;
    if (size > MAX_BLOB_BYTES) return sizeRefusal(size);
    chunks.push(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead));
  }
}

async function openRegularFile(path: string, noFollow: boolean): Promise<OpenedFile | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0),
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
