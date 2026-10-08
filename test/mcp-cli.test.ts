/** Exercises the built Autofile MCP command over its real stdio transport. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cli = resolve("dist/cli.js");
const roots: string[] = [];

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-mcp-cli-"));
  roots.push(root);
  return root;
}

function environment(root: string, autofileHome: string): Record<string, string> {
  return {
    AUTOFILE_HOME: autofileHome,
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
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

test("the built command stores a local path and serves its blob", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const sourcePath = join(root, "Receipt.PDF");
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
          properties: { scan: { type: "string", format: "blob" } },
          additionalProperties: false,
        },
      },
    })).structuredContent, { uri: "autofile:///_types/receipts" });
    assert.deepEqual((await client.callTool({
      name: "create_record",
      arguments: {
        type: "receipts",
        key: "first",
        record: { scan: sourcePath },
      },
    })).structuredContent, { uri: "autofile:///receipts/first" });

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

test("the built command deduplicates paths and collects blobs after update and delete", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const blobFolder = join(dataFolder, "_blobs");
  const sharedPath = join(root, "shared.txt");
  const firstPath = join(root, "first.txt");
  const secondPath = join(root, "second.txt");
  const replacementPath = join(root, "replacement.txt");
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
  await Promise.all([
    writeFile(sharedPath, shared),
    writeFile(firstPath, first),
    writeFile(secondPath, second),
    writeFile(replacementPath, replacement),
    writeFile(
      join(autofileHome, "config.json"),
      `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
    ),
  ]);
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
    for (const [key, unique] of [["first", firstPath], ["second", secondPath]]) {
      assert.deepEqual((await client.callTool({
        name: "create_record",
        arguments: { type: "assets", key, record: { shared: sharedPath, unique } },
      })).structuredContent, { uri: `autofile:///assets/${key}` });
    }

    assert.deepEqual((await readdir(blobFolder)).sort(), [
      firstUri.split("/").at(-1),
      secondUri.split("/").at(-1),
      sharedUri.split("/").at(-1),
    ].sort());
    assert.equal(
      (await client.listResources()).resources.filter(({ uri }) => uri === sharedUri).length,
      1,
    );

    assert.deepEqual((await client.callTool({
      name: "update_record",
      arguments: {
        uri: "autofile:///assets/first",
        patch: { unique: replacementPath },
      },
    })).structuredContent, { uri: "autofile:///assets/first" });
    let blobUris = (await client.listResources()).resources
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
    assert.equal(kept.contents[0]?.uri, sharedUri);
    assert.ok(kept.contents[0] !== undefined && "blob" in kept.contents[0]);
    assert.equal(kept.contents[0].blob, shared.toString("base64"));
  } finally {
    await client.close();
  }
});

test("the built command refuses a path over 7 MiB with its size and limit", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const oversizedPath = join(root, "too-large.bin");
  await mkdir(autofileHome, { recursive: true });
  const oversizedFile = await open(oversizedPath, "w");
  await oversizedFile.truncate(7_340_033);
  await oversizedFile.close();
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
    const refused = await client.callTool({
      name: "create_record",
      arguments: {
        type: "assets",
        key: "too-large",
        record: { file: oversizedPath },
      },
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
