/** Exercises the built Autofile MCP command over its real stdio transport. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
