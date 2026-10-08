/** Exercises the built Autofile MCP command over its real stdio transport. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const cli = resolve("dist/cli.js");
const roots: string[] = [];
const serverDescription = "Typed records that agents file and retrieve, kept as JSON files in a folder the user owns.";
const baseInstructions = "Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.";

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

async function connectCommand(root: string, autofileHome: string, name: string): Promise<Client> {
  const client = new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: environment(root, autofileHome),
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
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

test("the built command creates, serves, updates, and removes a type view", {
  timeout: 30_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const dataFolder = join(root, "configured", "records");
  const typeUri = "autofile:///_types/notes";
  const schema = {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      details: { type: "string" },
      status: { type: "string" },
      owner: { type: "string" },
    },
    additionalProperties: false,
  };
  await mkdir(autofileHome, { recursive: true });
  await writeFile(
    join(autofileHome, "config.json"),
    `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
  );
  const client = new Client(
    { name: "autofile-stdio-view-test", version: "1.0.0" },
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
    const initialView = { body: "details", panel: ["status", "owner"] };
    assert.deepEqual((await client.callTool({
      name: "create_type",
      arguments: {
        type: "notes",
        description: "Notes with prose.",
        titleField: "title",
        view: initialView,
        schema,
      },
    })).structuredContent, { uri: typeUri });

    assert.deepEqual((await client.callTool({
      name: "get_type",
      arguments: { type: "notes" },
    })).structuredContent, {
      uri: typeUri,
      description: "Notes with prose.",
      titleField: "title",
      view: initialView,
      schema,
    });
    const initialResource = await client.readResource({ uri: typeUri });
    assert.deepEqual({
      contents: initialResource.contents,
      ttlMs: initialResource.ttlMs,
      cacheScope: initialResource.cacheScope,
    }, {
      contents: [{
        uri: typeUri,
        mimeType: "application/json",
        text: `${JSON.stringify({
          description: "Notes with prose.",
          titleField: "title",
          view: initialView,
          schema,
        }, null, 2)}\n`,
      }],
      ttlMs: 0,
      cacheScope: "private",
    });

    assert.deepEqual((await client.callTool({
      name: "update_type",
      arguments: { type: "notes", view: { panel: ["status"] } },
    })).structuredContent, { uri: typeUri, errors: [] });
    assert.deepEqual((await client.callTool({
      name: "get_type",
      arguments: { type: "notes" },
    })).structuredContent, {
      uri: typeUri,
      description: "Notes with prose.",
      titleField: "title",
      view: { panel: ["status"] },
      schema,
    });

    assert.deepEqual((await client.callTool({
      name: "update_type",
      arguments: { type: "notes", view: null },
    })).structuredContent, { uri: typeUri, errors: [] });
    const declarationWithoutView = {
      description: "Notes with prose.",
      titleField: "title",
      schema,
    };
    assert.deepEqual((await client.callTool({
      name: "get_type",
      arguments: { type: "notes" },
    })).structuredContent, { uri: typeUri, ...declarationWithoutView });
    const finalResource = await client.readResource({ uri: typeUri });
    assert.deepEqual({
      contents: finalResource.contents,
      ttlMs: finalResource.ttlMs,
      cacheScope: finalResource.cacheScope,
    }, {
      contents: [{
        uri: typeUri,
        mimeType: "application/json",
        text: `${JSON.stringify(declarationWithoutView, null, 2)}\n`,
      }],
      ttlMs: 0,
      cacheScope: "private",
    });
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

test("an agent can complete the full record, link, search, blob, type, and resource lifecycle over stdio", {
  timeout: 60_000,
}, async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const sourcePath = join(root, "Logo.PNG");
  const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 251]);
  const blobHash = createHash("sha256").update(sourceBytes).digest("hex");
  const blobUri = `autofile:///_blobs/${blobHash}.png`;
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
    assert.deepEqual(bootstrap.getServerCapabilities()?.resources, {});
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
        required: ["type"],
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
        properties: ["type", "description", "schema", "titleField", "view"],
        required: ["type", "description", "schema"],
        additionalProperties: false,
      },
      update_type: {
        properties: ["type", "description", "schema", "titleField", "view"],
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
        view: { body: "notes", panel: ["employer", "tags"] },
        schema: contactSchema,
      },
      {
        type: "entries",
        description: "Searchable entries.",
        titleField: "title",
        view: { body: "body", panel: ["status", "labels"] },
        schema: entrySchema,
      },
      {
        type: "organizations",
        description: "Organizations with their logos.",
        titleField: "name",
        view: { panel: ["logo"] },
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
      view: { body: "notes", panel: ["employer", "tags"] },
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

    const organizationUri = "autofile:///organizations/acme";
    assertToolJson(await client.callTool({
      name: "create_record",
      arguments: {
        type: "organizations",
        key: "acme",
        record: { name: "Acme", logo: sourcePath },
      },
    }), { uri: organizationUri });
    const duplicateRecord = await client.callTool({
      name: "create_record",
      arguments: {
        type: "organizations",
        key: "acme",
        record: { name: "Duplicate", logo: sourcePath },
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
            details: { owner: "Rupert", remove: true },
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
      details: { owner: "Rupert", note: "done" },
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
        message: "type folder is not empty",
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
        name: "_types/contacts",
        mimeType: "application/json",
        description: "People and their organizations.",
      },
    );
    assert.deepEqual(listedResources.find(({ uri }) => uri === contactUri), {
      uri: contactUri,
      name: contactUri.slice("autofile:///".length),
      title: "Ada Lovelace",
      mimeType: "application/json",
      annotations: { lastModified: contact.updatedAt },
    });
    assert.deepEqual(listedResources.find(({ uri }) => uri === blobUri), {
      uri: blobUri,
      name: `_blobs/${blobHash}.png`,
      mimeType: "image/png",
      size: sourceBytes.byteLength,
    });

    const declaration = await client.readResource({ uri: "autofile:///_types/contacts" });
    assert.equal(declaration.ttlMs, 0);
    assert.equal(declaration.cacheScope, "private");
    const declarationContent = declaration.contents[0];
    assert.ok(declarationContent !== undefined && "text" in declarationContent);
    assert.deepEqual(JSON.parse(declarationContent.text) as unknown, {
      description: "People and their organizations.",
      titleField: "name",
      view: { body: "notes", panel: ["employer", "tags"] },
      schema: contactSchema,
    });
    assert.ok(declarationContent.text.endsWith("\n"));

    const recordResource = await client.readResource({ uri: contactUri });
    assert.equal(recordResource.ttlMs, 0);
    assert.equal(recordResource.cacheScope, "private");
    const recordContent = recordResource.contents[0];
    assert.ok(recordContent !== undefined && "text" in recordContent);
    assert.deepEqual(JSON.parse(recordContent.text) as unknown, {
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
      errors: [{ uri: brokenUri, message: "record file cannot be read as JSON" }],
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
