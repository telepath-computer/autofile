/** Exercises the built Autofile MCP command over its real stdio transport. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  Client,
  ProtocolError,
  type CallToolResult,
  type ListResourcesResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { openStore } from "./helpers/store.ts";

const cli = resolve("dist/cli.js");
const roots: string[] = [];
const serverDescription = "Typed records that agents file and retrieve.";
const baseInstructions = "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.";

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-mcp-cli-"));
  roots.push(root);
  return root;
}

function environment(
  root: string,
  autofileHome: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    AUTOFILE_HOME: autofileHome,
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ...overrides,
  };
}

async function connectCommand(
  root: string,
  autofileHome: string,
  name: string,
  options: {
    args?: string[];
    command?: string;
    environment?: Record<string, string>;
    onStderr?: (text: string) => void;
  } = {},
): Promise<Client> {
  const client = new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: options.command ?? process.execPath,
    args: options.args ?? [cli],
    env: environment(root, autofileHome, options.environment),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    const text = String(chunk);
    stderr += text;
    options.onStderr?.(text);
  });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(
      `stdio connection failed${stderr === "" ? "" : `: ${stderr.trim()}`}`,
      { cause: error },
    );
  }
  return client;
}

interface TextLog {
  listeners: Set<() => void>;
  text: string;
}

function appendText(log: TextLog, text: string): void {
  log.text += text;
  for (const listener of log.listeners) listener();
}

async function waitForText(log: TextLog, expected: string, message: string): Promise<void> {
  const hasExpectedText = (): boolean => log.text.includes(expected);
  if (hasExpectedText()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${message}; received ${JSON.stringify(log.text)}`));
    }, 10_000);
    const listener = () => {
      if (!hasExpectedText()) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      log.listeners.delete(listener);
    };
    log.listeners.add(listener);
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

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the built command exits when its initial resource listing cannot read a record", {
  timeout: 15_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(autofileHome, "data");
  const store = await openStore({ dataFolder, writeLockPath: join(autofileHome, "write.lock") });
  await store.createType({ type: "notes", description: "Notes", schema: { type: "object" } });
  await store.createRecord({ type: "notes", key: "unreadable", record: {} });
  const recordPath = join(dataFolder, "notes", "unreadable.json");
  await chmod(recordPath, 0o000);
  const child = spawn("/usr/bin/setpriv", [
    "--securebits", "+noroot,+noroot_locked",
    "--bounding-set=-dac_override,-dac_read_search",
    "--inh-caps=-all", "--ambient-caps=-all", process.execPath, cli,
  ], { env: environment(root, autofileHome), stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const status = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.match(stderr, /Storage operation failed/u);
    assert.equal(stderr.includes(dataFolder), false);
    assert.deepEqual(status, { code: 1, signal: null });
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await chmod(recordPath, 0o600);
    await store.autofile.close();
  }
});

test("the built command searches across types and returns titles with projected values", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const client = await connectCommand(root, join(root, "autofile-home"), "autofile-library-api");
  try {
    for (const type of ["tasks", "projects", "notes"]) {
      assertToolJson(await client.callTool({
        name: "create_type",
        arguments: {
          type, description: type, titleField: "name", schema: { type: "object" },
        },
      }), { uri: `autofile:///_types/${type}` });
      assertToolJson(await client.callTool({
        name: "create_record",
        arguments: { type, key: "one", record: { name: `${type} title`, type: "value", status: "active" } },
      }), { uri: `autofile:///${type}/one` });
    }
    for (const [query, expected] of [
      [{ fields: ["status"] }, ["notes", "projects", "tasks"]],
      [{ type: ["tasks", "projects"], where: { type: "value" }, fields: ["status"] }, ["projects", "tasks"]],
    ] as const) {
      const result = await client.callTool({ name: "find_records", arguments: query });
      assert.notEqual(result.isError, true);
      const body = asObject(result.structuredContent);
      assert.ok(Array.isArray(body.records));
      assert.deepEqual(body.records.map((record) => ({
        uri: asObject(record).uri, title: asObject(record).title, value: asObject(record).value,
      })), expected.map((type) => ({
        uri: `autofile:///${type}/one`, title: `${type} title`, value: { status: "active" },
      })));
    }
    const got = await client.callTool({ name: "get_record", arguments: { uri: "autofile:///tasks/one" } });
    assert.equal(asObject(got.structuredContent).title, "tasks title");
  } finally {
    await client.close();
  }
});

test("the built command serves a pinned 2026 client and creates configured storage", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  await mkdir(autofileHome, { recursive: true });
  await writeFile(
    join(autofileHome, "config.json"),
    `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
  );
  const client = new Client(
    { name: "autofile-stdio-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.equal(client.getProtocolEra(), "modern");
    const result = await client.callTool({ name: "list_types", arguments: {} });
    assert.deepEqual(result.structuredContent, { types: [] });

    // Exceed the SDK's 10 MiB default transport limit with an otherwise safe
    // invalid call. Receiving the ordinary tool validation result proves the
    // command's custom 64 MiB server transport read the complete request.
    const oversizedValue = "x".repeat(10 * 1024 * 1024 + 1);
    const oversizedResult = await client.callTool({
      name: "list_types",
      arguments: { unexpected: oversizedValue },
    });
    assert.equal(oversizedResult.isError, true);
    assert.equal(oversizedResult.structuredContent, undefined);
    assert.equal(oversizedResult.content.length, 1);
    assert.equal(oversizedResult.content[0]?.type, "text");
    assert.equal((await stat(dataFolder)).isDirectory(), true);
  } finally {
    await client.close();
  }
});

test("the built command serves an exact 7 MiB blob through a default-limit client", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const blobName = `${"d".repeat(64)}.pdf`;
  const blob = Buffer.alloc(7 * 1024 * 1024, 0xa5);
  blob[0] = 0;
  blob[blob.length - 1] = 0xff;
  await mkdir(join(dataFolder, "_blobs"), { recursive: true });
  await mkdir(autofileHome, { recursive: true });
  await Promise.all([
    writeFile(join(dataFolder, "_blobs", blobName), blob),
    writeFile(
      join(autofileHome, "config.json"),
      `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
    ),
  ]);
  const client = new Client(
    { name: "autofile-stdio-blob-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const result = await client.readResource({ uri: `autofile:///_blobs/${blobName}` });
    const content = result.contents[0];
    assert.ok(content !== undefined && "blob" in content);
    assert.equal(content.mimeType, "application/pdf");
    assert.ok(Buffer.from(content.blob, "base64").equals(blob));
  } finally {
    await client.close();
  }
});

test("the built command uploads local paths over stdio and serves their attachments", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const sourcePath = join(root, "Receipt.PDF");
  const sourceLink = join(root, "Receipt-alias.PDF");
  const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const blobUri = `autofile:///_blobs/${hash}.pdf`;
  await mkdir(autofileHome, { recursive: true });
  await Promise.all([
    writeFile(sourcePath, bytes),
    writeFile(
      join(autofileHome, "config.json"),
      `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
    ),
  ]);
  await symlink(sourcePath, sourceLink);
  const client = new Client(
    { name: "autofile-stdio-path-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    assert.deepEqual((await client.callTool({
      name: "create_type",
      arguments: {
        type: "receipts",
        description: "Receipts with scans.",
        schema: {
          type: "object",
          required: ["scan"],
          properties: { scan: { type: "string", format: "blob", pattern: "\\.pdf$" } },
          additionalProperties: false,
        },
      },
    })).structuredContent, { uri: "autofile:///_types/receipts" });
    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { path: sourceLink } }), { uri: blobUri });
    assertToolJson(await client.callTool({
      name: "create_record",
      arguments: { type: "receipts", key: "first", record: { scan: blobUri } },
    }), { uri: "autofile:///receipts/first" });
    assertToolJson(await client.callTool({
      name: "update_record",
      arguments: { uri: "autofile:///receipts/first", patch: { scan: blobUri } },
    }), { uri: "autofile:///receipts/first" });

    const record = await client.readResource({ uri: "autofile:///receipts/first" });
    const recordContent = record.contents[0];
    assert.ok(recordContent !== undefined && "text" in recordContent);
    const stored = JSON.parse(recordContent.text) as { value: { scan: string } };
    assert.equal(stored.value.scan, blobUri);

    const blob = await client.readResource({ uri: blobUri });
    assert.deepEqual({
      contents: blob.contents,
      ttlMs: blob.ttlMs,
      cacheScope: blob.cacheScope,
    }, {
      contents: [{
        uri: blobUri,
        mimeType: "application/pdf",
        blob: bytes.toString("base64"),
      }],
      ttlMs: 0,
      cacheScope: "private",
    });
  } finally {
    await client.close();
  }
});

test("the built command deduplicates uploaded bytes and collects blobs after update and delete", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const blobFolder = join(dataFolder, "_blobs");
  const shared = Buffer.from("shared by both records\n", "utf8");
  const first = Buffer.from("first record only\n", "utf8");
  const second = Buffer.from("second record only\n", "utf8");
  const replacement = Buffer.from("replacement for first\n", "utf8");
  const uriFor = (bytes: Buffer): string => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    return `autofile:///_blobs/${hash}.txt`;
  };
  const sharedUri = uriFor(shared);
  const firstUri = uriFor(first);
  const secondUri = uriFor(second);
  const replacementUri = uriFor(replacement);
  await mkdir(autofileHome, { recursive: true });
  await writeFile(join(autofileHome, "config.json"), `${JSON.stringify({ storage: dataFolder })}\n`);

  const client = new Client(
    { name: "autofile-stdio-blob-lifecycle-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await client.callTool({
      name: "create_type",
      arguments: {
        type: "assets",
        description: "Files used by tests.",
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
    for (const bytes of [shared, first, second]) {
      assertToolJson(await client.callTool({ name: "upload_blob", arguments: { base64: bytes.toString("base64"), mediaType: "text/plain" } }), { uri: uriFor(bytes) });
    }
    for (const [key, unique] of [["first", firstUri], ["second", secondUri]]) {
      assert.deepEqual((await client.callTool({
        name: "create_record",
        arguments: { type: "assets", key, record: { shared: sharedUri, unique } },
      })).structuredContent, { uri: `autofile:///assets/${key}` });
    }

    assert.deepEqual((await readdir(blobFolder)).sort(), [
      firstUri.split("/").at(-1),
      secondUri.split("/").at(-1),
      sharedUri.split("/").at(-1),
    ].sort());
    assert.equal(
      (await client.listResources()).resources.filter(({ uri }) => uri === sharedUri).length,
      0,
    );

    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { base64: replacement.toString("base64"), mediaType: "text/plain" } }), { uri: replacementUri });
    assert.deepEqual((await client.callTool({
      name: "update_record",
      arguments: {
        uri: "autofile:///assets/first",
        patch: { unique: replacementUri },
      },
    })).structuredContent, { uri: "autofile:///assets/first" });
    for (const uri of [replacementUri, secondUri, sharedUri]) {
      assert.equal((await client.readResource({ uri })).contents[0]?.uri, uri);
    }
    await assert.rejects(client.readResource({ uri: firstUri }));

    assert.deepEqual((await client.callTool({
      name: "delete_record",
      arguments: { uri: "autofile:///assets/second" },
    })).structuredContent, { uri: "autofile:///assets/second" });
    assert.equal((await client.readResource({ uri: replacementUri })).contents[0]?.uri, replacementUri);
    await assert.rejects(client.readResource({ uri: secondUri }));

    const kept = await client.readResource({ uri: sharedUri });
    assert.equal(kept.contents[0]?.uri, sharedUri);
    assert.ok(kept.contents[0] !== undefined && "blob" in kept.contents[0]);
    assert.equal(kept.contents[0].blob, shared.toString("base64"));
  } finally {
    await client.close();
  }
});

test("the built command refuses an upload over 7 MiB with its size and limit", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const oversized = Buffer.alloc(7_340_033).toString("base64");
  await mkdir(autofileHome, { recursive: true });
  await writeFile(
    join(autofileHome, "config.json"),
    `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
  );
  const client = new Client(
    { name: "autofile-stdio-blob-limit-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await client.callTool({
      name: "create_type",
      arguments: {
        type: "assets",
        description: "Files used by tests.",
        schema: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string", format: "blob" } },
          additionalProperties: false,
        },
      },
    });
    const exact = Buffer.alloc(7_340_032, 0xa5);
    const exactUri = `autofile:///_blobs/${createHash("sha256").update(exact).digest("hex")}.pdf`;
    assertToolJson(await client.callTool({ name: "upload_blob", arguments: {
      base64: exact.toString("base64"), mediaType: "application/pdf",
    } }), { uri: exactUri });
    const uploaded = (await client.readResource({ uri: exactUri })).contents[0];
    assert.ok(uploaded !== undefined && "blob" in uploaded);
    assert.deepEqual(Buffer.from(uploaded.blob, "base64"), exact);
    const refused = await client.callTool({
      name: "upload_blob",
      arguments: { base64: oversized, mediaType: "application/octet-stream" },
    });
    assert.equal(refused.isError, true);
    const body = refused.structuredContent as { errors: Array<{ message: string }> };
    assert.match(body.errors[0]?.message ?? "", /7340033/u);
    assert.match(body.errors[0]?.message ?? "", /7340032/u);
    assert.deepEqual(
      (await client.listResources()).resources.map(({ uri }) => uri),
      ["autofile:///_types/assets"],
    );
  } finally {
    await client.close();
  }
});

test("the built command publishes watched resource and list changes over stdio", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(autofileHome, "data");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(autofileHome, "write.lock"),
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

  const client = await connectCommand(root, autofileHome, "autofile-stdio-watcher");
  const other = await connectCommand(root, autofileHome, "autofile-stdio-other-writer");
  const notices = collectResourceNotices(client);
  const blobName = `${"c".repeat(64)}.txt`;
  const blobUri = `autofile:///_blobs/${blobName}`;
  const resourceSubscriptions = [
    "autofile:///tasks/watched",
    "autofile:///tasks/outside",
    "autofile:///tasks/.ignored",
    "autofile:///tasks/sentinel",
    "autofile:///_types/tasks",
    "autofile:///_types/watched-type",
    "autofile:///_types/reborn",
    blobUri,
    "autofile:///reborn/new",
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
    ], false, "same-process change notices did not arrive");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "update_record",
      arguments: { uri: "autofile:///tasks/watched", patch: { title: "Changed elsewhere" } },
    }), { uri: "autofile:///tasks/watched" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/watched",
    ], true, "cross-process change notices did not arrive");

    const timestamp = new Date().toISOString();
    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(join(dataFolder, "tasks", "outside.json"), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: "Outside", status: "active" },
    }, null, 2)}\n`);
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/outside",
    ], true, "outside record notices did not reach its exact subscriptions");

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
    ], true, "the sentinel change after an ignored file was not reported");
    assert.equal(
      notices.updated.slice(checkpoint.updated).includes("autofile:///tasks/.ignored"),
      false,
      "an ignored file produced a resource notice",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "delete_record",
      arguments: { uri: "autofile:///tasks/outside" },
    }), { uri: "autofile:///tasks/outside" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///tasks/outside",
    ], true, "record deletion notices did not reach its exact subscriptions");

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
    ], true, "declaration creation notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "update_type",
      arguments: { type: "watched-type", description: "Changed declarations." },
    }), { uri: "autofile:///_types/watched-type", errors: [] });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/watched-type",
    ], true, "declaration change notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    assertToolJson(await other.callTool({
      name: "delete_type",
      arguments: { type: "watched-type" },
    }), { uri: "autofile:///_types/watched-type" });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/watched-type",
    ], true, "declaration deletion notices did not reach its exact subscriptions");

    checkpoint = resourceNoticeCheckpoint(notices);
    await mkdir(join(dataFolder, "_blobs"), { recursive: true });
    await writeFile(join(dataFolder, "_blobs", blobName), "unreferenced attachment");
    await writeFile(join(dataFolder, "_blobs", blobName), "changed unreferenced attachment");
    await unlink(join(dataFolder, "_blobs", blobName));
    await other.callTool({
      name: "update_record",
      arguments: { uri: "autofile:///tasks/watched", patch: { status: "active" } },
    });
    await expectResourceNotices(notices, checkpoint, ["autofile:///tasks/watched"], false,
      "a record change after attachment changes was not reported");
    assert.equal(notices.updated.slice(checkpoint.updated).includes(blobUri), false);

    checkpoint = resourceNoticeCheckpoint(notices);
    await rm(dataFolder, { recursive: true });
    await expectResourceNotices(notices, checkpoint, [
      "autofile:///_types/tasks",
      "autofile:///tasks/watched",
    ], true, "data-folder deletion notices did not arrive");

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
      "autofile:///reborn/new",
    ], true, "stdio notices stopped after data-folder recreation");
  } finally {
    await subscription.close();
    await Promise.all([client.close(), other.close()]);
  }
});

test("declaration listing changes notify an exact record subscription over stdio", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(autofileHome, "data");
  const declarationPath = join(dataFolder, "_types", "tasks.json");
  const recordUri = "autofile:///tasks/lifecycle";
  const declaration = `${JSON.stringify({
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
  }, null, 2)}\n`;
  await mkdir(join(dataFolder, "tasks"), { recursive: true });
  await writeFile(join(dataFolder, "tasks", "lifecycle.json"), `${JSON.stringify({
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    value: { title: "Lifecycle", status: "active" },
  }, null, 2)}\n`);

  const client = await connectCommand(root, autofileHome, "autofile-stdio-derived-records");
  const notices = collectResourceNotices(client);
  const resourceSubscriptions = [
    recordUri,
    "autofile:///_types/tasks",
  ];
  const subscription = await client.listen({
    resourceSubscriptions,
    resourcesListChanged: true,
  });
  const expectedUris = [
    "autofile:///_types/tasks",
    recordUri,
  ];
  try {
    let checkpoint = resourceNoticeCheckpoint(notices);
    await mkdir(join(dataFolder, "_types"));
    await writeFile(declarationPath, declaration);
    await expectResourceNotices(
      notices,
      checkpoint,
      expectedUris,
      true,
      "declaration creation did not notify the record that became listable",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    await unlink(declarationPath);
    await expectResourceNotices(
      notices,
      checkpoint,
      expectedUris,
      true,
      "declaration deletion did not notify the record that stopped being listable",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(declarationPath, declaration);
    await expectResourceNotices(
      notices,
      checkpoint,
      expectedUris,
      true,
      "declaration restoration did not notify the record that became listable",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(declarationPath, "{\n");
    await expectResourceNotices(
      notices,
      checkpoint,
      expectedUris,
      true,
      "an invalid declaration did not notify the record that stopped being listable",
    );

    checkpoint = resourceNoticeCheckpoint(notices);
    await writeFile(declarationPath, declaration);
    await expectResourceNotices(
      notices,
      checkpoint,
      expectedUris,
      true,
      "a repaired declaration did not notify the record that became listable",
    );
  } finally {
    await subscription.close();
    await client.close();
  }
});

test("a watcher read error is reported without closing its stdio connection", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(autofileHome, "data");
  const recordPath = join(dataFolder, "tasks", "flaky.json");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(autofileHome, "write.lock"),
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
    key: "flaky",
    record: { title: "Before", status: "active" },
  });
  const stderr: TextLog = { listeners: new Set(), text: "" };
  const client = await connectCommand(root, autofileHome, "autofile-stdio-read-error", {
    command: "/usr/bin/setpriv",
    args: [
      "--securebits", "+noroot,+noroot_locked",
      "--bounding-set=-dac_override,-dac_read_search",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      process.execPath,
      cli,
    ],
    onStderr: (text) => appendText(stderr, text),
  });
  try {
    assertToolJson(await client.callTool({ name: "list_types", arguments: {} }), {
      types: [{
        uri: "autofile:///_types/tasks",
        type: "tasks",
        description: "Things to do.",
      }],
    });
    await chmod(recordPath, 0o000);
    await writeFile(recordPath, `${JSON.stringify({
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:01:00.000Z",
      value: { title: "After", status: "active" },
    }, null, 2)}\n`);
    await waitForText(
      stderr,
      "Storage operation failed",
      "the watcher read error was not written to stderr",
    );

    try {
      assertToolJson(await client.callTool({ name: "list_types", arguments: {} }), {
        types: [{
          uri: "autofile:///_types/tasks",
          type: "tasks",
          description: "Things to do.",
        }],
      });
    } catch (error) {
      throw new Error(`request after watcher error failed; stderr: ${stderr.text.trim()}`, {
        cause: error,
      });
    }
  } finally {
    await chmod(recordPath, 0o600);
    await client.close();
  }
});

test("delete_type over stdio refuses unreadable records and unrelated data but deletes an empty type", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const client = await connectCommand(root, autofileHome, "type-deletion");
  try {
    for (const [type, entry] of [
      ["damaged", { name: "broken.json", contents: "{\n" }],
      ["unrelated", { name: "ignored.txt", contents: "keep this data" }],
      ["empty", undefined],
    ] as const) {
      const uri = `autofile:///_types/${type}`;
      assertToolJson(await client.callTool({
        name: "create_type",
        arguments: { type, description: "Deletion fixture.", schema: { type: "object" } },
      }), { uri });
      const folder = join(autofileHome, "data", type);
      if (entry !== undefined) await writeFile(join(folder, entry.name), entry.contents);
      const result = await client.callTool({ name: "delete_type", arguments: { type } });
      if (entry === undefined) {
        assertToolJson(result, { uri });
        await assert.rejects(stat(folder), { code: "ENOENT" });
        await assert.rejects(stat(join(autofileHome, "data", "_types", `${type}.json`)), { code: "ENOENT" });
      } else {
        assertToolJson(result, { errors: [{ uri, message: "type still has stored data" }] }, { isError: true });
        assert.equal(await readFile(join(folder, entry.name), "utf8"), entry.contents);
        assertToolJson(await client.callTool({ name: "get_type", arguments: { type } }), {
          uri, description: "Deletion fixture.", schema: { type: "object" },
        });
      }
    }
  } finally {
    await client.close();
  }
});

test("an agent can complete the full record, link, search, blob, type, and resource lifecycle over stdio", {
  timeout: 60_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 251]);
  const blobHash = createHash("sha256").update(sourceBytes).digest("hex");
  const blobUri = `autofile:///_blobs/${blobHash}.png`;
  const sourcePath = join(root, "logo.png");
  await writeFile(sourcePath, sourceBytes);

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
    required: ["name"],
    properties: {
      name: { type: "string" },
      employer: {
        type: "string",
        format: "uri",
        pattern: "^autofile:///organizations/",
      },
      related: { type: "array", items: { type: "string", format: "uri" } },
      details: {
        type: "object",
        properties: {
          role: { type: "string" },
          mentor: { type: "string", format: "uri" },
        },
        additionalProperties: false,
      },
      tags: { type: "array" },
      notes: { type: "string" },
    },
    additionalProperties: false,
  };
  const entrySchema = {
    type: "object",
    required: ["title", "status"],
    properties: {
      title: { type: "string" },
      status: { type: "string", enum: ["active", "complete"] },
      body: { type: "string" },
      details: { type: "object" },
      labels: { type: "array" },
    },
    additionalProperties: false,
  };
  let bootstrap: Client | undefined;
  let client: Client | undefined;

  try {
    bootstrap = await connectCommand(root, autofileHome, "autofile-stdio-scenario-bootstrap");
    assert.equal(bootstrap.getServerVersion()?.description, serverDescription);
    assert.deepEqual(bootstrap.getServerCapabilities()?.resources, {
      subscribe: true,
      listChanged: true,
    });
    assert.equal(
      bootstrap.getInstructions(),
      `${baseInstructions}\n\nTypes: none yet. This list was taken when the session began; call \`list_types\` for types created since.`,
    );

    const tools = (await bootstrap.listTools()).tools;
    assert.deepEqual(tools.map(({ name }) => name), [
      "find_records",
      "get_record",
      "create_record",
      "update_record",
      "upload_blob",
      "delete_record",
      "list_types",
      "get_type",
      "create_type",
      "update_type",
      "delete_type",
    ]);
    assert.deepEqual(Object.fromEntries(tools.map((tool) => [tool.name, {
      properties: Object.keys(asObject(tool.inputSchema.properties ?? {})),
      required: tool.inputSchema.required ?? [],
      additionalProperties: tool.inputSchema.additionalProperties,
    }])), {
      find_records: {
        properties: ["type", "q", "where", "limit", "fields", "cursor"],
        required: [],
        additionalProperties: false,
      },
      get_record: {
        properties: ["uri"],
        required: ["uri"],
        additionalProperties: false,
      },
      create_record: {
        properties: ["type", "key", "record"],
        required: ["type", "record"],
        additionalProperties: false,
      },
      update_record: {
        properties: ["uri", "patch"],
        required: ["uri", "patch"],
        additionalProperties: false,
      },
      upload_blob: { properties: ["base64", "path", "mediaType"], required: [], additionalProperties: false },
      delete_record: {
        properties: ["uri"],
        required: ["uri"],
        additionalProperties: false,
      },
      list_types: { properties: [], required: [], additionalProperties: false },
      get_type: {
        properties: ["type"],
        required: ["type"],
        additionalProperties: false,
      },
      create_type: {
        properties: ["type", "description", "schema", "titleField"],
        required: ["type", "description", "schema"],
        additionalProperties: false,
      },
      update_type: {
        properties: ["type", "description", "schema", "titleField"],
        required: ["type"],
        additionalProperties: false,
      },
      delete_type: {
        properties: ["type"],
        required: ["type"],
        additionalProperties: false,
      },
    });
    assert.ok(tools.every(({ description }) => typeof description === "string" && description.length > 0));

    for (const input of [
      {
        type: "contacts",
        description: "People and their organizations.",
        titleField: "name",
        schema: contactSchema,
      },
      {
        type: "entries",
        description: "Searchable entries.",
        titleField: "title",
        schema: entrySchema,
      },
      {
        type: "organizations",
        description: "Organizations with their logos.",
        titleField: "name",
        schema: organizationSchema,
      },
      {
        type: "temporary",
        description: "A type used to prove empty type deletion.",
        schema: { type: "object" },
      },
    ]) {
      assertToolJson(await bootstrap.callTool({
        name: "create_type",
        arguments: input,
      }), { uri: `autofile:///_types/${input.type}` });
    }
    assertToolJson(await bootstrap.callTool({
      name: "delete_type",
      arguments: { type: "temporary" },
    }), { uri: "autofile:///_types/temporary" });

    const invalidType = await bootstrap.callTool({
      name: "create_type",
      arguments: {
        type: "invalid-schema",
        description: "Must be refused.",
        schema: { type: "string", format: "made-up" },
      },
    });
    const invalidTypeBody = asObject(invalidType.structuredContent);
    assert.ok(Array.isArray(invalidTypeBody.errors));
    assert.match(String(asObject(invalidTypeBody.errors[0]).message), /unknown format/u);
    assertToolJson(invalidType, invalidTypeBody, { isError: true });
    const invalidTypeName = await bootstrap.callTool({
      name: "create_type",
      arguments: { type: "Bad", description: "Must be refused.", schema: { type: "object" } },
    });
    assertToolJson(invalidTypeName, {
      errors: [{
        message: "type: must use lowercase letters, digits, and hyphens and start with a letter",
      }],
    }, { isError: true });

    assertToolJson(await bootstrap.callTool({ name: "list_types", arguments: {} }), {
      types: [
        {
          uri: "autofile:///_types/contacts",
          type: "contacts",
          description: "People and their organizations.",
        },
        {
          uri: "autofile:///_types/entries",
          type: "entries",
          description: "Searchable entries.",
        },
        {
          uri: "autofile:///_types/organizations",
          type: "organizations",
          description: "Organizations with their logos.",
        },
      ],
    });
    assertToolJson(await bootstrap.callTool({
      name: "get_type",
      arguments: { type: "contacts" },
    }), {
      uri: "autofile:///_types/contacts",
      description: "People and their organizations.",
      titleField: "name",
      schema: contactSchema,
    });
    const missingType = await bootstrap.callTool({
      name: "get_type",
      arguments: { type: "missing" },
    });
    assertToolJson(missingType, {
      errors: [{ uri: "autofile:///_types/missing", message: "type does not exist" }],
    }, { isError: true });

    await bootstrap.close();
    bootstrap = undefined;
    client = await connectCommand(root, autofileHome, "autofile-stdio-scenario-agent");
    assert.equal(client.getServerVersion()?.description, serverDescription);
    assert.equal(
      client.getInstructions(),
      `${baseInstructions}\n\nTypes: contacts, entries, organizations. This list was taken when the session began; call \`list_types\` for types created since.`,
    );

    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { path: sourcePath } }), { uri: blobUri });
    const organizationUri = "autofile:///organizations/acme";
    assertToolJson(await client.callTool({
      name: "create_record",
      arguments: {
        type: "organizations",
        key: "acme",
        record: { name: "Acme", logo: blobUri },
      },
    }), { uri: organizationUri });
    const duplicateRecord = await client.callTool({
      name: "create_record",
      arguments: {
        type: "organizations",
        key: "acme",
        record: { name: "Duplicate", logo: blobUri },
      },
    });
    assertToolJson(duplicateRecord, {
      errors: [{ uri: organizationUri, message: "a record with that key already exists" }],
    }, { isError: true });
    const missingBlobUri = `autofile:///_blobs/${"a".repeat(64)}.png`;
    const missingBlob = await client.callTool({
      name: "create_record",
      arguments: {
        type: "organizations",
        key: "missing-blob",
        record: { name: "Missing blob", logo: missingBlobUri },
      },
    });
    const missingBlobBody = asObject(missingBlob.structuredContent);
    assert.ok(Array.isArray(missingBlobBody.errors));
    assert.match(String(asObject(missingBlobBody.errors[0]).message), /blob that does not exist/u);
    assertToolJson(missingBlob, missingBlobBody, { isError: true });

    const missingOrganizationUri = "autofile:///organizations/missing";
    const missingLink = await client.callTool({
      name: "create_record",
      arguments: {
        type: "contacts",
        key: "dangling",
        record: { name: "Dangling", employer: missingOrganizationUri },
      },
    });
    assertToolJson(missingLink, {
      errors: [{
        uri: "autofile:///contacts/dangling",
        message: `employer: links to a record that does not exist: ${missingOrganizationUri}`,
      }],
    }, { isError: true });

    const createdContact = await client.callTool({
      name: "create_record",
      arguments: {
        type: "contacts",
        record: {
          name: "Ada Lovelace",
          employer: organizationUri,
          related: [organizationUri, "https://example.com/reference", organizationUri],
          details: { role: "Engineer", mentor: organizationUri },
          tags: ["friend", "technical"],
          notes: `Writes about analytical engines and mentions ${organizationUri} as plain text.`,
        },
      },
    });
    const contactBody = asObject(createdContact.structuredContent);
    const contactUri = String(contactBody.uri);
    assert.match(contactUri, /^autofile:\/\/\/contacts\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/u);
    assertToolJson(createdContact, contactBody);
    const invalidKey = await client.callTool({
      name: "create_record",
      arguments: { type: "contacts", key: "-bad", record: { name: "Bad key" } },
    });
    assertToolJson(invalidKey, {
      errors: [{
        message: "key: must use lowercase letters, digits, and hyphens and start with a letter or digit",
      }],
    }, { isError: true });
    const refusedLinkUpdate = await client.callTool({
      name: "update_record",
      arguments: { uri: contactUri, patch: { employer: missingOrganizationUri } },
    });
    assertToolJson(refusedLinkUpdate, {
      errors: [{
        uri: contactUri,
        message: `employer: links to a record that does not exist: ${missingOrganizationUri}`,
      }],
    }, { isError: true });
    const missingRecord = await client.callTool({
      name: "get_record",
      arguments: { uri: "autofile:///contacts/missing" },
    });
    assertToolJson(missingRecord, {
      errors: [{ uri: "autofile:///contacts/missing", message: "record does not exist" }],
    }, { isError: true });

    for (let index = 0; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const uri = `autofile:///entries/item-${suffix}`;
      assertToolJson(await client.callTool({
        name: "create_record",
        arguments: {
          type: "entries",
          key: `item-${suffix}`,
          record: {
            title: `Archive note ${suffix}`,
            status: "active",
            body: `Needle in a field omitted from search results; unique-${suffix}.`,
            details: { owner: "Alex", remove: true },
            labels: ["batch", "private"],
          },
        },
      }), { uri });
    }

    const mergeUri = "autofile:///entries/item-000";
    const beforeMergeResult = await client.callTool({
      name: "get_record",
      arguments: { uri: mergeUri },
    });
    const beforeMerge = asObject(beforeMergeResult.structuredContent);
    assertToolJson(beforeMergeResult, beforeMerge);
    assertToolJson(await client.callTool({
      name: "update_record",
      arguments: {
        uri: mergeUri,
        patch: {
          status: "complete",
          details: { remove: null, note: "done" },
          labels: ["finished"],
        },
      },
    }), { uri: mergeUri });
    const afterMergeResult = await client.callTool({
      name: "get_record",
      arguments: { uri: mergeUri },
    });
    const afterMerge = asObject(afterMergeResult.structuredContent);
    assert.equal(afterMerge.createdAt, beforeMerge.createdAt);
    assert.notEqual(afterMerge.updatedAt, beforeMerge.updatedAt);
    assert.deepEqual(afterMerge.value, {
      title: "Archive note 000",
      status: "complete",
      body: "Needle in a field omitted from search results; unique-000.",
      details: { owner: "Alex", note: "done" },
      labels: ["finished"],
    });
    assertToolJson(afterMergeResult, afterMerge);

    const foundUris: string[] = [];
    let recordCursor: string | undefined;
    let searchPages = 0;
    do {
      const result = await client.callTool({
        name: "find_records",
        arguments: {
          type: "entries",
          q: "archive needle",
          where: { status: "active", labels: "batch" },
          fields: ["title"],
          ...(recordCursor === undefined ? {} : { cursor: recordCursor }),
        },
      });
      const page = asObject(result.structuredContent);
      assert.ok(Array.isArray(page.records));
      assert.deepEqual(page.errors, []);
      assert.equal(page.records.length, 50);
      for (const item of page.records) {
        const record = asObject(item);
        assert.deepEqual(Object.keys(asObject(record.value)), ["title"]);
        foundUris.push(String(record.uri));
      }
      recordCursor = typeof page.cursor === "string" ? page.cursor : undefined;
      searchPages += 1;
      assertToolJson(result, page);
    } while (recordCursor !== undefined);
    assert.equal(searchPages, 2);
    assert.equal(foundUris.length, 100);
    assert.equal(foundUris[0], "autofile:///entries/item-001");
    assert.equal(foundUris.at(-1), "autofile:///entries/item-100");

    const unsupportedWhere = await client.callTool({
      name: "find_records",
      arguments: { type: "entries", where: { status: { $in: ["active"] } } },
    });
    assertToolJson(unsupportedWhere, {
      errors: [{ message: "where: the operator $in is not supported" }],
    }, { isError: true });

    for (const key of ["large-a", "large-b", "large-c"]) {
      assertToolJson(await client.callTool({
        name: "create_record",
        arguments: {
          type: "entries",
          key,
          record: {
            title: `Large ${key}`,
            status: "active",
            body: `cap marker ${"🙂".repeat(9_000)}`,
          },
        },
      }), { uri: `autofile:///entries/${key}` });
    }
    const largeUris: string[] = [];
    recordCursor = undefined;
    do {
      const result = await client.callTool({
        name: "find_records",
        arguments: {
          type: "entries",
          q: "cap marker",
          limit: 200,
          ...(recordCursor === undefined ? {} : { cursor: recordCursor }),
        },
      });
      const page = asObject(result.structuredContent);
      assert.ok(Array.isArray(page.records) && Array.isArray(page.errors));
      assert.equal(page.records.length, 1);
      assert.ok(Buffer.byteLength(JSON.stringify({
        records: page.records,
        errors: page.errors,
      }), "utf8") <= 64 * 1024);
      largeUris.push(String(asObject(page.records[0]).uri));
      recordCursor = typeof page.cursor === "string" ? page.cursor : undefined;
      assertToolJson(result, page);
    } while (recordCursor !== undefined);
    assert.deepEqual(largeUris, [
      "autofile:///entries/large-a",
      "autofile:///entries/large-b",
      "autofile:///entries/large-c",
    ]);

    assertToolJson(await client.callTool({
      name: "create_type",
      arguments: {
        type: "required-links",
        description: "Records whose links cannot be removed.",
        schema: {
          type: "object",
          required: ["target"],
          properties: { target: { type: "string", format: "uri" } },
          additionalProperties: false,
        },
      },
    }), { uri: "autofile:///_types/required-links" });
    assertToolJson(await client.callTool({
      name: "create_record",
      arguments: {
        type: "required-links",
        key: "blocker",
        record: { target: organizationUri },
      },
    }), { uri: "autofile:///required-links/blocker" });
    const blockedDelete = await client.callTool({
      name: "delete_record",
      arguments: { uri: organizationUri },
    });
    assertToolJson(blockedDelete, {
      errors: [{
        uri: "autofile:///required-links/blocker",
        message: "missing required property: target",
      }],
    }, { isError: true });

    const nonemptyTypeDelete = await client.callTool({
      name: "delete_type",
      arguments: { type: "entries" },
    });
    assertToolJson(nonemptyTypeDelete, {
      errors: [{
        uri: "autofile:///_types/entries",
        message: "type still has stored data",
      }],
    }, { isError: true });

    const contactResult = await client.callTool({
      name: "get_record",
      arguments: { uri: contactUri },
    });
    const contact = asObject(contactResult.structuredContent);
    assert.equal(typeof contact.createdAt, "string");
    assert.equal(contact.updatedAt, contact.createdAt);
    assertToolJson(contactResult, contact);

    const listedResources: Array<Record<string, unknown>> = [];
    let resourceCursor: string | undefined;
    let resourcePages = 0;
    do {
      const page: ListResourcesResult = await client.request({
        method: "resources/list",
        ...(resourceCursor === undefined ? {} : { params: { cursor: resourceCursor } }),
      });
      assert.equal(page.ttlMs, 0);
      assert.equal(page.cacheScope, "private");
      assert.ok(page.resources.length > 0 && page.resources.length <= 100);
      listedResources.push(...page.resources.map((resource) => (
        resource as unknown as Record<string, unknown>
      )));
      resourceCursor = page.nextCursor;
      resourcePages += 1;
    } while (resourceCursor !== undefined);
    assert.ok(resourcePages > 1);
    const listedUris = listedResources.map(({ uri }) => String(uri));
    assert.deepEqual(listedUris, [...listedUris].sort());

    assert.deepEqual(
      listedResources.find(({ uri }) => uri === "autofile:///_types/contacts"),
      {
        uri: "autofile:///_types/contacts",
        name: "Type: contacts",
        mimeType: "application/json",
        description: "People and their organizations.",
      },
    );
    assert.deepEqual(listedResources.find(({ uri }) => uri === contactUri), {
      uri: contactUri,
      name: `contacts: ${contactUri.split("/").at(-1)}`,
      title: "Ada Lovelace",
      mimeType: "application/json",
    });
    assert.equal(listedResources.find(({ uri }) => uri === blobUri), undefined);

    const declaration = await client.readResource({ uri: "autofile:///_types/contacts" });
    assert.equal(declaration.ttlMs, 0);
    assert.equal(declaration.cacheScope, "private");
    const declarationContent = declaration.contents[0];
    assert.ok(declarationContent !== undefined && "text" in declarationContent);
    assert.deepEqual(JSON.parse(declarationContent.text) as unknown, {
      uri: "autofile:///_types/contacts",
      type: "contacts",
      description: "People and their organizations.",
      titleField: "name",
      schema: contactSchema,
    });
    assert.ok(declarationContent.text.endsWith("\n"));

    const recordResource = await client.readResource({ uri: contactUri });
    assert.equal(recordResource.ttlMs, 0);
    assert.equal(recordResource.cacheScope, "private");
    const recordContent = recordResource.contents[0];
    assert.ok(recordContent !== undefined && "text" in recordContent);
    assert.deepEqual(JSON.parse(recordContent.text) as unknown, {
      uri: contactUri,
      type: "contacts",
      key: contactUri.split("/").at(-1),
      title: "Ada Lovelace",
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      value: contact.value,
    });

    const blob = await client.readResource({ uri: blobUri });
    assert.deepEqual({
      contents: blob.contents,
      ttlMs: blob.ttlMs,
      cacheScope: blob.cacheScope,
    }, {
      contents: [{
        uri: blobUri,
        mimeType: "image/png",
        blob: sourceBytes.toString("base64"),
      }],
      ttlMs: 0,
      cacheScope: "private",
    });
    await assert.rejects(
      client.readResource({ uri: "autofile:///contacts/missing" }),
      (error: unknown) => error instanceof ProtocolError && error.code === -32602,
    );
    await assert.rejects(
      client.request({ method: "resources/list", params: { cursor: "not-a-cursor" } }),
      (error: unknown) => error instanceof ProtocolError && error.code === -32602,
    );

    const completeOnlySchema = {
      ...entrySchema,
      properties: {
        ...entrySchema.properties,
        status: { const: "complete" },
      },
    };
    const refusedTypeUpdate = await client.callTool({
      name: "update_type",
      arguments: {
        type: "entries",
        schema: { type: "string", format: "made-up" },
      },
    });
    const refusedTypeUpdateBody = asObject(refusedTypeUpdate.structuredContent);
    assert.ok(Array.isArray(refusedTypeUpdateBody.errors));
    assert.match(String(asObject(refusedTypeUpdateBody.errors[0]).message), /unknown format/u);
    assertToolJson(refusedTypeUpdate, refusedTypeUpdateBody, { isError: true });
    const changedType = await client.callTool({
      name: "update_type",
      arguments: { type: "entries", schema: completeOnlySchema },
    });
    const changedTypeBody = asObject(changedType.structuredContent);
    assert.equal(changedTypeBody.uri, "autofile:///_types/entries");
    assert.ok(Array.isArray(changedTypeBody.errors));
    assert.equal(changedTypeBody.errors.length, 103);
    assert.ok(changedTypeBody.errors.some((error) => (
      asObject(error).uri === "autofile:///entries/item-001"
    )));
    assertToolJson(changedType, changedTypeBody);

    const invalidSearch = await client.callTool({
      name: "find_records",
      arguments: {
        type: "entries",
        q: "unique-001",
        where: { status: "active" },
        fields: ["title"],
      },
    });
    const invalidSearchBody = asObject(invalidSearch.structuredContent);
    assert.deepEqual(invalidSearchBody.records, []);
    assert.ok(Array.isArray(invalidSearchBody.errors));
    assert.equal(invalidSearchBody.errors.length, 1);
    assert.equal(asObject(invalidSearchBody.errors[0]).uri, "autofile:///entries/item-001");
    assert.match(String(asObject(invalidSearchBody.errors[0]).message), /status/u);
    assertToolJson(invalidSearch, invalidSearchBody);

    const invalidRecord = await client.callTool({
      name: "get_record",
      arguments: { uri: "autofile:///entries/item-001" },
    });
    const invalidRecordBody = asObject(invalidRecord.structuredContent);
    assert.match(String(invalidRecordBody.error), /status/u);
    assertToolJson(invalidRecord, invalidRecordBody);

    assertToolJson(await client.callTool({
      name: "delete_record",
      arguments: { uri: "autofile:///required-links/blocker" },
    }), { uri: "autofile:///required-links/blocker" });
    assertToolJson(await client.callTool({
      name: "delete_record",
      arguments: { uri: organizationUri },
    }), { uri: organizationUri });

    const contactAfterDeleteResult = await client.callTool({
      name: "get_record",
      arguments: { uri: contactUri },
    });
    const contactAfterDelete = asObject(contactAfterDeleteResult.structuredContent);
    assert.notEqual(contactAfterDelete.updatedAt, contact.updatedAt);
    assert.deepEqual(contactAfterDelete.value, {
      name: "Ada Lovelace",
      related: ["https://example.com/reference"],
      details: { role: "Engineer" },
      tags: ["friend", "technical"],
      notes: `Writes about analytical engines and mentions ${organizationUri} as plain text.`,
    });
    assertToolJson(contactAfterDeleteResult, contactAfterDelete);
    await assert.rejects(
      client.readResource({ uri: blobUri }),
      (error: unknown) => error instanceof ProtocolError && error.code === -32602,
    );
    assert.equal((await client.listResources()).resources.some(({ uri }) => (
      uri === organizationUri || uri === blobUri
    )), false);
    const missingDelete = await client.callTool({
      name: "delete_record",
      arguments: { uri: organizationUri },
    });
    assertToolJson(missingDelete, {
      errors: [{ uri: organizationUri, message: "record does not exist" }],
    }, { isError: true });

    const brokenUri = "autofile:///entries/broken";
    await writeFile(join(autofileHome, "data", "entries", "broken.json"), "{\n");
    const unreadableSearch = await client.callTool({
      name: "find_records",
      arguments: { type: "entries", q: "does-not-match" },
    });
    assertToolJson(unreadableSearch, {
      records: [],
      errors: [{ uri: brokenUri, message: "record is unavailable" }],
    });
    assert.equal((await client.listResources()).resources.some(({ uri }) => uri === brokenUri), false);
    await assert.rejects(
      client.readResource({ uri: brokenUri }),
      (error: unknown) => error instanceof ProtocolError && error.code === -32602,
    );
  } finally {
    if (client !== undefined) await client.close();
    if (bootstrap !== undefined) await bootstrap.close();
  }
});

test("the built command refuses a default 2025-era client", { timeout: 30_000 }, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const client = new Client({ name: "autofile-legacy-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });

  try {
    await assert.rejects(client.connect(transport), (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, -32_022);
      assert.equal(error.message, "Unsupported protocol version: 2025-11-25");
      assert.deepEqual(error.data, {
        supported: ["2026-07-28"],
        requested: "2025-11-25",
      });
      return true;
    });
  } finally {
    await client.close();
  }
});

test("stdio path uploads follow nested, array, referenced and conditional blob fields during creates and updates", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const home = join(root, "autofile-home");
  const firstPath = join(root, "first.txt");
  const secondPath = join(root, "second.txt");
  await writeFile(firstPath, "first attachment");
  await writeFile(secondPath, "second attachment");
  const client = await connectCommand(root, home, "autofile-stdio-schema-uploads");
  try {
    assertToolJson(await client.callTool({ name: "create_type", arguments: {
      type: "uploads",
      description: "Uploads in active schema branches.",
      schema: {
        type: "object",
        $defs: { attachment: { type: "string", format: "blob" } },
        properties: {
          mode: { enum: ["plain", "attachment"] },
          source: { type: "string" },
          nested: { type: "object", properties: {
            label: { type: "string" }, scan: { $ref: "#/$defs/attachment" },
          } },
          attachments: { type: "array", items: { $ref: "#/$defs/attachment" } },
          note: { type: "string" },
        },
        allOf: [{
          if: { properties: { mode: { const: "attachment" } }, required: ["mode"] },
          then: { properties: { source: { $ref: "#/$defs/attachment" } } },
        }],
      },
    } }), { uri: "autofile:///_types/uploads" });
    const firstUri = String(asObject((await client.callTool({ name: "upload_blob", arguments: { path: firstPath } })).structuredContent).uri);
    const secondUri = String(asObject((await client.callTool({ name: "upload_blob", arguments: { path: secondPath } })).structuredContent).uri);
    const uri = "autofile:///uploads/one";
    assertToolJson(await client.callTool({ name: "create_record", arguments: {
      type: "uploads", key: "one", record: {
        mode: "plain", source: secondPath, note: firstPath,
        nested: { label: "Keep me", scan: firstUri }, attachments: [firstUri],
      },
    } }), { uri });
    let record = asObject((await client.callTool({ name: "get_record", arguments: { uri } })).structuredContent);
    let value = asObject(record.value);
    assert.equal(asObject(value.nested).scan, firstUri);
    assert.match(firstUri, /^autofile:\/\/\/_blobs\//u);
    assert.deepEqual(value.attachments, [firstUri]);
    assert.equal(value.source, secondPath);
    assert.equal(value.note, firstPath);

    // Stored strings never grant permission to read a source file.
    assert.equal((await client.callTool({ name: "update_record", arguments: {
      uri, patch: { mode: "attachment", note: firstPath },
    } })).isError, true);
    assertToolJson(await client.callTool({ name: "update_record", arguments: {
      uri, patch: { mode: "attachment", source: secondUri, nested: { scan: secondUri }, attachments: [secondUri] },
    } }), { uri });
    record = asObject((await client.callTool({ name: "get_record", arguments: { uri } })).structuredContent);
    value = asObject(record.value);
    assert.equal(value.source, secondUri);
    assert.match(secondUri, /^autofile:\/\/\/_blobs\//u);
    assert.notEqual(secondUri, firstUri);
    assert.deepEqual(value.nested, { label: "Keep me", scan: secondUri });
    assert.deepEqual(value.attachments, [secondUri]);
    assert.equal(value.note, firstPath);
    const attachment = (await client.readResource({ uri: secondUri })).contents[0];
    assert.ok(attachment !== undefined && "blob" in attachment);
    assert.equal(Buffer.from(attachment.blob, "base64").toString(), "second attachment");
  } finally {
    await client.close();
  }
});

test("stdio rejects oversized and nonregular upload sources without creating a record", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const home = join(root, "autofile-home");
  const oversized = join(root, "oversized.bin");
  await writeFile(oversized, Buffer.alloc(7_340_033));
  const fifo = join(root, "fifo");
  if (process.platform !== "win32") {
    const child = spawn("mkfifo", [fifo]);
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("mkfifo failed")));
    });
  }
  const client = await connectCommand(root, home, "autofile-stdio-source-refusals");
  try {
    await client.callTool({ name: "create_type", arguments: {
      type: "uploads", description: "Upload sources.", schema: {
        type: "object", properties: { attachment: { type: "string", format: "blob" } },
      },
    } });
    for (const [key, path] of [["large", oversized], ["directory", root], ["missing", join(root, "missing.txt")], ...(process.platform === "win32" ? [] : [["fifo", fifo], ["device", "/dev/zero"]])]) {
      const result = await client.callTool({ name: "upload_blob", arguments: { path } });
      assert.equal(result.isError, true);
      const errors = asObject(result.structuredContent).errors;
      assert.ok(Array.isArray(errors));
      assert.match(String(asObject(errors[0]).message), /blob|source/u);
      if (key === "large") assert.match(String(asObject(errors[0]).message), /7340033.*7340032/u);
    }
    assert.deepEqual((await client.listResources()).resources.map(({ uri }) => uri), ["autofile:///_types/uploads"]);
  } finally {
    await client.close();
  }
});

test("stdio PDF uploads preserve schemas that constrain the final attachment address on creates and updates", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const home = join(root, "autofile-home");
  const firstPath = join(root, "receipt.pdf");
  const secondPath = join(root, "replacement.pdf");
  await writeFile(firstPath, "first PDF");
  await writeFile(secondPath, "second PDF");
  const client = await connectCommand(root, home, "autofile-stdio-pdf-constraints");
  try {
    assertToolJson(await client.callTool({ name: "create_type", arguments: {
      type: "receipts", description: "PDF receipts.", schema: {
        type: "object", required: ["attachment"],
        properties: { attachment: { type: "string", format: "blob", pattern: "\\.pdf$" } },
      },
    } }), { uri: "autofile:///_types/receipts" });
    const firstUri = String(asObject((await client.callTool({ name: "upload_blob", arguments: { path: firstPath } })).structuredContent).uri);
    const uri = "autofile:///receipts/one";
    assertToolJson(await client.callTool({ name: "create_record", arguments: {
      type: "receipts", key: "one", record: { attachment: firstUri },
    } }), { uri });
    const first = asObject((await client.callTool({ name: "get_record", arguments: { uri } })).structuredContent);
    assert.match(String(asObject(first.value).attachment), /^autofile:\/\/\/_blobs\/[a-f0-9]{64}\.pdf$/u);
    const secondUri = String(asObject((await client.callTool({ name: "upload_blob", arguments: { path: secondPath } })).structuredContent).uri);
    assertToolJson(await client.callTool({ name: "update_record", arguments: {
      uri, patch: { attachment: secondUri },
    } }), { uri });
    const updated = asObject((await client.callTool({ name: "get_record", arguments: { uri } })).structuredContent);
    const attachmentUri = String(asObject(updated.value).attachment);
    assert.notEqual(attachmentUri, asObject(first.value).attachment);
    const attachment = (await client.readResource({ uri: attachmentUri })).contents[0];
    assert.ok(attachment !== undefined && "blob" in attachment);
    assert.equal(Buffer.from(attachment.blob, "base64").toString(), "second PDF");
    const invalid = await client.callTool({ name: "update_record", arguments: {
      uri, patch: { attachment: "data:text/plain;base64,d3Jvbmc=" },
    } });
    assert.equal(invalid.isError, true);
    assert.deepEqual((await readdir(join(home, "data", "_blobs"))).filter((name) => !name.startsWith(".")), [attachmentUri.split("/").at(-1)]);
  } finally {
    await client.close();
  }
});

test("stdio upload_blob validates sources, canonical base64, media types and record-only blob addresses", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const home = join(root, "autofile-home");
  const path = join(root, "scan.unknown");
  await writeFile(path, "hello");
  const hash = createHash("sha256").update("hello").digest("hex");
  const client = await connectCommand(root, home, "autofile-explicit-uploads");
  try {
    for (const arguments_ of [
      {}, { base64: "aGVsbG8=", path, mediaType: "text/plain" },
      { base64: "aGVsbG8=" }, { path: "relative.txt" },
      ...["aGVs bG8=", "aGVsbG8=!", "aGVsbG8", "aGVsbG9=", "===="].map((base64) => ({ base64, mediaType: "text/plain" })),
      { base64: "aGVsbG8=", mediaType: "invalid" },
    ]) {
      const result = await client.callTool({ name: "upload_blob", arguments: arguments_ });
      const body = asObject(result.structuredContent);
      assert.ok(Array.isArray(body.errors), JSON.stringify(arguments_));
      assertToolJson(result, body, { isError: true });
    }
    const txtUri = `autofile:///_blobs/${hash}.txt`;
    const pdfUri = `autofile:///_blobs/${hash}.pdf`;
    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { base64: "aGVsbG8=", mediaType: "text/plain" } }), { uri: txtUri });
    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { path, mediaType: "application/pdf" } }), { uri: pdfUri });
    const fallback = await client.callTool({ name: "upload_blob", arguments: { path } });
    assert.notEqual(fallback.isError, true);
    assert.equal((await client.readResource({ uri: String(asObject(fallback.structuredContent).uri) })).contents[0]?.mimeType, "application/octet-stream");
    assertToolJson(await client.callTool({ name: "upload_blob", arguments: { base64: "", mediaType: "text/plain" } }), {
      uri: `autofile:///_blobs/${createHash("sha256").update("").digest("hex")}.txt`,
    });
    await client.callTool({ name: "create_type", arguments: {
      type: "files", description: "Files.", schema: { type: "object", properties: { file: { type: "string", format: "blob" } } },
    } });
    for (const file of [path, "data:text/plain;base64,aGVsbG8="]) {
      assert.equal((await client.callTool({ name: "create_record", arguments: { type: "files", record: { file } } })).isError, true);
    }
    for (const key of ["first", "second"]) {
      assertToolJson(await client.callTool({ name: "create_record", arguments: { type: "files", key, record: { file: txtUri } } }), { uri: `autofile:///files/${key}` });
    }
    for (const file of [path, "data:text/plain;base64,aGVsbG8="]) {
      assert.equal((await client.callTool({ name: "update_record", arguments: { uri: "autofile:///files/first", patch: { file } } })).isError, true);
    }
  } finally {
    await client.close();
  }
});
