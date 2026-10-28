/** Serves MCP requests and streamed blob downloads through the same HTTP checks. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { normalizeHttpOrigin, type HttpSettings } from "./config.js";
import { buildServer } from "./server.js";
import type { Autofile } from "./index.js";
import { watchResources } from "./mcp-watch.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const CORS_ALLOW_HEADERS = "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name";
const BLOB_METHODS = "GET, HEAD, OPTIONS";
const BLOB_EXPOSE_HEADERS = "Content-Length, Content-Range, Accept-Ranges, ETag";
const blobPathPattern = /^\/blobs\/([a-f0-9]{64})(?:\.[a-z0-9_-]+)?$/u;

export interface RunningHttpServer {
  endpoint: URL;
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Starts one modern-only Streamable HTTP endpoint around a process-shared store. */
export async function startHttpServer(
  store: Autofile,
  settings: HttpSettings,
  onError: (error: Error) => void,
): Promise<RunningHttpServer> {
  const handler = createMcpHandler(() => buildServer(store, { blobLocation: "http" }), {
    legacy: "reject",
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: onError,
  });
  const watcher = await watchResources(store, (batch) => {
    const uris = new Set(batch.changes.map(({ uri }) => uri));
    for (const uri of uris) {
      handler.notify.resourceUpdated(uri);
    }
    if (batch.listChanged) handler.notify.resourcesChanged();
  }, onError).catch(async (error: unknown) => {
    await Promise.all([store.close(), handler.close()]);
    throw error;
  });
  const serveMcp = toNodeHandler(handler, { maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  const allowedOrigins = new Set(settings.origins);
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...settings.origins.map((origin) => new URL(origin).hostname.toLowerCase()),
  ]);
  const httpServer = createServer((request, response) => {
    void routeRequest(request, response, allowedOrigins, allowedHosts, serveMcp, store).catch((error: unknown) => {
      // Cancelling a download closes its pipeline. This is a normal client action,
      // whereas storage and handler failures are reported without physical paths.
      if (error instanceof Error && "code" in error
        && (error.code === "ERR_STREAM_PREMATURE_CLOSE" || error.code === "ECONNRESET")) return;
      onError(new Error("Could not serve HTTP request"));
      if (response.headersSent || response.destroyed) response.destroy();
      else {
        response.removeHeader("Content-Length");
        response.removeHeader("Content-Range");
        response.removeHeader("ETag");
        response.removeHeader("Cache-Control");
        refuse(response, 500, "Internal Server Error\n");
      }
    });
  });
  const closed = new Promise<void>((resolveClosed) => httpServer.once("close", resolveClosed));

  try {
    await new Promise<void>((resolveListening, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(settings.port, settings.host, () => {
        httpServer.off("error", onError);
        resolveListening();
      });
    });
  } catch (error) {
    await Promise.all([watcher.close(), handler.close()]);
    await store.close();
    throw error;
  }

  const endpoint = new URL(`http://${urlHost(settings.host)}:${settings.port}/mcp`);
  let closing: Promise<void> | undefined;
  return {
    endpoint,
    closed,
    close() {
      closing ??= closeHttpServer();
      return closing;
    },
  };

  async function closeHttpServer(): Promise<void> {
    httpServer.close();
    httpServer.closeAllConnections();
    await Promise.all([watcher.close(), handler.close(), closed]);
    await store.close();
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
  allowedHosts: ReadonlySet<string>,
  serveMcp: ReturnType<typeof toNodeHandler>,
  store: Autofile,
): Promise<void> {
  const path = requestPath(request);
  const isBlob = path?.startsWith("/blobs/") === true;
  if (isBlob) {
    response.setHeader("Vary", "Origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "sandbox");
  }
  if (!isAllowedHost(request.headers.host, allowedHosts)) {
    refuse(response, 403, "Forbidden\n");
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin, allowedOrigins)) {
    refuse(response, 403, "Forbidden\n");
    return;
  }
  if (path !== "/mcp" && !isBlob) {
    refuse(response, 404, "Not Found\n");
    return;
  }
  if (origin !== undefined) setCorsHeaders(response, origin);
  if (isBlob && path !== undefined) {
    if (origin !== undefined) response.setHeader("Access-Control-Expose-Headers", BLOB_EXPOSE_HEADERS);
    await serveBlob(request, response, path, store);
    return;
  }

  if (request.method === "OPTIONS") {
    response.setHeader("Connection", "close");
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    }).end();
    return;
  }

  await serveMcp(request, response);
}

