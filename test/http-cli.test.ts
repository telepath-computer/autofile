/** Exercises the built Autofile command through a real Streamable HTTP socket. */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { open, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, test } from "node:test";

import {
  Client,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";

import { openStore } from "../dist/store.js";

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

function assertToolJson(
  result: CallToolResult,
  expected: unknown,
  options: { isError?: boolean } = {},
): void {
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.ok(content !== undefined && content.type === "text");
  assert.deepEqual(JSON.parse(content.text) as unknown, expected);
  if (options.isError === true) assert.equal(result.isError, true);
  else assert.notEqual(result.isError, true);
}

interface ResourceNotices {
  listChanged: number;
  listeners: Set<() => void>;
  updated: string[];
}

interface ResourceNoticeCheckpoint {
  listChanged: number;
  updated: number;
}

function collectResourceNotices(client: Client): ResourceNotices {
  const notices: ResourceNotices = { listChanged: 0, listeners: new Set(), updated: [] };
  client.setNotificationHandler("notifications/resources/updated", (notification) => {
    notices.updated.push(notification.params.uri);
    for (const listener of notices.listeners) listener();
  });
  client.setNotificationHandler("notifications/resources/list_changed", () => {
    notices.listChanged += 1;
    for (const listener of notices.listeners) listener();
  });
  return notices;
}

function resourceNoticeCheckpoint(notices: ResourceNotices): ResourceNoticeCheckpoint {
  return { listChanged: notices.listChanged, updated: notices.updated.length };
}

async function waitForResourceNoticeCondition(
  notices: ResourceNotices,
  condition: () => boolean,
  message: string,
): Promise<void> {
  if (condition()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        `${message}; received ${JSON.stringify(notices.updated)} and ${String(notices.listChanged)} list changes`,
      ));
    }, 10_000);
    const listener = () => {
      if (!condition()) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      notices.listeners.delete(listener);
    };
    notices.listeners.add(listener);
  });
}

