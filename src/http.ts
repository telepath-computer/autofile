/** Mounts Autofile's transport-independent MCP server on Node's HTTP server. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { normalizeHttpOrigin, type HttpSettings } from "./config.js";
import { buildServer } from "./server.js";
import type { Autofile } from "./index.js";
import { watchResources } from "./mcp-watch.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const CORS_ALLOW_HEADERS = "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name";

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
  const handler = createMcpHandler(() => buildServer(store), {
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
    void routeRequest(request, response, allowedOrigins, allowedHosts, serveMcp);
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
): Promise<void> {
  if (!isAllowedHost(request.headers.host, allowedHosts)) {
    refuse(response, 403, "Forbidden\n");
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin, allowedOrigins)) {
    refuse(response, 403, "Forbidden\n");
    return;
  }
  if (requestPath(request) !== "/mcp") {
    refuse(response, 404, "Not Found\n");
    return;
  }
  if (origin !== undefined) setCorsHeaders(response, origin);

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
  response.writeHead(status).end(body);
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
