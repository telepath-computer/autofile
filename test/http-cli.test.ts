/** Exercises the built Autofile command through a real Streamable HTTP socket. */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { open, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, test } from "node:test";

import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const cli = resolve("dist/cli.js");
const roots: string[] = [];
const servers: StartedServer[] = [];
const clients: Client[] = [];

interface StartedServer {
  child: ChildProcess;
  endpoint: URL;
  listeningLine: string;
}

interface StartOptions {
  config?: object;
  port?: number;
  useConfiguredAddress?: boolean;
}

interface HttpResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-http-cli-"));
  roots.push(root);
  return root;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      assert.ok(address !== null && typeof address === "object");
      resolvePort(address.port);
    });
  });
  await new Promise<void>((resolveClose, reject) => {
    probe.close((error) => error === undefined ? resolveClose() : reject(error));
  });
  return port;
}

async function startServer(options: StartOptions = {}): Promise<StartedServer> {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  if (options.config !== undefined) {
    await mkdir(autofileHome, { recursive: true });
    await writeFile(
      join(autofileHome, "config.json"),
      `${JSON.stringify(options.config, null, 2)}\n`,
    );
  }
  const port = options.port ?? await freePort();
  const stderrPath = join(root, "stderr");
  const stderrFile = await open(stderrPath, "w");
  const commandArgs = options.useConfiguredAddress === true
    ? [cli, "serve"]
    : [cli, "serve", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn(
    process.execPath,
    commandArgs,
    {
      env: {
        AUTOFILE_HOME: autofileHome,
        HOME: root,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
      stdio: ["ignore", "ignore", stderrFile.fd],
    },
  );
  await stderrFile.close();
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const listeningLine = `autofile: listening on ${endpoint.href}\n`;
  const started = { child, endpoint, listeningLine };
  servers.push(started);

  for (let attempts = 0; attempts < 500; attempts += 1) {
    const stderr = await readFile(stderrPath, "utf8");
    if (stderr === listeningLine) return started;
    if (child.exitCode !== null) {
      assert.fail(`autofile serve exited with ${child.exitCode}: ${stderr}`);
    }
    await delay(20);
  }
  child.kill("SIGKILL");
  assert.fail(`autofile serve did not listen: ${await readFile(stderrPath, "utf8")}`);
}

async function connect(endpoint: URL, origin?: string): Promise<Client> {
  const client = new Client(
    { name: "autofile-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(origin === undefined ? {} : { requestInit: { headers: { Origin: origin } } }),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function request(
  endpoint: URL,
  options: { body?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<HttpResponse> {
  return await new Promise<HttpResponse>((resolveResponse, reject) => {
    const outgoing = httpRequest(endpoint, {
      method: options.method,
      headers: options.headers,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolveResponse({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: incoming.headers,
        status: incoming.statusCode ?? 0,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function stopServer(server: StartedServer, timeout = 5_000): Promise<boolean> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return true;
  const closed = once(server.child, "close");
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    server.child.kill("SIGKILL");
  }, timeout);
  server.child.kill("SIGTERM");
  await closed;
  clearTimeout(timer);
  return !forced;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await stopServer(server);
});

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("serve shares one store across HTTP tool and resource requests", { timeout: 30_000 }, async () => {
  const server = await startServer();
  const client = await connect(server.endpoint);

  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.deepEqual(
    (await client.callTool({
      name: "create_type",
      arguments: {
        type: "notes",
        description: "Notes to keep.",
        titleField: "title",
        schema: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
      },
    })).structuredContent,
    { uri: "autofile:///_types/notes" },
  );
  assert.deepEqual(
    (await client.callTool({
      name: "create_record",
      arguments: { type: "notes", key: "first", record: { title: "First note" } },
    })).structuredContent,
    { uri: "autofile:///notes/first" },
  );

  const resources = await client.listResources();
  assert.deepEqual(
    resources.resources.map(({ uri }) => uri),
    ["autofile:///_types/notes", "autofile:///notes/first"],
  );
  const record = await client.readResource({ uri: "autofile:///notes/first" });
  const content = record.contents[0];
  assert.ok(content !== undefined && "text" in content);
  const stored = asObject(JSON.parse(content.text) as unknown);
  assert.equal(asObject(stored.value).title, "First note");
});

test("serve refuses local blob paths and accepts data URIs", { timeout: 30_000 }, async () => {
  const root = await temp();
  const dataFolder = join(root, "records");
  const blobFolder = join(dataFolder, "_blobs");
  const sourcePath = join(root, "local.pdf");
  const localBytes = Buffer.from("local path contents\n", "utf8");
  await Promise.all([
    mkdir(blobFolder, { recursive: true }),
    writeFile(sourcePath, localBytes),
  ]);
  const server = await startServer({ config: { storage: dataFolder } });
  const client = await connect(server.endpoint);
  await client.callTool({
    name: "create_type",
    arguments: {
      type: "receipts",
      description: "Receipts with scans.",
      schema: {
        type: "object",
        required: ["scan"],
        properties: { scan: { type: "string", format: "blob" } },
        additionalProperties: false,
      },
    },
  });

  const refusedCreate = await client.callTool({
    name: "create_record",
    arguments: {
      type: "receipts",
      key: "local",
      record: { scan: sourcePath },
    },
  });
  assert.equal(refusedCreate.isError, true);
  const createBody = asObject(refusedCreate.structuredContent);
  assert.ok(Array.isArray(createBody.errors));
  assert.match(String(asObject(createBody.errors[0]).message), /HTTP/iu);
  assert.deepEqual(await readdir(blobFolder), []);
  assert.deepEqual(
    (await client.listResources()).resources.map(({ uri }) => uri),
    ["autofile:///_types/receipts"],
  );

  const dataBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
  const hash = createHash("sha256").update(dataBytes).digest("hex");
  const blobUri = `autofile:///_blobs/${hash}.pdf`;
  assert.deepEqual((await client.callTool({
    name: "create_record",
    arguments: {
      type: "receipts",
      key: "uploaded",
      record: { scan: `data:application/pdf;base64,${dataBytes.toString("base64")}` },
    },
  })).structuredContent, { uri: "autofile:///receipts/uploaded" });

  const record = await client.readResource({ uri: "autofile:///receipts/uploaded" });
  const recordContent = record.contents[0];
  assert.ok(recordContent !== undefined && "text" in recordContent);
  const stored = asObject(JSON.parse(recordContent.text) as unknown);
  assert.deepEqual(stored.value, { scan: blobUri });
  const blob = await client.readResource({ uri: blobUri });
  assert.deepEqual({
    contents: blob.contents,
    ttlMs: blob.ttlMs,
    cacheScope: blob.cacheScope,
  }, {
    contents: [{
      uri: blobUri,
      mimeType: "application/pdf",
      blob: dataBytes.toString("base64"),
    }],
    ttlMs: 0,
    cacheScope: "private",
  });

  const filesBeforeUpdate = await readdir(blobFolder);
  const refusedUpdate = await client.callTool({
    name: "update_record",
    arguments: {
      uri: "autofile:///receipts/uploaded",
      patch: { scan: sourcePath },
    },
  });
  assert.equal(refusedUpdate.isError, true);
  const updateBody = asObject(refusedUpdate.structuredContent);
  assert.ok(Array.isArray(updateBody.errors));
  assert.match(String(asObject(updateBody.errors[0]).message), /HTTP/iu);
  assert.deepEqual(await readdir(blobFolder), filesBeforeUpdate);
  const recordAfterRefusal = await client.readResource({ uri: "autofile:///receipts/uploaded" });
  const contentAfterRefusal = recordAfterRefusal.contents[0];
  assert.ok(contentAfterRefusal !== undefined && "text" in contentAfterRefusal);
  assert.deepEqual(
    asObject(JSON.parse(contentAfterRefusal.text) as unknown).value,
    { scan: blobUri },
  );
});

test("serve shares data URI blobs and collects them after update and delete", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const dataFolder = join(root, "records");
  const shared = Buffer.from("shared over HTTP\n", "utf8");
  const first = Buffer.from("first over HTTP\n", "utf8");
  const second = Buffer.from("second over HTTP\n", "utf8");
  const replacement = Buffer.from("replacement over HTTP\n", "utf8");
  const dataUri = (bytes: Buffer): string => (
    `data:text/plain;base64,${bytes.toString("base64")}`
  );
  const blobUri = (bytes: Buffer): string => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    return `autofile:///_blobs/${hash}.txt`;
  };
  const sharedUri = blobUri(shared);
  const firstUri = blobUri(first);
  const secondUri = blobUri(second);
  const replacementUri = blobUri(replacement);
  const server = await startServer({ config: { storage: dataFolder } });
  const client = await connect(server.endpoint);
  await client.callTool({
    name: "create_type",
    arguments: {
      type: "assets",
      description: "Files uploaded over HTTP.",
      schema: {
        type: "object",
        required: ["shared", "unique"],
        properties: {
          shared: { type: "string", format: "blob" },
          unique: { type: "string", format: "blob" },
        },
        additionalProperties: false,
      },
    },
  });
  for (const [key, unique] of [["first", first], ["second", second]] as const) {
    assert.deepEqual((await client.callTool({
      name: "create_record",
      arguments: {
        type: "assets",
        key,
        record: { shared: dataUri(shared), unique: dataUri(unique) },
      },
    })).structuredContent, { uri: `autofile:///assets/${key}` });
  }

  let blobUris = (await client.listResources()).resources
    .map(({ uri }) => uri)
    .filter((uri) => uri.startsWith("autofile:///_blobs/"));
  assert.deepEqual(blobUris.sort(), [firstUri, secondUri, sharedUri].sort());
  assert.equal(blobUris.filter((uri) => uri === sharedUri).length, 1);

  assert.deepEqual((await client.callTool({
    name: "update_record",
    arguments: {
      uri: "autofile:///assets/first",
      patch: { unique: dataUri(replacement) },
    },
  })).structuredContent, { uri: "autofile:///assets/first" });
  blobUris = (await client.listResources()).resources
    .map(({ uri }) => uri)
    .filter((uri) => uri.startsWith("autofile:///_blobs/"));
  assert.deepEqual(blobUris.sort(), [replacementUri, secondUri, sharedUri].sort());
  assert.equal(blobUris.includes(firstUri), false);

  assert.deepEqual((await client.callTool({
    name: "delete_record",
    arguments: { uri: "autofile:///assets/second" },
  })).structuredContent, { uri: "autofile:///assets/second" });
  blobUris = (await client.listResources()).resources
    .map(({ uri }) => uri)
    .filter((uri) => uri.startsWith("autofile:///_blobs/"));
  assert.deepEqual(blobUris.sort(), [replacementUri, sharedUri].sort());
  assert.equal(blobUris.includes(secondUri), false);

  const kept = await client.readResource({ uri: sharedUri });
  assert.ok(kept.contents[0] !== undefined && "blob" in kept.contents[0]);
  assert.equal(kept.contents[0].blob, shared.toString("base64"));
});

test("serve refuses a path exposed by a conditional blob annotation", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const dataFolder = join(root, "records");
  const sourcePath = join(root, "local.txt");
  await writeFile(sourcePath, "local contents\n", "utf8");
  const server = await startServer({ config: { storage: dataFolder } });
  const client = await connect(server.endpoint);
  await client.callTool({
    name: "create_type",
    arguments: {
      type: "conditional-assets",
      description: "Files whose active blob field is selected conditionally.",
      schema: {
        type: "object",
        required: ["primary", "fallback"],
        properties: {
          primary: { type: "string" },
          fallback: { type: "string" },
        },
        allOf: [{
          if: {
            properties: { primary: { pattern: "^data:" } },
            required: ["primary"],
          },
          then: { properties: { primary: { type: "string", format: "blob" } } },
          else: { properties: { fallback: { type: "string", format: "blob" } } },
        }],
        additionalProperties: false,
      },
    },
  });

  const refused = await client.callTool({
    name: "create_record",
    arguments: {
      type: "conditional-assets",
      key: "refused",
      record: {
        primary: `data:text/plain;base64,${Buffer.from("uploaded\n").toString("base64")}`,
        fallback: sourcePath,
      },
    },
  });
  assert.equal(refused.isError, true);
  const body = asObject(refused.structuredContent);
  assert.ok(Array.isArray(body.errors));
  assert.match(String(asObject(body.errors[0]).message), /blob URI/iu);
  assert.deepEqual(
    (await client.listResources()).resources.map(({ uri }) => uri),
    ["autofile:///_types/conditional-assets"],
  );
});

test("serve options override HTTP settings for that process", { timeout: 30_000 }, async () => {
  const port = await freePort();
  const server = await startServer({
    port,
    config: { http: { host: "192.0.2.1", port: 1 } },
  });

  assert.equal(server.listeningLine, `autofile: listening on http://127.0.0.1:${port}/mcp\n`);
  const client = await connect(server.endpoint);
  assert.deepEqual((await client.callTool({ name: "list_types", arguments: {} })).structuredContent, {
    types: [],
  });
});

test("serve uses the default host when only the port is configured", {
  timeout: 30_000,
}, async () => {
  const port = await freePort();
  const server = await startServer({
    port,
    useConfiguredAddress: true,
    config: { http: { port } },
  });

  const client = await connect(server.endpoint);
  assert.deepEqual((await client.callTool({ name: "list_types", arguments: {} })).structuredContent, {
    types: [],
  });
});

test("serve checks normalized localhost, configured, null, and foreign Origins", {
  timeout: 30_000,
}, async () => {
  const server = await startServer({
    config: { http: { origins: ["HTTPS://APP.EXAMPLE:443"] } },
  });
  const cases = [
    { origin: "HTTP://LOCALHOST:80", accepted: true },
    { origin: "https://127.0.0.1:443", accepted: true },
    { origin: "http://[0:0:0:0:0:0:0:1]:80", accepted: true },
    { origin: "https://APP.EXAMPLE:443", accepted: true },
    { origin: "null", accepted: false },
    { origin: "https://foreign.example", accepted: false },
  ];

  for (const { origin, accepted } of cases) {
    if (accepted) {
      const client = await connect(server.endpoint, origin);
      assert.equal((await client.listTools()).tools.length, 10, origin);
    } else {
      const response = await fetch(server.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: "{}",
      });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get("connection"), "close", origin);
    }
  }

  const client = await connect(server.endpoint);
  assert.equal((await client.listTools()).tools.length, 10);
});

test("serve checks Host against localhost and configured origin hosts", {
  timeout: 30_000,
}, async () => {
  const server = await startServer({ config: { http: { origins: ["http://RUBOT"] } } });
  const cases = [
    { host: `LOCALHOST:${server.endpoint.port}`, accepted: true },
    { host: "127.0.0.1:1", accepted: true },
    { host: "[0:0:0:0:0:0:0:1]:7319", accepted: true },
    { host: "RUBOT:443", accepted: true },
    { host: "foreign.example", accepted: false },
  ];

  for (const { host, accepted } of cases) {
    const response = await request(server.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: host,
      },
      body: "{}",
    });
    if (accepted) assert.notEqual(response.status, 403, host);
    else {
      assert.equal(response.status, 403, host);
      assert.equal(response.headers.connection, "close", host);
    }
  }
});

test("a refused valid write leaves the shared store unchanged", {
  timeout: 30_000,
}, async () => {
  const server = await startServer();
  const client = await connect(server.endpoint);
  await client.callTool({
    name: "create_type",
    arguments: {
      type: "notes",
      description: "Notes to keep.",
      titleField: "title",
      schema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    },
  });

  const response = await request(server.endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "create_record",
      Origin: "https://foreign.example",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_record",
        arguments: { type: "notes", key: "refused", record: { title: "Refused" } },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.connection, "close");
  assert.deepEqual(
    (await client.listResources()).resources.map(({ uri }) => uri),
    ["autofile:///_types/notes"],
  );
});

test("serve answers accepted CORS preflights", { timeout: 30_000 }, async () => {
  const origin = "https://app.example";
  const server = await startServer({ config: { http: { origins: [origin] } } });
  const response = await fetch(server.endpoint, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,mcp-protocol-version,mcp-method,mcp-name",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  );
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("connection"), "close");

  const actual = await fetch(server.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  });
  assert.equal(actual.headers.get("access-control-allow-origin"), origin);
  assert.equal(actual.headers.get("vary"), "Origin");
});

test("serve returns 404 outside /mcp", { timeout: 30_000 }, async () => {
  const server = await startServer();
  const response = await fetch(new URL("/elsewhere", server.endpoint));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("connection"), "close");
});

test("SIGTERM closes an active connection without falling back to SIGKILL", {
  timeout: 30_000,
}, async () => {
  const server = await startServer();
  const socket = createConnection({
    host: server.endpoint.hostname,
    port: Number(server.endpoint.port),
  });
  socket.on("error", () => {
    // The server deliberately resets held-open connections during shutdown.
  });
  await once(socket, "connect");
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.endpoint.port}\r\nContent-Length: 100\r\n\r\n{`,
  );

  try {
    assert.equal(await stopServer(server, 2_000), true);
    assert.equal(server.child.exitCode, 0);
    assert.equal(server.child.signalCode, null);
  } finally {
    socket.destroy();
  }
});

test("serve refuses a 2025-era client", { timeout: 30_000 }, async () => {
  const server = await startServer();
  const client = new Client(
    { name: "autofile-http-legacy-test", version: "1.0.0" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  const transport = new StreamableHTTPClientTransport(server.endpoint);

  try {
    await assert.rejects(client.connect(transport), (error: unknown) => {
      assert.ok(error instanceof SdkHttpError);
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await client.close();
  }
});