async function expectResourceNotices(
  notices: ResourceNotices,
  start: ResourceNoticeCheckpoint,
  expectedUpdated: string[],
  expectsListChanged: boolean,
  message: string,
): Promise<void> {
  await waitForResourceNoticeCondition(
    notices,
    () => (
      expectedUpdated.every((uri) => notices.updated.slice(start.updated).includes(uri))
      && (!expectsListChanged || notices.listChanged > start.listChanged)
    ),
    message,
  );
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

test("serve publishes watched resource and list changes over HTTP", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const dataFolder = join(root, "data");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(root, "autofile-home", "write.lock"),
  });
  await store.createType({
    type: "tasks",
    description: "Things to do.",
    titleField: "title",
    schema: {
      type: "object",
      required: ["title", "status"],
      properties: {
        title: { type: "string" },
        status: { type: "string" },
      },
      additionalProperties: false,
    },
  });
  await store.createRecord({
    type: "tasks",
    key: "watched",
    record: { title: "Watched", status: "active" },
  });

  const server = await startServer({ config: { storage: dataFolder } });
  const otherServer = await startServer({ config: { storage: dataFolder } });
  const client = await connect(server.endpoint);
  const other = await connect(otherServer.endpoint);
  const notices = collectResourceNotices(client);
  const blobName = `${"c".repeat(64)}.txt`;
  const blobUri = `autofile:///_blobs/${blobName}`;
  const resourceSubscriptions = [
    "autofile:///tasks/watched",
    "autofile:///tasks/outside",
    "autofile:///tasks/.ignored",
    "autofile:///tasks/sentinel",
    "autofile:///tasks",
    "autofile:///_types/tasks",
    "autofile:///_types/watched-type",
    "autofile:///_types/reborn",
    "autofile:///_types",
    blobUri,
    "autofile:///_blobs",
    "autofile:///reborn/new",
    "autofile:///reborn",
    "autofile:///",
  ];
  const subscription = await client.listen({
    resourceSubscriptions,
    resourcesListChanged: true,
  });
  assert.deepEqual(subscription.honoredFilter, {
    resourcesListChanged: true,
    resourceSubscriptions,
  });

  try {
    let checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await client.callTool({
      name: "update_record",
      arguments: { uri: "autofile:///tasks/watched", patch: { status: "complete" } },
    }), { uri: "autofile:///tasks/watched" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/watched",
      "autofile:///tasks",
      "autofile:///",
    ], false, "same-process HTTP change notices did not arrive");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "update_record",
      arguments: { uri: "autofile:///tasks/watched", patch: { title: "Changed elsewhere" } },
    }), { uri: "autofile:///tasks/watched" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/watched",
      "autofile:///tasks",
      "autofile:///",
    ], true, "cross-process HTTP change notices did not arrive");

    const timestamp = new Date().toISOString();
    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(join(dataFolder, "tasks", "outside.json"), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: "Outside", status: "active" },
    }, null, 2)}\n`);
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/outside",
      "autofile:///tasks",
      "autofile:///",
    ], true, "outside HTTP record notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(join(dataFolder, "tasks", ".ignored.json"), "{}\n");
    assertToolJson(await client.callTool({
      name: "create_record",
      arguments: {
        type: "tasks",
        key: "sentinel",
        record: { title: "Sentinel", status: "active" },
      },
    }), { uri: "autofile:///tasks/sentinel" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/sentinel",
      "autofile:///tasks",
      "autofile:///",
    ], true, "the HTTP sentinel change after an ignored file was not reported");
    assert.equal(
      notices.updated.slice(checkpoint.updated).includes("autofile:///tasks/.ignored"),
      false,
      "an ignored file produced an HTTP resource notice",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "delete_record",
      arguments: { uri: "autofile:///tasks/outside" },
    }), { uri: "autofile:///tasks/outside" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/outside",
      "autofile:///tasks",
      "autofile:///",
    ], true, "HTTP record deletion notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "create_type",
      arguments: {
        type: "watched-type",
        description: "Watched declarations.",
        schema: { type: "object" },
      },
    }), { uri: "autofile:///_types/watched-type" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/watched-type",
      "autofile:///_types",
      "autofile:///",
    ], true, "HTTP declaration creation notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "update_type",
      arguments: { type: "watched-type", description: "Changed declarations." },
    }), { uri: "autofile:///_types/watched-type", errors: [] });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/watched-type",
      "autofile:///_types",
      "autofile:///",
    ], true, "HTTP declaration change notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "delete_type",
      arguments: { type: "watched-type" },
    }), { uri: "autofile:///_types/watched-type" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/watched-type",
      "autofile:///_types",
      "autofile:///",
    ], true, "HTTP declaration deletion notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await mkdir(join(dataFolder, "_blobs"), { recursive: true });
    await writeFile(join(dataFolder, "_blobs", blobName), "watched blob");
    await expectResourceNotices(notices, checkpoint, [
      blobUri,
      "autofile:///_blobs",
      "autofile:///",
    ], true, "HTTP blob creation notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(join(dataFolder, "_blobs", blobName), "changed watched blob");
    await expectResourceNotices(notices, checkpoint, [
      blobUri,
      "autofile:///_blobs",
      "autofile:///",
    ], false, "HTTP blob change notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await unlink(join(dataFolder, "_blobs", blobName));
    await expectResourceNotices(notices, checkpoint, [
      blobUri,
      "autofile:///_blobs",
      "autofile:///",
    ], true, "HTTP blob deletion notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await rm(dataFolder, { recursive: true });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/tasks",
      "autofile:///_types",
      "autofile:///",
      "autofile:///tasks/watched",
      "autofile:///tasks",
      "autofile:///",
    ], true, "HTTP data-folder deletion notices did not arrive");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "create_type",
      arguments: {
        type: "reborn",
        description: "Recreated data.",
        titleField: "title",
        schema: {
          type: "object",
          required: ["title", "status"],
          properties: {
            title: { type: "string" },
            status: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    }), { uri: "autofile:///_types/reborn" });
    assertToolJson(await other.callTool({
      name: "create_record",
      arguments: {
        type: "reborn",
        key: "new",
        record: { title: "New", status: "active" },
      },
    }), { uri: "autofile:///reborn/new" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/reborn",
      "autofile:///_types",
      "autofile:///",
      "autofile:///reborn/new",
      "autofile:///reborn",
      "autofile:///",
    ], true, "HTTP notices stopped after data-folder recreation");
  } finally {
    await subscription.close();
  }
});

test("an HTTP agent can search, patch, invalidate, read resources, and clean linked data", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const dataFolder = join(root, "records");
  const localPath = join(root, "local.png");
  const dataBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
  const blobHash = createHash("sha256").update(dataBytes).digest("hex");
  const blobUri = `autofile:///_blobs/${blobHash}.png`;
  await writeFile(localPath, dataBytes);
  const server = await startServer({ config: { storage: dataFolder } });
  const creator = await connect(server.endpoint);

  const organizationSchema = {
    type: "object",
    required: ["name", "logo"],
    properties: {
      name: { type: "string" },
      logo: { type: "string", format: "blob" },
    },
    additionalProperties: false,
  };
  const contactSchema = {
    type: "object",
    required: ["name", "status"],
    properties: {
      name: { type: "string" },
      status: { type: "string", enum: ["active", "complete"] },
      employer: {
        type: "string",
        format: "uri",
        pattern: "^autofile:///organizations/",
      },
      notes: { type: "string" },
      details: { type: "object" },
      labels: { type: "array" },
    },
    additionalProperties: false,
  };
  assert.equal(
    creator.getInstructions(),
    "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.\n\nTypes: none yet. This list was taken when the session began; call `list_types` for types created since.",
  );
  assertToolJson(await creator.callTool({
    name: "create_type",
    arguments: {
      type: "organizations",
      description: "Organizations reached over HTTP.",
      titleField: "name",
      schema: organizationSchema,
    },
  }), { uri: "autofile:///_types/organizations" });
  assertToolJson(await creator.callTool({
    name: "create_type",
    arguments: {
      type: "contacts",
      description: "Contacts reached over HTTP.",
      titleField: "name",
      schema: contactSchema,
    },
  }), { uri: "autofile:///_types/contacts" });

  const client = await connect(server.endpoint);
  assert.equal(client.getServerVersion()?.description, "Typed records that agents file and retrieve, kept as JSON files in a folder the user owns.");
  assert.match(client.getInstructions() ?? "", /Types: contacts, organizations\./u);

  const refusedPath = await client.callTool({
    name: "create_record",
    arguments: {
      type: "organizations",
      key: "local",
      record: { name: "Local path", logo: localPath },
    },
  });
  const refusedPathBody = asObject(refusedPath.structuredContent);
  assert.ok(Array.isArray(refusedPathBody.errors));
  assert.match(String(asObject(refusedPathBody.errors[0]).message), /only over stdio, not HTTP/u);
  assertToolJson(refusedPath, refusedPathBody, { isError: true });

  const createdOrganization = await client.callTool({
    name: "create_record",
    arguments: {
      type: "organizations",
      record: {
        name: "Network Acme",
        logo: `data:image/png;base64,${dataBytes.toString("base64")}`,
      },
    },
  });
  const createdOrganizationBody = asObject(createdOrganization.structuredContent);
  const organizationUri = String(createdOrganizationBody.uri);
  assert.match(organizationUri, /^autofile:\/\/\/organizations\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/u);
  assertToolJson(createdOrganization, createdOrganizationBody);

  const missingUri = "autofile:///organizations/missing";
  const refusedLink = await client.callTool({
    name: "create_record",
    arguments: {
      type: "contacts",
      key: "missing-link",
      record: { name: "Missing", status: "active", employer: missingUri },
    },
  });
  assertToolJson(refusedLink, {
    errors: [{
      uri: "autofile:///contacts/missing-link",
      message: `employer: links to a record that does not exist: ${missingUri}`,
    }],
  }, { isError: true });

  const contactUri = "autofile:///contacts/ada";
  assertToolJson(await client.callTool({
    name: "create_record",
    arguments: {
      type: "contacts",
      key: "ada",
      record: {
        name: "Ada Lovelace",
        status: "active",
        employer: organizationUri,
        notes: "Analytical engines and mathematics.",
        details: { role: "Engineer", remove: true },
        labels: ["old"],
      },
    },
  }), { uri: contactUri });

  const found = await client.callTool({
    name: "find_records",
    arguments: {
      type: "contacts",
      q: "ada engines",
      where: { status: "active", employer: organizationUri },
      fields: ["name"],
    },
  });
  const foundBody = asObject(found.structuredContent);
  assert.ok(Array.isArray(foundBody.records));
  assert.equal(foundBody.records.length, 1);
  assert.deepEqual(asObject(foundBody.records[0]).value, { name: "Ada Lovelace" });
  assert.deepEqual(foundBody.errors, []);
  assertToolJson(found, foundBody);

  const beforePatchResult = await client.callTool({
    name: "get_record",
    arguments: { uri: contactUri },
  });
  const beforePatch = asObject(beforePatchResult.structuredContent);
  assertToolJson(beforePatchResult, beforePatch);
  assertToolJson(await client.callTool({
    name: "update_record",
    arguments: {
      uri: contactUri,
      patch: {
        details: { remove: null, note: "kept" },
        labels: ["new"],
      },
    },
  }), { uri: contactUri });
  const afterPatchResult = await client.callTool({
    name: "get_record",
    arguments: { uri: contactUri },
  });
  const afterPatch = asObject(afterPatchResult.structuredContent);
  assert.equal(afterPatch.createdAt, beforePatch.createdAt);
  assert.notEqual(afterPatch.updatedAt, beforePatch.updatedAt);
  assert.deepEqual(asObject(afterPatch.value).details, { role: "Engineer", note: "kept" });
  assert.deepEqual(asObject(afterPatch.value).labels, ["new"]);
  assertToolJson(afterPatchResult, afterPatch);

  const completeOnlySchema = {
    ...contactSchema,
    properties: {
      ...contactSchema.properties,
      status: { const: "complete" },
    },
  };
  const changedType = await client.callTool({
    name: "update_type",
    arguments: { type: "contacts", schema: completeOnlySchema },
  });
  const changedTypeBody = asObject(changedType.structuredContent);
  assert.equal(changedTypeBody.uri, "autofile:///_types/contacts");
  assert.ok(Array.isArray(changedTypeBody.errors));
  assert.equal(asObject(changedTypeBody.errors[0]).uri, contactUri);
  assert.match(String(asObject(changedTypeBody.errors[0]).message), /status/u);
  assertToolJson(changedType, changedTypeBody);

  const invalidSearch = await client.callTool({
    name: "find_records",
    arguments: { type: "contacts", q: "Ada", where: { status: "active" } },
  });
  const invalidSearchBody = asObject(invalidSearch.structuredContent);
  assert.deepEqual(invalidSearchBody.records, []);
  assert.ok(Array.isArray(invalidSearchBody.errors));
  assert.equal(asObject(invalidSearchBody.errors[0]).uri, contactUri);
  assertToolJson(invalidSearch, invalidSearchBody);

  const invalidRecord = await client.callTool({
    name: "get_record",
    arguments: { uri: contactUri },
  });
  const invalidRecordBody = asObject(invalidRecord.structuredContent);
  assert.match(String(invalidRecordBody.error), /status/u);
  assertToolJson(invalidRecord, invalidRecordBody);

  assertToolJson(await client.callTool({
    name: "update_record",
    arguments: { uri: contactUri, patch: { status: "complete" } },
  }), { uri: contactUri });
  const repairedResult = await client.callTool({
    name: "get_record",
    arguments: { uri: contactUri },
  });
  const repaired = asObject(repairedResult.structuredContent);
  assert.equal("error" in repaired, false);
  assertToolJson(repairedResult, repaired);

  const resources = await client.listResources();
  assert.equal(resources.ttlMs, 0);
  assert.equal(resources.cacheScope, "private");
  assert.deepEqual(resources.resources.find(({ uri }) => uri === "autofile:///_types/contacts"), {
    uri: "autofile:///_types/contacts",
    name: "_types/contacts",
    mimeType: "application/json",
    description: "Contacts reached over HTTP.",
  });
  assert.deepEqual(resources.resources.find(({ uri }) => uri === contactUri), {
    uri: contactUri,
    name: "contacts/ada",
    title: "Ada Lovelace",
    mimeType: "application/json",
    annotations: { lastModified: repaired.updatedAt },
  });
  assert.deepEqual(resources.resources.find(({ uri }) => uri === blobUri), {
    uri: blobUri,
    name: `_blobs/${blobHash}.png`,
    mimeType: "image/png",
    size: dataBytes.byteLength,
  });

  const declaration = await client.readResource({ uri: "autofile:///_types/contacts" });
  const declarationContent = declaration.contents[0];
  assert.ok(declarationContent !== undefined && "text" in declarationContent);
  assert.deepEqual(JSON.parse(declarationContent.text) as unknown, {
    description: "Contacts reached over HTTP.",
    titleField: "name",
    schema: completeOnlySchema,
  });
  const blob = await client.readResource({ uri: blobUri });
  assert.deepEqual(blob.contents, [{
    uri: blobUri,
    mimeType: "image/png",
    blob: dataBytes.toString("base64"),
  }]);

  assertToolJson(await client.callTool({
    name: "delete_record",
    arguments: { uri: organizationUri },
  }), { uri: organizationUri });
  const afterDeleteResult = await client.callTool({
    name: "get_record",
    arguments: { uri: contactUri },
  });
  const afterDelete = asObject(afterDeleteResult.structuredContent);
  assert.equal("employer" in asObject(afterDelete.value), false);
  assertToolJson(afterDeleteResult, afterDelete);
  await assert.rejects(
    client.readResource({ uri: blobUri }),
    (error: unknown) => error instanceof ProtocolError && error.code === -32602,
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
  const server = await startServer({ config: { http: { origins: ["http://app.example.com"] } } });
  const cases = [
    { host: `LOCALHOST:${server.endpoint.port}`, accepted: true },
    { host: "127.0.0.1:1", accepted: true },
    { host: "[0:0:0:0:0:0:0:1]:7319", accepted: true },
    { host: "app.example.com:443", accepted: true },
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
  assert.equal(await response.text(), "Not Found\n");
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
