/** Validates MCP upload sources and reads local files only for stdio requests. */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { lookup as lookupMimeType } from "mime-types";

import { AutofileError, type Autofile } from "./index.js";

// Bound transport decoding and file reads before handing bytes to the library.
const MAX_UPLOAD_BYTES = 7_340_032;

/** Arguments to upload_blob; exactly one source is required. */
export interface UploadBlobInput { base64?: string; path?: string; mediaType?: string }
/** Local file access is granted only by the stdio transport. */
export interface UploadBlobOptions { allowLocalPaths?: boolean }

/** Uploads decoded bytes through the library's public blob operation. */
export async function uploadBlob(
  autofile: Autofile,
  input: UploadBlobInput,
  options: UploadBlobOptions,
): Promise<{ uri: string }> {
  if ((input.base64 === undefined) === (input.path === undefined)) {
    refuse("supply exactly one of base64 or path");
  }
  if (input.path !== undefined) {
    if (options.allowLocalPaths !== true) refuse("local paths are accepted only over stdio, not HTTP");
    if (!isAbsolute(input.path)) refuse("local upload path must be absolute");
    const mediaType = input.mediaType ?? (lookupMimeType(input.path) || "application/octet-stream");
    let bytes: Uint8Array;
    try {
      bytes = await readUpload(input.path);
    } catch (error) {
      if (error instanceof AutofileError) throw error;
      return refuse("local upload source cannot be read");
    }
    return { uri: await autofile.blobs.put(bytes, mediaType) };
  }
  if (input.mediaType === undefined) refuse("mediaType is required for base64 uploads");
  const base64 = input.base64!;
  // Buffer's base64 decoder silently ignores invalid characters and accepts
  // incomplete padding. Check syntax and the round trip to reject both those
  // forms and nonzero unused bits in the final sextet.
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) {
    refuse("base64 must be canonical base64");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const size = base64.length / 4 * 3 - padding;
  if (size > MAX_UPLOAD_BYTES) refuseSize(size);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) refuse("base64 must be canonical base64");
  return { uri: await autofile.blobs.put(bytes, input.mediaType) };
}

async function readUpload(path: string): Promise<Uint8Array> {
  // Nonblocking opens and a regular-file check keep devices, sockets and pipes
  // from hanging a request. The extra byte also detects growth after stat.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const details = await file.stat();
    if (!details.isFile()) refuse("local upload source must be a regular file");
    if (details.size > MAX_UPLOAD_BYTES) refuseSize(details.size);
    const buffer = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_UPLOAD_BYTES) refuseSize(length);
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function refuseSize(size: number): never {
  return refuse(`blob is ${String(size)} bytes; limit is ${String(MAX_UPLOAD_BYTES)} bytes`);
}

function refuse(message: string): never {
  throw new AutofileError([{ message }]);
}