async function serveBlob(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  store: Autofile,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Connection": "close",
      "Access-Control-Allow-Methods": BLOB_METHODS,
      "Access-Control-Allow-Headers": "Range, If-None-Match",
    }).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", BLOB_METHODS);
    refuse(response, 405, "Method Not Allowed\n");
    return;
  }
  const hash = blobPathPattern.exec(path)?.[1];
  const uri = `autofile://${path}`;
  const details = hash === undefined ? undefined : await store.blobs.stat(uri);
  if (details === undefined) {
    refuse(response, 404, "Not Found\n");
    return;
  }

  const etag = `"${hash}"`;
  response.setHeader("Content-Type", details.mimeType);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (matchesEtag(request.headers["if-none-match"], etag)) {
    response.writeHead(304).end();
    return;
  }
  if (request.method === "HEAD") {
    response.setHeader("Content-Length", details.size);
    response.writeHead(200).end();
    return;
  }

  const ifRange = request.headers["if-range"];
  const range = ifRange === undefined || ifRange === etag
    ? parseByteRange(request.headers.range, details.size)
    : undefined;
  if (range === "unsatisfiable") {
    response.setHeader("Content-Range", `bytes */${details.size}`);
    refuse(response, 416, "Range Not Satisfiable\n");
    return;
  }
  const body = await store.blobs.stream(uri, range);
  if (body === undefined) {
    response.removeHeader("ETag");
    response.removeHeader("Cache-Control");
    refuse(response, 404, "Not Found\n");
    return;
  }
  response.setHeader("Content-Length", range === undefined ? details.size : range.end - range.start);
  if (range !== undefined) {
    response.setHeader("Content-Range", `bytes ${range.start}-${range.end - 1}/${details.size}`);
  }
  response.writeHead(range === undefined ? 200 : 206);
  // The pipeline propagates backpressure and cancels the store stream when the
  // connection closes, keeping memory and file descriptors bounded.
  // Node and DOM declarations describe the same Web stream with different
  // iterator helpers. Only the Node adapter needs the richer Node declaration.
  await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), response);
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.trim() === "*"
    || header.split(",").some((candidate) => candidate.trim().replace(/^W\//u, "") === etag);
}

function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/iu.exec(header);
  const first = match?.[1];
  const last = match?.[2];
  if (first === undefined || last === undefined || (first === "" && last === "")) return undefined;
  // Decimal offsets can exceed JavaScript's integer precision. Compare before
  // converting so even very large ranges can be clipped to the actual blob.
  const length = BigInt(size);
  if (first === "") {
    const suffix = BigInt(last);
    if (suffix === 0n || length === 0n) return "unsatisfiable";
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size };
  }
  const start = BigInt(first);
  const end = last === "" ? length : BigInt(last) + 1n;
  if (last !== "" && end <= start) return undefined;
  if (start >= length) return "unsatisfiable";
  return { start: Number(start), end: Number(end > length ? length : end) };
}

function requestPath(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "", "http://autofile.local").pathname;
  } catch {
    return undefined;
  }
}

function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  const normalized = normalizeHttpOrigin(origin);
  if (normalized === undefined) return false;
  const hostname = new URL(normalized).hostname.toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || allowedOrigins.has(normalized);
}

function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  const hostname = host === undefined ? undefined : hostHeaderName(host);
  return hostname !== undefined && allowedHosts.has(hostname);
}

function hostHeaderName(host: string): string | undefined {
  if (host === "" || host.trim() !== host || /[\s/\\?#@,]/u.test(host)) return undefined;
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (
      closingBracket <= 1
      || (host.slice(closingBracket + 1) !== ""
        && !/^:\d+$/u.test(host.slice(closingBracket + 1)))
    ) {
      return undefined;
    }
  } else {
    const firstColon = host.indexOf(":");
    if (
      firstColon !== -1
      && (firstColon !== host.lastIndexOf(":")
        || !/^\d+$/u.test(host.slice(firstColon + 1)))
    ) {
      return undefined;
    }
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function refuse(response: ServerResponse, status: number, body: string): void {
  response.setHeader("Connection", "close");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.writeHead(status).end(body);
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
