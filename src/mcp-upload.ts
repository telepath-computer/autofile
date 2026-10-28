/** Validates MCP upload sources and reads local files only for stdio requests. */

import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { lookup as lookupMimeType } from "mime-types";

import { AutofileError, type Autofile } from "./index.js";

// Bound base64 decoding to bytes that fit in one MCP message.
const MAX_UPLOAD_BYTES = 7_340_032;

/** Arguments to upload_blob; exactly one source is required. */
export interface UploadBlobInput { base64?: string; path?: string; mediaType?: string }
/** Local file access is granted only by the stdio transport. */
export interface UploadBlobOptions { allowLocalPaths?: boolean }

/** Uploads decoded bytes or streamed local chunks through public blob operations. */
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
    const file = await openUpload(input.path);
    try {
      return { uri: await autofile.blobs.putStream(uploadChunks(file), mediaType) };
    } finally {
      await file.close();
    }
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

async function openUpload(path: string): Promise<FileHandle> {
  let file: FileHandle | undefined;
  try {
    // Nonblocking opens and a regular-file check keep devices, sockets and pipes
    // from hanging a request.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const details = await file.stat();
    if (!details.isFile()) refuse("local upload source must be a regular file");
    return file;
  } catch (error) {
    await file?.close();
    if (error instanceof AutofileError) throw error;
    return refuse("local upload source cannot be read");
  }
}

async function* uploadChunks(file: FileHandle): AsyncGenerator<Uint8Array> {
  try {
    // The upload adapter owns the handle and closes it even when validation
    // fails before the library starts consuming these chunks.
    for await (const chunk of file.createReadStream({ autoClose: false })) yield chunk as Buffer;
  } catch {
    refuse("local upload source cannot be read");
  }
}

function refuseSize(size: number): never {
  return refuse(`base64 upload is ${String(size)} bytes; limit is ${String(MAX_UPLOAD_BYTES)} bytes; use path over stdio for larger files`);
}

function refuse(message: string): never {
  throw new AutofileError([{ message }]);
}
