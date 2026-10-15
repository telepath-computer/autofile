/** Exercises the store through its public JSON operations and real filesystem. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises, {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { openStore, type JsonObject, type JsonValue, type Store } from "../dist/store.js";

const roots: string[] = [];
const taskSchema = {
  type: "object",
  required: ["title", "status"],
  properties: {
    title: { type: "string" },
    status: { type: "string", enum: ["active", "complete"] },
    details: { type: "object" },
    labels: { type: "array" },
  },
  additionalProperties: false,
};

interface TestStore {
  dataFolder: string;
  root: string;
  store: Store;
}

async function makeStore(): Promise<TestStore> {
  const root = await mkdtemp(join(tmpdir(), "autofile-store-"));
  roots.push(root);
  const dataFolder = join(root, "data");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(root, "autofile-home", "write.lock"),
  });
  return { dataFolder, root, store };
}

async function createTasksType(store: Store): Promise<void> {
  assert.deepEqual(await store.createType({
    type: "tasks",
    description: "Things to do.",
    titleField: "title",
    schema: taskSchema,
  }), { uri: "autofile:///_types/tasks" });
}

async function createDocumentsType(store: Store): Promise<void> {
  assert.deepEqual(await store.createType({
    type: "documents",
    description: "Documents with stored files.",
    schema: {
      $defs: { blob: { type: "string", format: "blob" } },
      type: "object",
      required: ["file"],
      properties: {
        file: { $ref: "#/$defs/blob" },
        attachments: {
          type: "array",
          items: {
            anyOf: [
              { $ref: "#/$defs/blob" },
              { type: "object", required: ["file"], properties: { file: { $ref: "#/$defs/blob" } } },
            ],
          },
        },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
  }), { uri: "autofile:///_types/documents" });
}

function expectedBlobUri(bytes: Buffer, extension?: string): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `autofile:///_blobs/${digest}${extension === undefined ? "" : `.${extension}`}`;
}

async function storedBlobNames(dataFolder: string): Promise<string[]> {
  try {
    return (await readdir(join(dataFolder, "_blobs"))).filter((name) => !name.startsWith("."));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function errorMessages(result: unknown): string[] {
  assert.ok(typeof result === "object" && result !== null && "errors" in result);
  const errors = (result as { errors: Array<{ message: string }> }).errors;
  assert.ok(Array.isArray(errors));
  return errors.map(({ message }) => message);
}

async function runChild(
  script: string,
  args: string[],
  timeoutMs = 45_000,
): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, ...args], {
      cwd: resolve("."),
      env: { ...process.env, TZ: "UTC" },
      stdio: "ignore",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`store child did not exit within ${String(timeoutMs)}ms`));
      else if (code === 0) done();
      else reject(new Error(`store child exited with code ${String(code)}`));
    });
  });
}

async function makeFifo(path: string): Promise<boolean> {
  return new Promise<boolean>((resolveFifo, rejectFifo) => {
    const child = spawn("mkfifo", [path], { stdio: "ignore" });
    child.once("error", (error) => {
      if ("code" in error && error.code === "ENOENT") resolveFifo(false);
      else rejectFifo(error);
    });
    child.once("close", (code) => resolveFifo(code === 0));
  });
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("openStore creates a missing data folder", async () => {
  const { dataFolder, store } = await makeStore();

  assert.equal((await stat(dataFolder)).isDirectory(), true);
  assert.deepEqual(await store.listTypes({}), { types: [] });
});

test("openStore uses the data and lock locations resolved from AUTOFILE_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofile-store-default-"));
  roots.push(root);
  const autofileHome = join(root, "home");
  const dataFolder = join(root, "configured-data");
  const previousAutofileHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = autofileHome;
  try {
    await mkdir(autofileHome, { recursive: true });
    await writeFile(
      join(autofileHome, "config.json"),
      `${JSON.stringify({ storage: dataFolder }, null, 2)}\n`,
    );
    const store = await openStore();
    await createTasksType(store);

    assert.equal((await stat(dataFolder)).isDirectory(), true);
    assert.equal((await stat(join(dataFolder, "_types", "tasks.json"))).isFile(), true);
    assert.equal((await readdir(autofileHome)).includes("write.lock"), false);
  } finally {
    if (previousAutofileHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousAutofileHome;
  }
});

test("type operations persist exact declarations and list recognized files in name order", async () => {
  const { dataFolder, store } = await makeStore();
  assert.deepEqual(await store.createType({
    type: "tasks",
    description: "Things to do.",
    title: "Task",
    titlePlural: "Tasks",
    titleField: "title",
    schema: taskSchema,
  }), { uri: "autofile:///_types/tasks" });
  assert.deepEqual(await store.createType({
    type: "contacts",
    description: "People.",
    schema: { type: "object" },
  }), { uri: "autofile:///_types/contacts" });

  assert.equal(
    await readFile(join(dataFolder, "_types", "tasks.json"), "utf8"),
    `${JSON.stringify({
      description: "Things to do.",
      title: "Task",
      titlePlural: "Tasks",
      titleField: "title",
      schema: taskSchema,
    }, null, 2)}\n`,
  );
  assert.deepEqual(await store.getType({ type: "tasks" }), {
    uri: "autofile:///_types/tasks",
    description: "Things to do.",
    title: "Task",
    titlePlural: "Tasks",
    titleField: "title",
    schema: taskSchema,
  });
  assert.deepEqual(await store.listTypes({}), {
    types: [
      { uri: "autofile:///_types/contacts", type: "contacts", description: "People." },
      {
        uri: "autofile:///_types/tasks",
        type: "tasks",
        description: "Things to do.",
        title: "Task",
        titlePlural: "Tasks",
      },
    ],
  });
  assert.deepEqual(
    (await store.listResources()).find(({ uri }) => uri === "autofile:///_types/tasks"),
    {
      uri: "autofile:///_types/tasks",
      name: "_types/tasks",
      title: "Task",
      mimeType: "application/json",
      description: "Things to do.",
    },
  );

  await writeFile(join(dataFolder, "_types", ".draft.json"), "{}\n");
  await writeFile(join(dataFolder, "_types", "Bad.json"), "{}\n");
  await writeFile(join(dataFolder, "_types", "notes.txt"), "ignored\n");
  await mkdir(join(dataFolder, "_types", "nested.json"));
  assert.equal((await store.listTypes({})).types.length, 2);
});

test("type names, duplicate types, and missing types are refused as JSON errors", async () => {
  const { dataFolder, store } = await makeStore();
  const invalidTypeRefusal = {
    errors: [{
      message: "type: must use lowercase letters, digits, and hyphens and start with a letter",
    }],
  };
  for (const type of ["", "Tasks", "1task", "_tasks", "two_words", "two/types"]) {
    assert.deepEqual(await store.createType({
      type,
      description: "Invalid.",
      schema: { type: "object" },
    }), invalidTypeRefusal);
  }
  assert.deepEqual(await store.getType({ type: "Tasks" }), invalidTypeRefusal);
  assert.deepEqual(await store.createRecord({ type: "Tasks", record: {} }), invalidTypeRefusal);
  assert.deepEqual(await store.updateType({ type: "Tasks", description: "Invalid." }), invalidTypeRefusal);
  assert.deepEqual(await store.deleteType({ type: "Tasks" }), invalidTypeRefusal);

  await createTasksType(store);
  assert.match(errorMessages(await store.createType({
    type: "tasks",
    description: "Duplicate.",
    schema: { type: "object" },
  }))[0] ?? "", /already exists/u);
  assert.match(errorMessages(await store.getType({ type: "missing" }))[0] ?? "", /does not exist/u);
  assert.match(errorMessages(await store.updateType({ type: "missing", description: "No." }))[0] ?? "", /does not exist/u);
  assert.match(errorMessages(await store.deleteType({ type: "missing" }))[0] ?? "", /does not exist/u);

  await writeFile(join(dataFolder, "_types", "broken.json"), "{\n");
  assert.match(errorMessages(await store.getType({ type: "broken" }))[0] ?? "", /type declaration.*JSON/u);
});

test("argument refusals name the argument that must be corrected", async () => {
  const { store } = await makeStore();
  await createTasksType(store);

  assert.deepEqual(await store.createRecord({
    type: "tasks",
    key: "not-an-object",
    record: [] as unknown as JsonObject,
  }), { errors: [{ message: "record: must be a JSON object" }] });
  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///tasks/missing",
    patch: [] as unknown as JsonObject,
  }), {
    errors: [{
      uri: "autofile:///tasks/missing",
      message: "patch: must be a JSON object",
    }],
  });
  assert.deepEqual(await store.createType({
    type: "bad-description",
    description: 42 as unknown as string,
    schema: { type: "object" },
  }), { errors: [{ message: "description: must be a string" }] });
  assert.deepEqual(await store.createType({
    type: "bad-title-field",
    description: "Invalid title field.",
    titleField: 42 as unknown as string,
    schema: { type: "object" },
  }), { errors: [{ message: "titleField: must be a string" }] });
  assert.deepEqual(await store.createType({
    type: "empty-title",
    description: "Invalid title.",
    title: "",
    schema: { type: "object" },
  }), { errors: [{ message: "title: must be a non-empty string" }] });
  assert.deepEqual(await store.createType({
    type: "bad-title",
    description: "Invalid title.",
    title: 42 as unknown as string,
    schema: { type: "object" },
  }), { errors: [{ message: "title: must be a non-empty string" }] });
  assert.deepEqual(await store.createType({
    type: "empty-plural-title",
    description: "Invalid plural title.",
    titlePlural: "",
    schema: { type: "object" },
  }), { errors: [{ message: "titlePlural: must be a non-empty string" }] });
  assert.deepEqual(await store.createType({
    type: "bad-plural-title",
    description: "Invalid plural title.",
    titlePlural: 42 as unknown as string,
    schema: { type: "object" },
  }), { errors: [{ message: "titlePlural: must be a non-empty string" }] });
  assert.deepEqual(await store.createType({
    type: "bad-schema-value",
    description: "Invalid schema value.",
    schema: [] as unknown as JsonObject,
  }), { errors: [{ message: "schema: must be a JSON object" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    titleField: 42 as unknown as string,
  }), { errors: [{ message: "titleField: must be a string or null" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    title: "",
  }), { errors: [{ message: "title: must be a non-empty string or null" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    title: 42 as unknown as string,
  }), { errors: [{ message: "title: must be a non-empty string or null" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    titlePlural: "",
  }), { errors: [{ message: "titlePlural: must be a non-empty string or null" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    titlePlural: 42 as unknown as string,
  }), { errors: [{ message: "titlePlural: must be a non-empty string or null" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    description: 42 as unknown as string,
  }), { errors: [{ message: "description: must be a string" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    schema: [] as unknown as JsonObject,
  }), { errors: [{ message: "schema: must be a JSON object" }] });

});

test("update_type preserves, replaces, and removes type titles", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "journal-entries",
    description: "Journal entries.",
    title: "Journal entry",
    titlePlural: "Journal entries",
    schema: { type: "object" },
  });

  assert.deepEqual(await store.updateType({
    type: "journal-entries",
    description: "Dated journal entries.",
  }), { uri: "autofile:///_types/journal-entries", errors: [] });
  assert.deepEqual(await store.getType({ type: "journal-entries" }), {
    uri: "autofile:///_types/journal-entries",
    description: "Dated journal entries.",
    title: "Journal entry",
    titlePlural: "Journal entries",
    schema: { type: "object" },
  });

  assert.deepEqual(await store.updateType({
    type: "journal-entries",
    title: "Diary entry",
    titlePlural: null,
  }), { uri: "autofile:///_types/journal-entries", errors: [] });
  assert.deepEqual(await store.getType({ type: "journal-entries" }), {
    uri: "autofile:///_types/journal-entries",
    description: "Dated journal entries.",
    title: "Diary entry",
    schema: { type: "object" },
  });
  assert.deepEqual(await store.listTypes({}), {
    types: [{
      uri: "autofile:///_types/journal-entries",
      type: "journal-entries",
      description: "Dated journal entries.",
      title: "Diary entry",
    }],
  });

  assert.deepEqual(await store.updateType({
    type: "journal-entries",
    title: null,
  }), { uri: "autofile:///_types/journal-entries", errors: [] });
  assert.deepEqual(await store.getType({ type: "journal-entries" }), {
    uri: "autofile:///_types/journal-entries",
    description: "Dated journal entries.",
    schema: { type: "object" },
  });
  assert.deepEqual(
    JSON.parse(await readFile(
      join(dataFolder, "_types", "journal-entries.json"),
      "utf8",
    )) as unknown,
    {
      description: "Dated journal entries.",
      schema: { type: "object" },
    },
  );
});

test("schemas use draft 2020-12, internal refs, known formats, and readable validation errors", async () => {
  const { store } = await makeStore();
  const schema = {
    $defs: {
      identity: {
        type: "object",
        required: ["email", "website"],
        properties: {
          email: { type: "string", format: "email" },
          website: { format: "uri" },
        },
      },
    },
    $ref: "#/$defs/identity",
  };
  assert.deepEqual(await store.createType({
    type: "identities",
    description: "Online identities.",
    schema,
  }), { uri: "autofile:///_types/identities" });
  assert.deepEqual(await store.createRecord({
    type: "identities",
    key: "valid",
    record: { email: "person@example.com", website: "https://example.com/person" },
  }), { uri: "autofile:///identities/valid" });

  assert.match(errorMessages(await store.createRecord({
    type: "identities",
    key: "bad-email",
    record: { email: "not an email", website: "https://example.com" },
  }))[0] ?? "", /email/u);
  assert.match(errorMessages(await store.createRecord({
    type: "identities",
    key: "uri-number",
    record: { email: "person@example.com", website: 42 },
  }))[0] ?? "", /website.*string/u);
  assert.match(errorMessages(await store.createRecord({
    type: "identities",
    key: "relative-uri",
    record: { email: "person@example.com", website: "/people/one" },
  }))[0] ?? "", /website/u);

  assert.deepEqual(await store.createType({
    type: "anchor-data",
    description: "Schema-shaped data is still data.",
    schema: {
      const: { $anchor: "target", format: "made-up" },
      $defs: { target: { $anchor: "target", type: "object" } },
      $ref: "#target",
    },
  }), { uri: "autofile:///_types/anchor-data" });

  assert.deepEqual(await store.createType({
    type: "recursive",
    description: "A recursively linked object.",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { next: { $ref: "" } },
    },
  }), { uri: "autofile:///_types/recursive" });
});

test("invalid schemas, unknown formats, external refs, and another dialect are refused", async () => {
  const { store } = await makeStore();
  const cases: Array<[string, JsonObject, RegExp]> = [
    ["unknown-format", { type: "string", format: "made-up" }, /format/u],
    ["external-ref", { $ref: "https://example.com/schema" }, /\$ref/u],
    ["file-ref", { $ref: "other.json#/$defs/value" }, /\$ref/u],
    ["wrong-dialect", { $schema: "http://json-schema.org/draft-07/schema#" }, /2020-12|dialect|\$schema/u],
    [
      "nested-dialect",
      {
        type: "object",
        properties: {
          value: { $schema: "https://example.com/meta-schema", type: "string" },
        },
      },
      /schema\.properties\.value\.\$schema.*root/u,
    ],
  ];
  for (const [type, schema, message] of cases) {
    assert.match(errorMessages(await store.createType({
      type,
      description: "Should fail.",
      schema,
    }))[0] ?? "", message);
  }

  const invalid = {
    type: "repeat-invalid-schema",
    description: "Should fail consistently.",
    schema: { type: "not-a-json-type" },
  };
  const firstErrors = errorMessages(await store.createType(invalid));
  const secondErrors = errorMessages(await store.createType(invalid));
  assert.match(firstErrors[0] ?? "", /expected one of/u);
  assert.deepEqual(secondErrors, firstErrors);

  assert.deepEqual(await store.createType({
    type: "invalid-schema",
    description: "Should include its type URI in the refusal.",
    schema: { type: "not-a-json-type" },
  }), {
    errors: [{
      uri: "autofile:///_types/invalid-schema",
      message: "schema.type: expected one of \"array\", \"boolean\", \"integer\", \"null\", \"number\", \"object\", or \"string\"",
    }],
  });
});

test("URI and blob formats on the root report their string requirement without an empty location", async () => {
  const { store } = await makeStore();
  for (const [type, format] of [["root-uris", "uri"], ["root-blobs", "blob"]]) {
    assert.deepEqual(await store.createType({
      type,
      description: `Root values marked as ${format}.`,
      schema: { format },
    }), { uri: `autofile:///_types/${type}` });
    assert.deepEqual(await store.createRecord({
      type,
      key: "object",
      record: {},
    }), {
      errors: [{
        uri: `autofile:///${type}/object`,
        message: "must be a string",
      }],
    });
  }
});

test("blob writes materialize paths and data URIs through nested refs, arrays, and anyOf", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const pdf = Buffer.from("%PDF-1.7\npath fixture\n", "utf8");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const text = Buffer.from("data URI fixture\n", "utf8");
  const pdfPath = join(root, "Original.PDF");
  await writeFile(pdfPath, pdf);

  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "materialized",
    record: {
      file: pdfPath,
      attachments: [
        `data:image/png;base64,${image.toString("base64")}`,
        { file: `data:text/plain;charset=utf-8;base64,${text.toString("base64")}` },
      ],
    },
  }), { uri: "autofile:///documents/materialized" });

  const record = await store.getRecord({ uri: "autofile:///documents/materialized" });
  assert.ok("value" in record);
  assert.deepEqual(record.value, {
    file: expectedBlobUri(pdf, "pdf"),
    attachments: [
      expectedBlobUri(image, "png"),
      { file: expectedBlobUri(text, "txt") },
    ],
  });
  assert.deepEqual((await storedBlobNames(dataFolder)).sort(), [
    expectedBlobUri(pdf, "pdf").split("/").at(-1),
    expectedBlobUri(image, "png").split("/").at(-1),
    expectedBlobUri(text, "txt").split("/").at(-1),
  ].sort());
  assert.deepEqual(await readFile(
    join(dataFolder, "_blobs", expectedBlobUri(pdf, "pdf").split("/").at(-1) ?? ""),
  ), pdf);
});

test("blob writes accept existing blobs and refuse missing blobs and invalid candidates", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("shared contents\n", "utf8");
  const path = join(root, "shared.bin");
  await writeFile(path, bytes);
  await store.createRecord({
    type: "documents",
    key: "source",
    record: { file: path },
  });
  const uri = expectedBlobUri(bytes, "bin");
  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "existing",
    record: { file: uri },
  }), { uri: "autofile:///documents/existing" });

  const invalid: Array<[string, JsonValue, RegExp]> = [
    ["relative", "relative/file.pdf", /file/u],
    ["missing-path", join(root, "missing.pdf"), /does not exist/u],
    ["missing-uri", `autofile:///_blobs/${"a".repeat(64)}.pdf`, /does not exist/u],
    ["short-uri", "autofile:///_blobs/abcd.pdf", /file|blob/u],
    ["uppercase-uri", `autofile:///_blobs/${"A".repeat(64)}.PDF`, /file|blob/u],
    ["not-base64", "data:application/pdf;base64,%%%", /file|blob/u],
    ["noncanonical-base64", "data:application/pdf;base64,AB==", /file|blob/u],
    ["not-base64-data", "data:application/pdf,AA==", /file|blob/u],
    ["number", 42, /file.*string/u],
  ];
  for (const [key, file, message] of invalid) {
    const result = await store.createRecord({ type: "documents", key, record: { file } });
    assert.match(errorMessages(result)[0] ?? "", message, key);
  }
  const notStored = Buffer.from("valid candidate in a refused write\n", "utf8");
  assert.match(errorMessages(await store.createRecord({
    type: "documents",
    key: "partly-valid",
    record: {
      file: uri,
      attachments: [
        `data:text/plain;base64,${notStored.toString("base64")}`,
        join(root, "still-missing.pdf"),
      ],
    },
  }))[0] ?? "", /does not exist/u);
  assert.deepEqual(await storedBlobNames(dataFolder), [uri.split("/").at(-1)]);
});

test("blob paths can be disabled while data URIs remain accepted", async () => {
  const { root, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("transport boundary\n", "utf8");
  const path = join(root, "local.txt");
  await writeFile(path, bytes);

  assert.match(errorMessages(await store.createRecord({
    type: "documents",
    key: "path-over-http",
    record: { file: path },
  }, { allowLocalPaths: false }))[0] ?? "", /only.*stdio|local path/u);
  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "data-over-http",
    record: { file: `data:text/plain;base64,${bytes.toString("base64")}` },
  }, { allowLocalPaths: false }), { uri: "autofile:///documents/data-over-http" });
});

test("refused and duplicate record writes leave the blob folder unchanged", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const accepted = Buffer.from("accepted\n", "utf8");
  const refused = Buffer.from("refused\n", "utf8");
  await store.createRecord({
    type: "documents",
    key: "taken",
    record: { file: `data:text/plain;base64,${accepted.toString("base64")}` },
  });
  const before = await storedBlobNames(dataFolder);

  assert.match(errorMessages(await store.createRecord({
    type: "documents",
    key: "invalid-record",
    record: {
      file: `data:text/plain;base64,${refused.toString("base64")}`,
      unexpected: true,
    },
  }))[0] ?? "", /unexpected|additional/u);
  assert.match(errorMessages(await store.createRecord({
    type: "documents",
    key: "taken",
    record: { file: `data:text/plain;base64,${refused.toString("base64")}` },
  }))[0] ?? "", /already exists/u);
  const recordPath = join(dataFolder, "documents", "taken.json");
  const recordBefore = await readFile(recordPath, "utf8");
  assert.match(errorMessages(await store.updateRecord({
    uri: "autofile:///documents/taken",
    patch: {
      attachments: [
        `data:text/plain;base64,${refused.toString("base64")}`,
        join(root, "missing.pdf"),
      ],
    },
  }))[0] ?? "", /does not exist/u);
  assert.deepEqual(await storedBlobNames(dataFolder), before);
  assert.equal(await readFile(recordPath, "utf8"), recordBefore);
});

test("blob writes validate the materialized record before storing anything", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "data-only",
    description: "A deliberately incompatible post-materialization schema.",
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "blob", pattern: "^data:" } },
      additionalProperties: false,
    },
  });

  const result = await store.createRecord({
    type: "data-only",
    key: "refused",
    record: { file: "data:text/plain;base64,SGVsbG8=" },
  });
  assert.match(errorMessages(result)[0] ?? "", /file/u);
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob writes recheck link annotations after materializing a data URI", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "linked-files",
    description: "Fields carrying both blob and URI annotations.",
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          allOf: [{ format: "blob" }, { format: "uri" }],
        },
      },
      additionalProperties: false,
    },
  });

  const result = await store.createRecord({
    type: "linked-files",
    key: "refused",
    record: { file: "data:text/plain;base64,SGVsbG8=" },
  });
  assert.match(errorMessages(result)[0] ?? "", /links to a record that does not exist/u);
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob writes refuse non-URI fields exposed by a conditional after materialization", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "conditional-blobs",
    description: "The annotated blob field changes with the first field's representation.",
    schema: {
      type: "object",
      required: ["first", "second"],
      properties: {
        first: { type: "string" },
        second: { type: "string" },
      },
      allOf: [{
        if: {
          properties: { first: { pattern: "^data:" } },
          required: ["first"],
        },
        then: { properties: { first: { format: "blob" } } },
        else: { properties: { second: { format: "blob" } } },
      }],
      additionalProperties: false,
    },
  });

  const result = await store.createRecord({
    type: "conditional-blobs",
    key: "refused",
    record: {
      first: "data:text/plain;base64,Rmlyc3QK",
      second: "data:text/plain;base64,U2Vjb25kCg==",
    },
  });

  assert.match(errorMessages(result)[0] ?? "", /second.*blob URI/u);
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob writes persist only prepared blobs still annotated in the final record", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const existingBytes = Buffer.from("already stored\n", "utf8");
  const existingUri = expectedBlobUri(existingBytes, "txt");
  await store.createRecord({
    type: "documents",
    key: "source",
    record: { file: `data:text/plain;base64,${existingBytes.toString("base64")}` },
  });
  await store.createType({
    type: "conditional-owners",
    description: "Only the field selected after materialization owns a blob.",
    schema: {
      type: "object",
      required: ["candidate", "owner"],
      properties: {
        candidate: { type: "string" },
        owner: { type: "string" },
      },
      allOf: [{
        if: {
          properties: { candidate: { pattern: "^data:" } },
          required: ["candidate"],
        },
        then: { properties: { candidate: { format: "blob" } } },
        else: { properties: { owner: { format: "blob" } } },
      }],
      additionalProperties: false,
    },
  });
  const unusedBytes = Buffer.from("prepared but not finally held\n", "utf8");
  const unusedUri = expectedBlobUri(unusedBytes, "txt");

  assert.deepEqual(await store.createRecord({
    type: "conditional-owners",
    key: "accepted",
    record: {
      candidate: `data:text/plain;base64,${unusedBytes.toString("base64")}`,
      owner: existingUri,
    },
  }), { uri: "autofile:///conditional-owners/accepted" });
  assert.deepEqual(await storedBlobNames(dataFolder), [existingUri.split("/").at(-1)]);
  assert.equal(await store.readResource(unusedUri), undefined);
});

test("blob size checks accept exactly 7 MiB and refuse larger paths before reading", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const limit = 7_340_032;
  const exactPath = join(root, "exact.bin");
  const oversizedPath = join(root, "oversized.bin");
  await Promise.all([writeFile(exactPath, ""), writeFile(oversizedPath, "")]);
  await Promise.all([truncate(exactPath, limit), truncate(oversizedPath, limit + 1)]);

  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "exact",
    record: { file: exactPath },
  }), { uri: "autofile:///documents/exact" });

  let readOversizedFile = false;
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== oversizedPath) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "readFile") {
          return (...readArgs: unknown[]) => {
            readOversizedFile = true;
            return Reflect.apply(target.readFile, target, readArgs);
          };
        }
        if (property === "read") {
          return (...readArgs: unknown[]) => {
            readOversizedFile = true;
            return Reflect.apply(target.read, target, readArgs);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    const refusal = await store.createRecord({
      type: "documents",
      key: "oversized",
      record: { file: oversizedPath },
    });
    const message = errorMessages(refusal)[0] ?? "";
    assert.match(message, new RegExp(String(limit + 1), "u"));
    assert.match(message, new RegExp(String(limit), "u"));
    assert.equal(readOversizedFile, false);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal((await storedBlobNames(dataFolder)).length, 1);
});

test("blob path reads stop at one byte over the limit when stat underreports the source", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const limit = 7_340_032;
  const growingPath = join(root, "growing.bin");
  await writeFile(growingPath, Buffer.alloc(limit + 65_536));

  let bytesRead = 0;
  let readCalls = 0;
  let maximumRequestedBytes = 0;
  let readAfterLimit = false;
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== growingPath) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "stat") {
          return async (...statArgs: unknown[]) => {
            const details = await Reflect.apply(target.stat, target, statArgs);
            return new Proxy(details, {
              get(statTarget, statProperty, statReceiver) {
                if (statProperty === "size") return 0;
                const value = Reflect.get(statTarget, statProperty, statReceiver) as unknown;
                return typeof value === "function" ? value.bind(statTarget) : value;
              },
            });
          };
        }
        if (property === "read") {
          return async (...readArgs: unknown[]) => {
            if (bytesRead > limit) readAfterLimit = true;
            const requestedBytes = typeof readArgs[2] === "number" ? readArgs[2] : 0;
            maximumRequestedBytes = Math.max(maximumRequestedBytes, requestedBytes);
            readCalls += 1;
            const result = await Reflect.apply(target.read, target, readArgs) as { bytesRead: number };
            bytesRead += result.bytesRead;
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    const refusal = await store.createRecord({
      type: "documents",
      key: "growing",
      record: { file: growingPath },
    });
    const message = errorMessages(refusal)[0] ?? "";
    assert.match(message, new RegExp(String(limit + 1), "u"));
    assert.match(message, new RegExp(String(limit), "u"));
    assert.equal(bytesRead, limit + 1);
    assert.equal(readAfterLimit, false);
    assert.ok(readCalls > 1);
    assert.ok(maximumRequestedBytes <= 64 * 1024);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob path inputs refuse directories", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const directoryPath = join(root, "directory.bin");
  await mkdir(directoryPath);

  const result = await store.createRecord({
    type: "documents",
    key: "directory",
    record: { file: directoryPath },
  });

  assert.match(errorMessages(result)[0] ?? "", /not a file/u);
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob path inputs refuse FIFOs without waiting for a writer", { timeout: 5_000 }, async (context) => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const fifoPath = join(root, "source.fifo");
  if (!await makeFifo(fifoPath)) {
    context.skip("mkfifo is not available on this platform");
    return;
  }

  const result = await store.createRecord({
    type: "documents",
    key: "fifo",
    record: { file: fifoPath },
  });

  assert.match(errorMessages(result)[0] ?? "", /not a file/u);
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("blob path inputs refuse sockets", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const socketPath = join(root, "source.socket");
  const server = createServer();
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(socketPath, resolveListening);
  });
  try {
    const result = await store.createRecord({
      type: "documents",
      key: "socket",
      record: { file: socketPath },
    });

    assert.match(errorMessages(result)[0] ?? "", /not a file/u);
    assert.deepEqual(await storedBlobNames(dataFolder), []);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
});

test("blob path inputs follow symlinks to regular files and use the supplied path extension", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("followed symlink\n", "utf8");
  const targetPath = join(root, "target.bin");
  const linkPath = join(root, "alias.SYMLINK_EXT");
  await writeFile(targetPath, bytes);
  await symlink(targetPath, linkPath);

  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "symlink",
    record: { file: linkPath },
  }), { uri: "autofile:///documents/symlink" });
  const uri = expectedBlobUri(bytes, "symlink_ext");
  const record = await store.getRecord({ uri: "autofile:///documents/symlink" });
  assert.ok("value" in record);
  assert.equal(record.value.file, uri);
  assert.deepEqual(await readFile(join(dataFolder, "_blobs", uri.split("/").at(-1) ?? "")), bytes);
});

test("blob extensions use one safe grammar for paths, media types, listing, and reading", async () => {
  const { root, store } = await makeStore();
  await createDocumentsType(store);
  const inputs: Array<{ bytes: Buffer; extension?: string; value: string }> = [];
  for (const [name, contents, extension] of [
    ["path.HYPHEN-EXT", "path hyphen\n", "hyphen-ext"],
    ["path.UNDER_SCORE", "path underscore\n", "under_score"],
    ["path.BAD+EXT", "path unsafe\n", undefined],
  ] as const) {
    const bytes = Buffer.from(contents, "utf8");
    const path = join(root, name);
    await writeFile(path, bytes);
    inputs.push({ bytes, extension, value: path });
  }
  for (const [mediaType, contents, extension] of [
    ["application/vnd.hydrostatix.sof-data", "media hyphen\n", "sfd-hdstx"],
    ["model/vnd.parasolid.transmit.binary", "media underscore\n", "x_b"],
  ] as const) {
    const bytes = Buffer.from(contents, "utf8");
    inputs.push({
      bytes,
      extension,
      value: `data:${mediaType};base64,${bytes.toString("base64")}`,
    });
  }

  const attachments = inputs.slice(1).map(({ value }) => value);
  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "extensions",
    record: { file: inputs[0]?.value ?? "", attachments },
  }), { uri: "autofile:///documents/extensions" });
  const expectedUris = inputs.map(({ bytes, extension }) => expectedBlobUri(bytes, extension));
  const record = await store.getRecord({ uri: "autofile:///documents/extensions" });
  assert.ok("value" in record);
  assert.deepEqual(record.value, {
    file: expectedUris[0],
    attachments: expectedUris.slice(1),
  });

  const resources = await store.listResources();
  for (const [index, uri] of expectedUris.entries()) {
    assert.equal(resources.some((resource) => resource.uri === uri), true);
    const contents = await store.readResource(uri ?? "");
    assert.ok(contents !== undefined && "blob" in contents);
    assert.deepEqual(Buffer.from(contents.blob, "base64"), inputs[index]?.bytes);
  }
});

test("blob size checks refuse an oversized data URI with its size and limit", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const limit = 7_340_032;
  const bytes = Buffer.alloc(limit + 1);
  const refusal = await store.createRecord({
    type: "documents",
    key: "oversized-data",
    record: { file: `data:application/octet-stream;base64,${bytes.toString("base64")}` },
  });
  const message = errorMessages(refusal)[0] ?? "";
  assert.match(message, new RegExp(String(limit + 1), "u"));
  assert.match(message, new RegExp(String(limit), "u"));
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("storing the same blob twice does not rewrite its file", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("deduplicated\n", "utf8");
  const path = join(root, "same.TXT");
  await writeFile(path, bytes);
  await store.createRecord({ type: "documents", key: "one", record: { file: path } });
  const name = expectedBlobUri(bytes, "txt").split("/").at(-1) ?? "";
  const blobPath = join(dataFolder, "_blobs", name);
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await utimes(blobPath, oldTime, oldTime);

  assert.deepEqual(await store.createRecord({
    type: "documents",
    key: "two",
    record: { file: path },
  }), { uri: "autofile:///documents/two" });
  assert.equal((await stat(blobPath)).mtime.toISOString(), oldTime.toISOString());
  assert.deepEqual(await storedBlobNames(dataFolder), [name]);
});

test("updates and deletes collect replaced blobs only after their records stop holding them", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const first = Buffer.from("first\n", "utf8");
  const second = Buffer.from("second\n", "utf8");
  const firstUri = expectedBlobUri(first, "txt");
  const secondUri = expectedBlobUri(second, "txt");
  await store.createRecord({
    type: "documents",
    key: "changed",
    record: { file: `data:text/plain;base64,${first.toString("base64")}` },
  });

  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///documents/changed",
    patch: { file: `data:text/plain;base64,${second.toString("base64")}` },
  }), { uri: "autofile:///documents/changed" });
  assert.deepEqual(await storedBlobNames(dataFolder), [secondUri.split("/").at(-1)]);
  const updated = await store.getRecord({ uri: "autofile:///documents/changed" });
  assert.ok("value" in updated);
  assert.equal(updated.value.file, secondUri);

  assert.deepEqual(await store.deleteRecord({ uri: "autofile:///documents/changed" }), {
    uri: "autofile:///documents/changed",
  });
  assert.deepEqual(await storedBlobNames(dataFolder), []);
  assert.notEqual(firstUri, secondUri);
});

test("shared blobs remain until the last record holding them is deleted", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("shared\n", "utf8");
  const data = `data:text/plain;base64,${bytes.toString("base64")}`;
  const uri = expectedBlobUri(bytes, "txt");
  await store.createRecord({ type: "documents", key: "one", record: { file: data } });
  await store.createRecord({ type: "documents", key: "two", record: { file: uri } });

  await store.deleteRecord({ uri: "autofile:///documents/one" });
  assert.deepEqual(await storedBlobNames(dataFolder), [uri.split("/").at(-1)]);
  await store.deleteRecord({ uri: "autofile:///documents/two" });
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("schema-invalid records retain every blob URI string, including nested array values", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("retained by invalid record\n", "utf8");
  const uri = expectedBlobUri(bytes, "txt");
  await store.createRecord({
    type: "documents",
    key: "owner",
    record: { file: `data:text/plain;base64,${bytes.toString("base64")}` },
  });
  await store.createType({
    type: "notes",
    description: "Notes that become invalid.",
    schema: { type: "object" },
  });
  await store.createRecord({
    type: "notes",
    key: "keeper",
    record: { nested: [{ value: uri }] },
  });
  await store.updateType({
    type: "notes",
    schema: {
      type: "object",
      required: ["fixed"],
      properties: { fixed: { const: true } },
      additionalProperties: false,
    },
  });

  await store.deleteRecord({ uri: "autofile:///documents/owner" });
  assert.deepEqual(await storedBlobNames(dataFolder), [uri.split("/").at(-1)]);
  await store.deleteRecord({ uri: "autofile:///notes/keeper" });
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("schema-valid records do not retain blob URIs outside annotated blob fields", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const bytes = Buffer.from("not retained by plain text\n", "utf8");
  const uri = expectedBlobUri(bytes, "txt");
  await store.createRecord({
    type: "documents",
    key: "owner",
    record: { file: `data:text/plain;base64,${bytes.toString("base64")}` },
  });
  await store.createType({
    type: "notes",
    description: "Valid records with unannotated strings.",
    schema: { type: "object" },
  });
  await store.createRecord({
    type: "notes",
    key: "non-owner",
    record: { nested: [{ value: uri }] },
  });

  assert.deepEqual(await store.deleteRecord({ uri: "autofile:///documents/owner" }), {
    uri: "autofile:///documents/owner",
  });
  assert.deepEqual(await storedBlobNames(dataFolder), []);
});

test("an unreadable record suppresses all blob deletion", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const previous = Buffer.from("kept while unreadable\n", "utf8");
  const replacement = Buffer.from("replacement while unreadable\n", "utf8");
  const previousUri = expectedBlobUri(previous, "txt");
  const replacementUri = expectedBlobUri(replacement, "txt");
  await store.createRecord({
    type: "documents",
    key: "owner",
    record: { file: `data:text/plain;base64,${previous.toString("base64")}` },
  });
  await writeFile(join(dataFolder, "documents", "broken.json"), "{\n");

  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///documents/owner",
    patch: { file: `data:text/plain;base64,${replacement.toString("base64")}` },
  }), { uri: "autofile:///documents/owner" });
  assert.deepEqual((await storedBlobNames(dataFolder)).sort(), [
    previousUri.split("/").at(-1),
    replacementUri.split("/").at(-1),
  ].sort());
});

test("blob writes precede record writes and unheld blob deletions happen last", async () => {
  const { dataFolder, store } = await makeStore();
  await createDocumentsType(store);
  const first = Buffer.from("ordered first\n", "utf8");
  const second = Buffer.from("ordered second\n", "utf8");
  await store.createRecord({
    type: "documents",
    key: "ordered",
    record: { file: `data:text/plain;base64,${first.toString("base64")}` },
  });
  const firstPath = join(dataFolder, "_blobs", expectedBlobUri(first, "txt").split("/").at(-1) ?? "");
  const secondPath = join(dataFolder, "_blobs", expectedBlobUri(second, "txt").split("/").at(-1) ?? "");
  const recordPath = join(dataFolder, "documents", "ordered.json");
  const operations: string[] = [];
  const originalRename = fsPromises.rename;
  const originalUnlink = fsPromises.unlink;
  fsPromises.rename = (async (...args: Parameters<typeof originalRename>) => {
    if (args[1] === secondPath) operations.push("write blob");
    if (args[1] === recordPath) operations.push("write record");
    return originalRename(...args);
  }) as typeof fsPromises.rename;
  fsPromises.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    if (args[0] === firstPath) operations.push("delete old blob");
    return originalUnlink(...args);
  }) as typeof fsPromises.unlink;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await store.updateRecord({
      uri: "autofile:///documents/ordered",
      patch: { file: `data:text/plain;base64,${second.toString("base64")}` },
    }), { uri: "autofile:///documents/ordered" });
  } finally {
    fsPromises.rename = originalRename;
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.deepEqual(operations, ["write blob", "write record", "delete old blob"]);
});

test("the write lock covers blob storage and record storage together", async () => {
  const { dataFolder, root, store } = await makeStore();
  await createDocumentsType(store);
  const writeLockPath = join(root, "autofile-home", "write.lock");
  const readyPath = join(root, "blob-holder-ready");
  const releasePath = join(root, "release-blob-holder");
  const holderScript = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import lockfile from "proper-lockfile";
    const [lockTarget, writeLockPath, readyPath, releasePath] = process.argv.slice(1);
    const release = await lockfile.lock(lockTarget, {
      lockfilePath: writeLockPath,
      stale: 10_000,
      update: 5_000,
      retries: 0,
    });
    await writeFile(readyPath, "ready\\n");
    while (true) {
      try { await access(releasePath); break; } catch {}
      await delay(10);
    }
    await release();
  `;
  const holder = runChild(holderScript, [dirname(writeLockPath), writeLockPath, readyPath, releasePath]);
  for (let attempt = 0; !await pathExists(readyPath); attempt += 1) {
    if (attempt === 500) assert.fail("blob lock holder did not become ready");
    await delay(10);
  }

  let settled = false;
  const write = store.createRecord({
    type: "documents",
    key: "waited",
    record: { file: "data:text/plain;base64,V2FpdGVkCg==" },
  }).finally(() => {
    settled = true;
  });
  await delay(150);
  try {
    assert.equal(settled, false);
    assert.deepEqual(await storedBlobNames(dataFolder), []);
  } finally {
    await writeFile(releasePath, "release\n");
  }
  await holder;
  assert.deepEqual(await write, { uri: "autofile:///documents/waited" });
  assert.equal((await storedBlobNames(dataFolder)).length, 1);
});

test("record writes check annotated link fields at every depth and ignore plain text URIs", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "organizations",
    description: "Organizations.",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  });
  await store.createType({
    type: "people",
    description: "People and their links.",
    schema: {
      $defs: { link: { type: "string", format: "uri" } },
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        employer: { $ref: "#/$defs/link" },
        related: { type: "array", items: { $ref: "#/$defs/link" } },
        details: {
          type: "object",
          properties: { website: { $ref: "#/$defs/link" } },
        },
        markdown: { type: "string" },
      },
      additionalProperties: false,
    },
  });
  await store.createRecord({
    type: "organizations",
    key: "existing",
    record: { name: "Existing" },
  });

  assert.deepEqual(await store.createRecord({
    type: "people",
    key: "valid",
    record: {
      name: "Valid links",
      employer: "autofile:///organizations/existing",
      related: ["https://example.com/person"],
      details: { website: "mailto:person@example.com" },
      markdown: "See [missing](autofile:///organizations/missing).",
    },
  }), { uri: "autofile:///people/valid" });

  const danglingUri = "autofile:///organizations/missing";
  assert.deepEqual(await store.createRecord({
    type: "people",
    key: "dangling-ref",
    record: { name: "Dangling ref", employer: danglingUri },
  }), {
    errors: [{
      uri: "autofile:///people/dangling-ref",
      message: `employer: links to a record that does not exist: ${danglingUri}`,
    }],
  });
  assert.deepEqual(await store.createRecord({
    type: "people",
    key: "dangling-nested",
    record: { name: "Dangling nested", details: { website: danglingUri } },
  }), {
    errors: [{
      uri: "autofile:///people/dangling-nested",
      message: `details.website: links to a record that does not exist: ${danglingUri}`,
    }],
  });
  assert.deepEqual(await store.createRecord({
    type: "people",
    record: { name: "Dangling generated", related: [danglingUri] },
  }), {
    errors: [{
      message: `related.0: links to a record that does not exist: ${danglingUri}`,
    }],
  });
  const uppercaseSchemeUri = "AUTOFILE:///organizations/missing";
  assert.deepEqual(await store.createRecord({
    type: "people",
    key: "uppercase-scheme",
    record: { name: "Uppercase scheme", employer: uppercaseSchemeUri },
  }), {
    errors: [{
      uri: "autofile:///people/uppercase-scheme",
      message: `employer: links to a record that does not exist: ${uppercaseSchemeUri}`,
    }],
  });
  for (const key of ["dangling-ref", "dangling-nested"]) {
    await assert.rejects(stat(join(dataFolder, "people", `${key}.json`)));
  }

  const validPath = join(dataFolder, "people", "valid.json");
  const before = await readFile(validPath, "utf8");
  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///people/valid",
    patch: { related: [danglingUri] },
  }), {
    errors: [{
      uri: "autofile:///people/valid",
      message: `related.0: links to a record that does not exist: ${danglingUri}`,
    }],
  });
  assert.equal(await readFile(validPath, "utf8"), before);
});

test("link refusals distinguish an empty property name from the record root", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "empty-fields",
    description: "Records whose link field has an empty name.",
    schema: {
      type: "object",
      required: [""],
      properties: { "": { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  await store.createRecord({ type: "targets", key: "existing", record: {} });
  const missingUri = "autofile:///targets/missing";

  assert.deepEqual(await store.createRecord({
    type: "empty-fields",
    key: "create",
    record: { "": missingUri },
  }), {
    errors: [{
      uri: "autofile:///empty-fields/create",
      message: `/: links to a record that does not exist: ${missingUri}`,
    }],
  });

  await store.createRecord({
    type: "empty-fields",
    key: "update",
    record: { "": "autofile:///targets/existing" },
  });
  const path = join(dataFolder, "empty-fields", "update.json");
  const before = await readFile(path, "utf8");
  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///empty-fields/update",
    patch: { "": missingUri },
  }), {
    errors: [{
      uri: "autofile:///empty-fields/update",
      message: `/: links to a record that does not exist: ${missingUri}`,
    }],
  });
  assert.equal(await readFile(path, "utf8"), before);
});

test("only successful anyOf branches contribute link annotations", async () => {
  const { store } = await makeStore();
  const targetUri = "autofile:///targets/existing";
  const missingUri = "autofile:///targets/missing";
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "choices",
    description: "Values selected through anyOf.",
    schema: {
      type: "object",
      properties: {
        linked: {
          anyOf: [
            { type: "string", format: "uri", pattern: "^autofile:" },
            { const: "plain" },
          ],
        },
        notALink: {
          anyOf: [
            { type: "string", format: "uri", pattern: "^https:" },
            { enum: [targetUri, missingUri] },
          ],
        },
      },
      additionalProperties: false,
    },
  });
  await store.createRecord({ type: "targets", key: "existing", record: {} });

  assert.deepEqual(await store.createRecord({
    type: "choices",
    key: "failed-branch",
    record: { linked: "plain", notALink: missingUri },
  }), { uri: "autofile:///choices/failed-branch" });
  assert.deepEqual(await store.createRecord({
    type: "choices",
    key: "dangling",
    record: { linked: missingUri, notALink: targetUri },
  }), {
    errors: [{
      uri: "autofile:///choices/dangling",
      message: `linked: links to a record that does not exist: ${missingUri}`,
    }],
  });
  await store.createRecord({
    type: "choices",
    key: "cleanup",
    record: { linked: targetUri, notALink: targetUri },
  });

  assert.deepEqual(await store.deleteRecord({ uri: targetUri }), { uri: targetUri });
  const cleaned = await store.getRecord({ uri: "autofile:///choices/cleanup" });
  assert.ok("value" in cleaned);
  assert.deepEqual(cleaned.value, { notALink: targetUri });
});

test("a link target must be a record of a declared type but may fail its own schema", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "sources",
    description: "Link sources.",
    schema: {
      type: "object",
      required: ["target"],
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  await store.createRecord({ type: "targets", key: "invalid", record: { old: true } });
  await store.updateType({
    type: "targets",
    schema: {
      type: "object",
      required: ["new"],
      properties: { new: { type: "boolean" } },
      additionalProperties: false,
    },
  });
  assert.deepEqual(await store.createRecord({
    type: "sources",
    key: "schema-invalid-target",
    record: { target: "autofile:///targets/invalid" },
  }), { uri: "autofile:///sources/schema-invalid-target" });

  await mkdir(join(dataFolder, "undeclared"));
  await writeFile(join(dataFolder, "undeclared", "orphan.json"), `${JSON.stringify({
    createdAt: "2026-10-07T09:14:00Z",
    updatedAt: "2026-10-07T09:14:00Z",
    value: {},
  }, null, 2)}\n`);
  const undeclaredUri = "autofile:///undeclared/orphan";
  assert.deepEqual(await store.createRecord({
    type: "sources",
    key: "undeclared-target",
    record: { target: undeclaredUri },
  }), {
    errors: [{
      uri: "autofile:///sources/undeclared-target",
      message: `target: links to a record that does not exist: ${undeclaredUri}`,
    }],
  });

  await writeFile(join(dataFolder, "targets", "malformed.json"), "{}\n");
  const malformedUri = "autofile:///targets/malformed";
  assert.deepEqual(await store.createRecord({
    type: "sources",
    key: "malformed-target",
    record: { target: malformedUri },
  }), {
    errors: [{
      uri: "autofile:///sources/malformed-target",
      message: `target: links to a record that does not exist: ${malformedUri}`,
    }],
  });
});

test("record writes propagate an operating-system refusal while reading a link target", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "sources",
    description: "Link sources.",
    schema: {
      type: "object",
      required: ["target"],
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  const targetUri = "autofile:///targets/denied";
  const targetPath = join(dataFolder, "targets", "denied.json");
  const updatedPath = join(dataFolder, "sources", "updated.json");
  await store.createRecord({ type: "targets", key: "denied", record: {} });
  await store.createRecord({
    type: "sources",
    key: "updated",
    record: { target: "https://example.com/previous" },
  });
  const beforeUpdate = await readFile(updatedPath, "utf8");

  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === targetPath) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalOpen(...args);
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      store.createRecord({
        type: "sources",
        key: "created",
        record: { target: targetUri },
      }),
      { code: "EACCES" },
    );
    await assert.rejects(
      store.updateRecord({
        uri: "autofile:///sources/updated",
        patch: { target: targetUri },
      }),
      { code: "EACCES" },
    );
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  await assert.rejects(stat(join(dataFolder, "sources", "created.json")));
  assert.equal(await readFile(updatedPath, "utf8"), beforeUpdate);
});

test("delete_record removes annotated links from nested fields and arrays across types", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "contacts",
    description: "Contacts.",
    schema: {
      $defs: { link: { type: "string", format: "uri" } },
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        employer: { $ref: "#/$defs/link" },
        related: { type: "array", items: { $ref: "#/$defs/link" } },
        details: {
          type: "object",
          properties: { mentor: { $ref: "#/$defs/link" } },
        },
        markdown: { type: "string" },
      },
      additionalProperties: false,
    },
  });
  await store.createType({
    type: "projects",
    description: "Projects.",
    schema: {
      type: "object",
      properties: {
        sponsor: { type: "string", format: "uri" },
        references: { type: "array", items: { type: "string", format: "uri" } },
      },
      additionalProperties: false,
    },
  });
  const deletedUri = "autofile:///targets/deleted";
  const keptUri = "autofile:///targets/kept";
  await store.createRecord({ type: "targets", key: "deleted", record: {} });
  await store.createRecord({ type: "targets", key: "kept", record: {} });
  await store.createRecord({
    type: "contacts",
    key: "one",
    record: {
      name: "One",
      employer: deletedUri,
      related: [deletedUri, keptUri, deletedUri, "https://example.com/reference"],
      details: { mentor: deletedUri },
      markdown: `The plain text ${deletedUri} remains.`,
    },
  });
  await store.createRecord({
    type: "projects",
    key: "one",
    record: { sponsor: deletedUri, references: [keptUri, deletedUri] },
  });
  const contactBefore = await store.getRecord({ uri: "autofile:///contacts/one" });
  const projectBefore = await store.getRecord({ uri: "autofile:///projects/one" });
  assert.ok("createdAt" in contactBefore && "createdAt" in projectBefore);
  await delay(5);

  assert.deepEqual(await store.deleteRecord({ uri: deletedUri }), { uri: deletedUri });
  assert.match(errorMessages(await store.getRecord({ uri: deletedUri }))[0] ?? "", /does not exist/u);
  const contactAfter = await store.getRecord({ uri: "autofile:///contacts/one" });
  const projectAfter = await store.getRecord({ uri: "autofile:///projects/one" });
  assert.ok("createdAt" in contactAfter && "createdAt" in projectAfter);
  assert.equal(contactAfter.createdAt, contactBefore.createdAt);
  assert.equal(projectAfter.createdAt, projectBefore.createdAt);
  assert.notEqual(contactAfter.updatedAt, contactBefore.updatedAt);
  assert.notEqual(projectAfter.updatedAt, projectBefore.updatedAt);
  assert.deepEqual(contactAfter.value, {
    name: "One",
    related: [keptUri, "https://example.com/reference"],
    details: {},
    markdown: `The plain text ${deletedUri} remains.`,
  });
  assert.deepEqual(projectAfter.value, { references: [keptUri] });
});

test("delete_record refuses every invalid link removal and changes no file", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  for (const type of ["contacts", "projects"]) {
    await store.createType({
      type,
      description: "Required links.",
      schema: {
        type: "object",
        required: ["target"],
        properties: { target: { type: "string", format: "uri" } },
        additionalProperties: false,
      },
    });
  }
  await store.createType({
    type: "notes",
    description: "Optional links.",
    schema: {
      type: "object",
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  const targetUri = "autofile:///targets/required";
  await store.createRecord({ type: "targets", key: "required", record: {} });
  await store.createRecord({ type: "contacts", key: "one", record: { target: targetUri } });
  await store.createRecord({ type: "projects", key: "one", record: { target: targetUri } });
  await store.createRecord({ type: "notes", key: "removable", record: { target: targetUri } });
  const paths = [
    join(dataFolder, "contacts", "one.json"),
    join(dataFolder, "notes", "removable.json"),
    join(dataFolder, "projects", "one.json"),
    join(dataFolder, "targets", "required.json"),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));

  const result = await store.deleteRecord({ uri: targetUri });
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map(({ uri }) => uri), [
    "autofile:///contacts/one",
    "autofile:///projects/one",
  ]);
  assert.ok(result.errors.every(({ message }) => message.includes("target")));
  assert.deepEqual(
    await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    before,
  );
});

test("delete_record writes changed records before deleting their target", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "sources",
    description: "Link sources.",
    schema: {
      type: "object",
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  const targetUri = "autofile:///targets/ordered";
  const targetPath = join(dataFolder, "targets", "ordered.json");
  const sourcePath = join(dataFolder, "sources", "one.json");
  await store.createRecord({ type: "targets", key: "ordered", record: {} });
  await store.createRecord({ type: "sources", key: "one", record: { target: targetUri } });

  const operations: string[] = [];
  const originalRename = fsPromises.rename;
  const originalUnlink = fsPromises.unlink;
  fsPromises.rename = (async (...args: Parameters<typeof originalRename>) => {
    if (args[1] === sourcePath) operations.push("write source");
    return originalRename(...args);
  }) as typeof fsPromises.rename;
  fsPromises.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    if (args[0] === targetPath) operations.push("delete target");
    return originalUnlink(...args);
  }) as typeof fsPromises.unlink;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await store.deleteRecord({ uri: targetUri }), { uri: targetUri });
  } finally {
    fsPromises.rename = originalRename;
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.deepEqual(operations, ["write source", "delete target"]);
});

test("delete_record is blocked by an invalid record holding the URI or an unreadable record", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  await store.createType({
    type: "notes",
    description: "Notes.",
    schema: { type: "object" },
  });
  const targetUri = "autofile:///targets/blocked";
  await store.createRecord({ type: "targets", key: "blocked", record: {} });
  await store.createRecord({ type: "notes", key: "invalid", record: { text: targetUri } });
  await store.updateType({
    type: "notes",
    schema: {
      type: "object",
      required: ["fixed"],
      properties: { fixed: { type: "boolean" } },
      additionalProperties: false,
    },
  });
  const targetPath = join(dataFolder, "targets", "blocked.json");
  const invalidPath = join(dataFolder, "notes", "invalid.json");
  const beforeInvalid = [await readFile(targetPath, "utf8"), await readFile(invalidPath, "utf8")];

  assert.deepEqual(await store.deleteRecord({ uri: targetUri }), {
    errors: [{
      uri: "autofile:///notes/invalid",
      message: `record does not match its type and holds ${targetUri} as a string value`,
    }],
  });
  assert.deepEqual(
    [await readFile(targetPath, "utf8"), await readFile(invalidPath, "utf8")],
    beforeInvalid,
  );

  await store.updateRecord({ uri: "autofile:///notes/invalid", patch: { text: null, fixed: true } });
  const brokenPath = join(dataFolder, "notes", "broken.json");
  await writeFile(brokenPath, "{\n");
  const beforeUnreadable = [await readFile(targetPath, "utf8"), await readFile(brokenPath, "utf8")];
  assert.deepEqual(await store.deleteRecord({ uri: targetUri }), {
    errors: [{
      uri: "autofile:///notes/broken",
      message: "record file cannot be read as JSON",
    }],
  });
  assert.deepEqual(
    [await readFile(targetPath, "utf8"), await readFile(brokenPath, "utf8")],
    beforeUnreadable,
  );

  await writeFile(brokenPath, `${JSON.stringify({
    createdAt: "2026-10-07T09:14:00Z",
    updatedAt: "2026-10-07T09:14:00Z",
    value: { fixed: true },
  }, null, 2)}\n`);
  await writeFile(targetPath, "{\n");
  await store.createType({
    type: "required-links",
    description: "Links that cannot be removed.",
    schema: {
      type: "object",
      required: ["target"],
      properties: { target: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
  });
  await writeFile(targetPath, `${JSON.stringify({
    createdAt: "2026-10-07T09:14:00Z",
    updatedAt: "2026-10-07T09:14:00Z",
    value: {},
  }, null, 2)}\n`);
  await store.createRecord({
    type: "required-links",
    key: "blocked",
    record: { target: targetUri },
  });
  await writeFile(targetPath, "{\n");
  const requiredPath = join(dataFolder, "required-links", "blocked.json");
  const beforeTargetBlockers = [
    await readFile(requiredPath, "utf8"),
    await readFile(targetPath, "utf8"),
  ];
  assert.deepEqual(await store.deleteRecord({ uri: targetUri }), {
    errors: [
      {
        uri: "autofile:///required-links/blocked",
        message: "missing required property: target",
      },
      {
        uri: targetUri,
        message: "record file cannot be read as JSON",
      },
    ],
  });
  assert.deepEqual(
    [await readFile(requiredPath, "utf8"), await readFile(targetPath, "utf8")],
    beforeTargetBlockers,
  );
});

test("delete_record reports an operating-system refusal while reading its target", async () => {
  const { dataFolder, store } = await makeStore();
  await store.createType({
    type: "targets",
    description: "Link targets.",
    schema: { type: "object" },
  });
  const uri = "autofile:///targets/denied";
  const path = join(dataFolder, "targets", "denied.json");
  await store.createRecord({ type: "targets", key: "denied", record: {} });
  const before = await readFile(path, "utf8");

  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === path) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalOpen(...args);
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await store.deleteRecord({ uri }), {
      errors: [{ uri, message: "record file cannot be read: EACCES" }],
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(path, "utf8"), before);
});

test("create_record writes the exact envelope and get_record returns it with its URI", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);

  assert.deepEqual(await store.createRecord({
    type: "tasks",
    key: "book-dentist",
    record: { title: "Book dentist", status: "active" },
  }), { uri: "autofile:///tasks/book-dentist" });
  const record = await store.getRecord({ uri: "autofile:///tasks/book-dentist" });
  assert.ok("createdAt" in record);
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u);
  assert.equal(record.updatedAt, record.createdAt);
  assert.deepEqual(record.value, { title: "Book dentist", status: "active" });
  assert.equal(
    await readFile(join(dataFolder, "tasks", "book-dentist.json"), "utf8"),
    `${JSON.stringify({ createdAt: record.createdAt, updatedAt: record.updatedAt, value: record.value }, null, 2)}\n`,
  );
  assert.deepEqual(record, {
    uri: "autofile:///tasks/book-dentist",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    value: { title: "Book dentist", status: "active" },
  });
});

test("record files with legacy created and updated fields are invalid", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  const uri = "autofile:///tasks/legacy-times";
  await writeFile(join(dataFolder, "tasks", "legacy-times.json"), `${JSON.stringify({
    created: "2026-10-07T09:14:00Z",
    updated: "2026-10-07T09:14:00Z",
    value: { title: "Legacy times", status: "active" },
  }, null, 2)}\n`);

  assert.match(errorMessages(await store.getRecord({ uri }))[0] ?? "", /valid record/u);
  assert.deepEqual(await store.findRecords({ type: "tasks" }), {
    records: [],
    errors: [{ uri, message: "record file does not contain a valid record" }],
  });
  assert.equal((await store.listResources()).some((resource) => resource.uri === uri), false);
  assert.equal(await store.readResource(uri), undefined);
});

test("find_records combines recursive word search with MongoDB field matching", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "entries",
    description: "Searchable entries.",
    schema: {
      type: "object",
      required: ["title", "status"],
      properties: {
        title: { type: "string" },
        status: { type: "string" },
        details: { type: "object" },
        tags: { type: "array" },
        priority: { type: "integer" },
        optional: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  });
  const records: Array<[string, JsonObject]> = [
    ["alpha", {
      title: "Book the DENTIST",
      status: "active",
      details: { people: [{ name: "Priya" }] },
      tags: ["health", "urgent"],
      priority: 42,
    }],
    ["beta", {
      title: "Dentist receipt",
      status: "complete",
      details: { note: "Archive it" },
      tags: ["health"],
      optional: null,
    }],
    ["gamma", {
      title: "Call the bank",
      status: "active",
      details: { note: "Ask about the dentist recommendation" },
      tags: ["finance"],
    }],
    ["omega", {
      title: "Unrelated",
      status: "active",
      tags: ["misc"],
    }],
  ];
  for (const [key, record] of records) {
    await store.createRecord({ type: "entries", key, record });
  }

  const wordsAndField = await store.findRecords({
    type: "entries",
    q: "dEnTiSt PRIYA",
    where: { status: "active" },
  });
  assert.ok("records" in wordsAndField);
  assert.deepEqual(wordsAndField.records.map(({ uri }) => uri), [
    "autofile:///entries/alpha",
  ]);
  assert.deepEqual(wordsAndField.errors, []);
  assert.equal("cursor" in wordsAndField, false);

  const arrayEquality = await store.findRecords({ type: "entries", where: { tags: "health" } });
  assert.ok("records" in arrayEquality);
  assert.deepEqual(arrayEquality.records.map(({ uri }) => uri), [
    "autofile:///entries/alpha",
    "autofile:///entries/beta",
  ]);

  const missingOrNull = await store.findRecords({ type: "entries", where: { optional: null } });
  assert.ok("records" in missingOrNull);
  assert.deepEqual(missingOrNull.records.map(({ uri }) => uri), [
    "autofile:///entries/alpha",
    "autofile:///entries/beta",
    "autofile:///entries/gamma",
    "autofile:///entries/omega",
  ]);

  const dottedField = await store.findRecords({
    type: "entries",
    where: { "details.note": "Archive it" },
  });
  assert.ok("records" in dottedField);
  assert.deepEqual(dottedField.records.map(({ uri }) => uri), [
    "autofile:///entries/beta",
  ]);

  for (const q of ["priority", "42"]) {
    const valuesOnly = await store.findRecords({ type: "entries", q });
    assert.ok("records" in valuesOnly);
    assert.deepEqual(valuesOnly.records, []);
  }
});

test("find_records projects top-level fields after matching the whole record", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "matching",
    record: {
      title: "Projected title",
      status: "active",
      details: { summary: "Needle in an omitted field" },
      labels: ["private"],
    },
  });

  const projected = await store.findRecords({
    type: "tasks",
    q: "needle",
    where: { status: "active" },
    fields: ["title", "unknown"],
  });
  assert.ok("records" in projected);
  assert.deepEqual(projected.records.map(({ uri, value }) => ({ uri, value })), [{
    uri: "autofile:///tasks/matching",
    value: { title: "Projected title" },
  }]);
  assert.deepEqual(projected.errors, []);

  const unknownOnly = await store.findRecords({ type: "tasks", fields: ["unknown"] });
  assert.ok("records" in unknownOnly);
  assert.deepEqual(unknownOnly.records.map(({ value }) => value), [{}]);
});

test("find_records reports only schema-invalid records that match the search", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "matching",
    record: { title: "Needle", status: "complete" },
  });
  const timestamp = "2026-10-07T09:14:00Z";
  await Promise.all([
    writeFile(join(dataFolder, "tasks", "invalid-filtered-by-q.json"), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: "Haystack", status: "complete", unexpected: true },
    }, null, 2)}\n`),
    writeFile(join(dataFolder, "tasks", "invalid-filtered-by-where.json"), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: "Needle with the wrong status", status: "unknown" },
    }, null, 2)}\n`),
    writeFile(join(dataFolder, "tasks", "invalid-matching.json"), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: "Needle in an invalid record", status: "complete", unexpected: true },
    }, null, 2)}\n`),
    writeFile(join(dataFolder, "tasks", "unreadable.json"), "{\n"),
  ]);

  const result = await store.findRecords({
    type: "tasks",
    q: "needle",
    where: { status: "complete" },
    fields: ["title"],
  });
  assert.ok("records" in result);
  assert.deepEqual(result.records.map(({ uri, value }) => ({ uri, value })), [{
    uri: "autofile:///tasks/matching",
    value: { title: "Needle" },
  }]);
  assert.deepEqual(result.errors.map(({ uri }) => uri), [
    "autofile:///tasks/invalid-matching",
    "autofile:///tasks/unreadable",
  ]);
  assert.match(result.errors[0]?.message ?? "", /unexpected|additional/u);
  assert.match(result.errors[1]?.message ?? "", /JSON/u);
});

test("find_records caps pages by UTF-8 JSON bytes and pages across every result", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "entries",
    description: "Long entries.",
    schema: {
      type: "object",
      required: ["body"],
      properties: { body: { type: "string" } },
      additionalProperties: false,
    },
  });
  for (const key of ["a", "b", "c", "d", "e"]) {
    await store.createRecord({
      type: "entries",
      key,
      record: { body: `${key}${"🙂".repeat(9_000)}` },
    });
  }

  const uris: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await store.findRecords({ type: "entries", limit: 200, cursor });
    assert.ok("records" in page);
    assert.equal(page.records.length, 1);
    assert.deepEqual(page.errors, []);
    assert.ok(Buffer.byteLength(JSON.stringify({
      records: page.records,
      errors: page.errors,
    }), "utf8") <= 64 * 1024);
    uris.push(...page.records.map(({ uri }) => uri));
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== undefined);

  assert.equal(pages, 5);
  assert.deepEqual(uris, [
    "autofile:///entries/a",
    "autofile:///entries/b",
    "autofile:///entries/c",
    "autofile:///entries/d",
    "autofile:///entries/e",
  ]);
});

test("find_records returns a first result larger than the page size cap", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "entries",
    description: "Long entries.",
    schema: {
      type: "object",
      required: ["body"],
      properties: { body: { type: "string" } },
      additionalProperties: false,
    },
  });
  await store.createRecord({
    type: "entries",
    key: "oversized",
    record: { body: "x".repeat(70_000) },
  });

  const page = await store.findRecords({ type: "entries" });
  assert.ok("records" in page);
  assert.equal(page.records.length, 1);
  assert.deepEqual(page.errors, []);
  assert.ok(Buffer.byteLength(JSON.stringify({
    records: page.records,
    errors: page.errors,
  }), "utf8") > 64 * 1024);
  assert.equal("cursor" in page, false);
});

test("find_records reads past nonmatches until it fills the result page", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  const records: Array<[string, string]> = [
    ["a", "Haystack A"],
    ["b", "Needle B"],
    ["c", "Haystack C"],
    ["d", "Needle D"],
    ["e", "Haystack E"],
  ];
  for (const [key, title] of records) {
    await store.createRecord({ type: "tasks", key, record: { title, status: "active" } });
  }

  const first = await store.findRecords({ type: "tasks", q: "needle", limit: 2 });
  assert.ok("records" in first && first.cursor !== undefined);
  assert.deepEqual(first.records.map(({ uri }) => uri), [
    "autofile:///tasks/b",
    "autofile:///tasks/d",
  ]);
  assert.deepEqual(first.errors, []);

  const second = await store.findRecords({ type: "tasks", q: "needle", limit: 2, cursor: first.cursor });
  assert.ok("records" in second);
  assert.deepEqual(second, { records: [], errors: [] });
});

test("find_records pages record files in URI order and advances after a deleted cursor file", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  const timestamp = "2026-10-07T09:14:00Z";
  const storedRecord = (title: string, status = "active") => `${JSON.stringify({
    createdAt: timestamp,
    updatedAt: timestamp,
    value: { title, status },
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(dataFolder, "tasks", "e.json"), storedRecord("E")),
    writeFile(join(dataFolder, "tasks", "d.json"), storedRecord("D", "unknown")),
    writeFile(join(dataFolder, "tasks", "c.json"), storedRecord("C")),
    writeFile(join(dataFolder, "tasks", "b.json"), storedRecord("B")),
    writeFile(join(dataFolder, "tasks", "a.json"), "{\n"),
  ]);

  const first = await store.findRecords({ type: "tasks", limit: 2 });
  assert.ok("records" in first && first.cursor !== undefined);
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///tasks/b"]);
  assert.deepEqual(first.errors, [{
    uri: "autofile:///tasks/a",
    message: "record file cannot be read as JSON",
  }]);

  await writeFile(join(dataFolder, "tasks", "a.json"), storedRecord("A"));
  assert.deepEqual(await store.deleteRecord({ uri: "autofile:///tasks/b" }), {
    uri: "autofile:///tasks/b",
  });
  const second = await store.findRecords({ type: "tasks", limit: 2, cursor: first.cursor });
  assert.ok("records" in second && second.cursor !== undefined);
  assert.deepEqual(second.records.map(({ uri }) => uri), ["autofile:///tasks/c"]);
  assert.deepEqual(second.errors.map(({ uri }) => uri), ["autofile:///tasks/d"]);
  assert.match(second.errors[0]?.message ?? "", /status/u);

  const third = await store.findRecords({ type: "tasks", limit: 2, cursor: second.cursor });
  assert.ok("records" in third);
  assert.deepEqual(third.records.map(({ uri }) => uri), ["autofile:///tasks/e"]);
  assert.deepEqual(third.errors, []);
  assert.equal("cursor" in third, false);
});

test("find_records returns at most 50 results by default", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  const timestamp = "2026-10-07T09:14:00Z";
  await Promise.all(Array.from({ length: 51 }, async (_, index) => {
    const key = `item-${String(index).padStart(2, "0")}`;
    await writeFile(join(dataFolder, "tasks", `${key}.json`), `${JSON.stringify({
      createdAt: timestamp,
      updatedAt: timestamp,
      value: { title: key, status: "active" },
    }, null, 2)}\n`);
  }));

  const first = await store.findRecords({ type: "tasks" });
  assert.ok("records" in first && first.cursor !== undefined);
  assert.equal(first.records.length, 50);
  assert.equal(first.records[0]?.uri, "autofile:///tasks/item-00");
  assert.equal(first.records.at(-1)?.uri, "autofile:///tasks/item-49");
  assert.deepEqual(first.errors, []);

  const second = await store.findRecords({ type: "tasks", cursor: first.cursor });
  assert.ok("records" in second);
  assert.deepEqual(second.records.map(({ uri }) => uri), [
    "autofile:///tasks/item-50",
  ]);
  assert.deepEqual(second.errors, []);
  assert.equal("cursor" in second, false);
});

test("find_records refuses invalid arguments, operators at any depth, and invalid cursors", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "one",
    record: { title: "One", status: "active" },
  });
  await store.createRecord({
    type: "tasks",
    key: "two",
    record: { title: "Two", status: "active" },
  });

  assert.deepEqual(await store.findRecords({ type: "Tasks" }), {
    errors: [{
      message: "type: must use lowercase letters, digits, and hyphens and start with a letter",
    }],
  });
  assert.deepEqual(await store.findRecords({ type: "missing" }), {
    errors: [{ uri: "autofile:///_types/missing", message: "type does not exist" }],
  });
  assert.deepEqual(await store.findRecords({
    type: "tasks",
    q: 42 as unknown as string,
  }), { errors: [{ message: "q: must be a string" }] });
  assert.deepEqual(await store.findRecords({
    type: "tasks",
    where: [] as unknown as JsonObject,
  }), { errors: [{ message: "where: must be a JSON object" }] });
  for (const limit of [0, 1.5, 201]) {
    assert.deepEqual(await store.findRecords({ type: "tasks", limit }), {
      errors: [{ message: "limit: must be an integer from 1 to 200" }],
    });
  }
  for (const fields of ["title", [""], ["title", 42]]) {
    assert.deepEqual(await store.findRecords({
      type: "tasks",
      fields: fields as unknown as string[],
    }), {
      errors: [{ message: "fields: must be an array of non-empty strings" }],
    });
  }
  assert.deepEqual(await store.findRecords({
    type: "tasks",
    cursor: 42 as unknown as string,
  }), { errors: [{ message: "cursor: must be a string" }] });
  assert.deepEqual(await store.findRecords({
    type: "tasks",
    where: { nested: [{ condition: { $lt: 3 } }] },
  }), { errors: [{ message: "where: the operator $lt is not supported" }] });
  const unsafeWhereCases: Array<[JsonObject, string]> = [
    [JSON.parse('{"__proto__":"value"}') as JsonObject, "__proto__"],
    [{ nested: [{ constructor: "value" }] }, "constructor"],
    [{ "details.prototype.name": "value" }, "prototype"],
  ];
  for (const [where, key] of unsafeWhereCases) {
    assert.deepEqual(await store.findRecords({ type: "tasks", where }), {
      errors: [{ message: `where: the key ${key} is not supported` }],
    });
  }
  assert.deepEqual(await store.findRecords({ type: "tasks", cursor: "not-a-cursor" }), {
    errors: [{ message: "cursor: is invalid" }],
  });

  await store.createType({
    type: "notes",
    description: "Notes.",
    schema: { type: "object" },
  });
  await store.createRecord({ type: "notes", key: "one", record: {} });
  await store.createRecord({ type: "notes", key: "two", record: {} });
  const notesPage = await store.findRecords({ type: "notes", limit: 1 });
  assert.ok("records" in notesPage && notesPage.cursor !== undefined);
  assert.deepEqual(await store.findRecords({ type: "tasks", cursor: notesPage.cursor }), {
    errors: [{ message: "cursor: is invalid" }],
  });
});

test("find_records reports an operating-system read refusal and continues", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "denied",
    record: { title: "Denied", status: "active" },
  });
  await store.createRecord({
    type: "tasks",
    key: "kept",
    record: { title: "Kept", status: "active" },
  });
  const kept = await store.getRecord({ uri: "autofile:///tasks/kept" });
  assert.ok("value" in kept);
  const deniedPath = join(dataFolder, "tasks", "denied.json");
  const originalOpen = fsPromises.open;
  // The test process runs as root, so mode bits cannot produce EACCES. Replace
  // only the filesystem boundary for this path with the error open(2) returns.
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === deniedPath) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalOpen(...args);
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    const result = await store.findRecords({ type: "tasks" });
    assert.deepEqual(result, {
      records: [{
        uri: kept.uri,
        createdAt: kept.createdAt,
        updatedAt: kept.updatedAt,
        value: kept.value,
      }],
      errors: [{
        uri: "autofile:///tasks/denied",
        message: "record file cannot be read: EACCES",
      }],
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("record keys and canonical record URIs are enforced", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  for (const key of ["", "Upper", "-leading", "under_score", "slash/key", ".hidden"]) {
    assert.deepEqual(await store.createRecord({
      type: "tasks",
      key,
      record: { title: "Invalid", status: "active" },
    }), {
      errors: [{
        message: "key: must use lowercase letters, digits, and hyphens and start with a letter or digit",
      }],
    });
  }
  await store.createRecord({
    type: "tasks",
    key: "same-key",
    record: { title: "One", status: "active" },
  });
  assert.match(errorMessages(await store.createRecord({
    type: "tasks",
    key: "same-key",
    record: { title: "Two", status: "active" },
  }))[0] ?? "", /already exists/u);
  for (const uri of [
    "autofile://tasks/same-key",
    "autofile:///tasks/same-key.json",
    "autofile:///tasks/../same-key",
    "https://example.com/tasks/same-key",
    "autofile:///_types/tasks",
  ]) {
    const refusal = {
      errors: [{
        message: "uri: must be a record URI, such as autofile:///task/book-the-dentist",
      }],
    };
    assert.deepEqual(await store.getRecord({ uri }), refusal);
    assert.deepEqual(await store.updateRecord({ uri, patch: {} }), refusal);
    assert.deepEqual(await store.deleteRecord({ uri }), refusal);
  }
});

test("generated keys are sortable AT Protocol TIDs chosen under the lock", async () => {
  const { store } = await makeStore();
  await createTasksType(store);
  const originalDateNow = Date.now;
  const fixedNow = originalDateNow() + 1_000_000;
  Date.now = () => fixedNow;
  let first;
  let second;
  let occupiedKey: string;
  try {
    first = await store.createRecord({
      type: "tasks",
      record: { title: "First", status: "active" },
    });
    assert.ok("uri" in first);
    const firstKey = first.uri.slice(first.uri.lastIndexOf("/") + 1);
    occupiedKey = encodeTid(decodeTid(firstKey) + (1n << 10n));
    await store.createRecord({
      type: "tasks",
      key: occupiedKey,
      record: { title: "Occupied generated candidate", status: "active" },
    });
    second = await store.createRecord({
      type: "tasks",
      record: { title: "Second", status: "active" },
    });
  } finally {
    Date.now = originalDateNow;
  }
  assert.ok("uri" in first && "uri" in second);
  const firstKey = first.uri.slice(first.uri.lastIndexOf("/") + 1);
  const secondKey = second.uri.slice(second.uri.lastIndexOf("/") + 1);
  assert.match(firstKey, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/u);
  assert.match(secondKey, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/u);
  assert.ok(firstKey < secondKey);
  assert.notEqual(secondKey, occupiedKey);
  assert.equal(secondKey, encodeTid(decodeTid(occupiedKey) + (1n << 10n)));
});

test("record writes are refused without changing files unless the complete value matches", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  assert.match(errorMessages(await store.createRecord({
    type: "tasks",
    key: "invalid",
    record: { title: "Missing status" },
  }))[0] ?? "", /status/u);
  await assert.rejects(stat(join(dataFolder, "tasks", "invalid.json")));
  assert.match(errorMessages(await store.createRecord({
    type: "missing",
    key: "no-type",
    record: {},
  }))[0] ?? "", /type.*does not exist/u);
});

test("update_record applies JSON Merge Patch and preserves createdAt while changing updatedAt", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "merge",
    record: {
      title: "Merge me",
      status: "active",
      details: { owner: "Alex", remove: true },
      labels: ["old"],
    },
  });
  const before = await store.getRecord({ uri: "autofile:///tasks/merge" });
  assert.ok("createdAt" in before);
  await delay(5);

  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///tasks/merge",
    patch: {
      status: "complete",
      details: { remove: null, note: "done" },
      labels: ["new"],
    },
  }), { uri: "autofile:///tasks/merge" });
  const afterRecord = await store.getRecord({ uri: "autofile:///tasks/merge" });
  assert.ok("createdAt" in afterRecord);
  assert.equal(afterRecord.createdAt, before.createdAt);
  assert.notEqual(afterRecord.updatedAt, before.updatedAt);
  assert.deepEqual(afterRecord.value, {
    title: "Merge me",
    status: "complete",
    details: { owner: "Alex", note: "done" },
    labels: ["new"],
  });
  assert.equal(
    await readFile(join(dataFolder, "tasks", "merge.json"), "utf8"),
    `${JSON.stringify({
      createdAt: afterRecord.createdAt,
      updatedAt: afterRecord.updatedAt,
      value: afterRecord.value,
    }, null, 2)}\n`,
  );

  await store.createType({
    type: "freeforms",
    description: "Objects used to exercise every JSON property name.",
    schema: { type: "object" },
  });
  await store.createRecord({ type: "freeforms", key: "prototype", record: { kept: true } });
  const prototypePatch = JSON.parse('{"__proto__":{"safe":true}}') as JsonObject;
  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///freeforms/prototype",
    patch: prototypePatch,
  }), { uri: "autofile:///freeforms/prototype" });
  const prototypeRecord = await store.getRecord({ uri: "autofile:///freeforms/prototype" });
  assert.ok("value" in prototypeRecord);
  assert.deepEqual(prototypeRecord.value, JSON.parse('{"kept":true,"__proto__":{"safe":true}}'));
  assert.equal(({} as { safe?: boolean }).safe, undefined);
});

test("update_type always writes a valid declaration and reports every record it invalidates", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  for (const [key, status] of [["one", "active"], ["two", "complete"]]) {
    await store.createRecord({
      type: "tasks",
      key,
      record: { title: key, status },
    });
  }
  const declarationPath = join(dataFolder, "_types", "tasks.json");
  const declarationBeforeRefusal = await readFile(declarationPath, "utf8");
  const invalidUpdate = await store.updateType({
    type: "tasks",
    schema: { type: "string", format: "not-known" },
  });
  assert.match(errorMessages(invalidUpdate)[0] ?? "", /format/u);
  assert.ok("errors" in invalidUpdate);
  assert.equal(invalidUpdate.errors[0]?.uri, "autofile:///_types/tasks");
  assert.equal(await readFile(declarationPath, "utf8"), declarationBeforeRefusal);
  const result = await store.updateType({
    type: "tasks",
    description: "Only waiting tasks.",
    titleField: null,
    schema: {
      type: "object",
      required: ["title", "status"],
      properties: {
        title: { type: "string" },
        status: { const: "waiting" },
      },
      additionalProperties: false,
    },
  });
  assert.ok("uri" in result && "errors" in result);
  assert.equal(result.uri, "autofile:///_types/tasks");
  assert.deepEqual(result.errors.map(({ uri }) => uri), [
    "autofile:///tasks/one",
    "autofile:///tasks/two",
  ]);
  assert.ok(result.errors.every(({ message }) => message.includes("status")));
  assert.deepEqual(await store.getType({ type: "tasks" }), {
    uri: "autofile:///_types/tasks",
    description: "Only waiting tasks.",
    schema: {
      type: "object",
      required: ["title", "status"],
      properties: {
        title: { type: "string" },
        status: { const: "waiting" },
      },
      additionalProperties: false,
    },
  });
  assert.ok(!await readFile(join(dataFolder, "_types", "tasks.json"), "utf8").then((text) => text.includes("titleField")));

  const invalid = await store.getRecord({ uri: "autofile:///tasks/one" });
  assert.ok("error" in invalid);
  const validationError = invalid.error;
  if (typeof validationError !== "string") assert.fail("invalid record should include an error");
  assert.match(validationError, /status/u);
  assert.deepEqual(await store.updateRecord({
    uri: "autofile:///tasks/one",
    patch: { status: "waiting" },
  }), { uri: "autofile:///tasks/one" });
  const repaired = await store.getRecord({ uri: "autofile:///tasks/one" });
  assert.ok(!("error" in repaired));
});

test("refused updates and unreadable record files return errors without overwriting", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "kept",
    record: { title: "Kept", status: "active" },
  });
  const recordPath = join(dataFolder, "tasks", "kept.json");
  const before = await readFile(recordPath, "utf8");
  assert.match(errorMessages(await store.updateRecord({
    uri: "autofile:///tasks/kept",
    patch: { status: "unknown" },
  }))[0] ?? "", /status/u);
  assert.equal(await readFile(recordPath, "utf8"), before);

  await writeFile(join(dataFolder, "tasks", "broken.json"), "{\n");
  assert.match(errorMessages(await store.getRecord({
    uri: "autofile:///tasks/broken",
  }))[0] ?? "", /JSON/u);
  assert.match(errorMessages(await store.updateRecord({
    uri: "autofile:///tasks/broken",
    patch: { status: "active" },
  }))[0] ?? "", /JSON/u);

  await writeFile(join(dataFolder, "tasks", "spoofed.json"), `${JSON.stringify({
    createdAt: "2026-10-07T09:14:00Z",
    updatedAt: "2026-10-07T09:14:00Z",
    value: { title: "Spoofed", status: "active" },
    uri: "https://example.com/spoofed",
    error: "fake",
  }, null, 2)}\n`);
  assert.match(errorMessages(await store.getRecord({
    uri: "autofile:///tasks/spoofed",
  }))[0] ?? "", /valid record/u);

  await writeFile(join(dataFolder, "tasks", "bad-time.json"), `${JSON.stringify({
    createdAt: "2026-02-31T00:00:00Z",
    updatedAt: "2026-10-07T24:00:00Z",
    value: { title: "Impossible time", status: "active" },
  }, null, 2)}\n`);
  assert.match(errorMessages(await store.getRecord({
    uri: "autofile:///tasks/bad-time",
  }))[0] ?? "", /valid record/u);
});

test("invalid UTF-8 and BOM-prefixed declarations and records are not exposed", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  const recordUri = "autofile:///tasks/malformed-utf8";
  const recordPath = join(dataFolder, "tasks", "malformed-utf8.json");
  await writeFile(recordPath, Buffer.concat([
    Buffer.from('{"createdAt":"2026-10-07T09:14:00Z","updatedAt":"2026-10-07T09:14:00Z","value":{"title":"'),
    Buffer.from([0xff]),
    Buffer.from('","status":"active"}}\n'),
  ]));

  assert.match(errorMessages(await store.getRecord({ uri: recordUri }))[0] ?? "", /UTF-8/u);
  assert.equal((await store.listResources()).some(({ uri }) => uri === recordUri), false);
  assert.equal(await store.readResource(recordUri), undefined);

  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bomRecordUri = "autofile:///tasks/bom-prefixed";
  await writeFile(join(dataFolder, "tasks", "bom-prefixed.json"), Buffer.concat([
    bom,
    Buffer.from('{"createdAt":"2026-10-07T09:14:00Z","updatedAt":"2026-10-07T09:14:00Z","value":{"title":"BOM","status":"active"}}\n'),
  ]));
  await writeFile(join(dataFolder, "_types", "bom-type.json"), Buffer.concat([
    bom,
    Buffer.from('{"description":"BOM type.","schema":{"type":"object"}}\n'),
  ]));
  assert.match(errorMessages(await store.getRecord({ uri: bomRecordUri }))[0] ?? "", /JSON/u);
  assert.match(errorMessages(await store.getType({ type: "bom-type" }))[0] ?? "", /JSON/u);
  const resourcesBeforeDeclarationCorruption = await store.listResources();
  for (const uri of [bomRecordUri, "autofile:///_types/bom-type"]) {
    assert.equal(resourcesBeforeDeclarationCorruption.some((resource) => resource.uri === uri), false);
    assert.equal(await store.readResource(uri), undefined);
  }

  const typeUri = "autofile:///_types/tasks";
  await writeFile(join(dataFolder, "_types", "tasks.json"), Buffer.concat([
    Buffer.from('{"description":"'),
    Buffer.from([0xff]),
    Buffer.from('","schema":{"type":"object"}}\n'),
  ]));

  assert.match(errorMessages(await store.getType({ type: "tasks" }))[0] ?? "", /UTF-8/u);
  assert.equal((await store.listResources()).some(({ uri }) => uri === typeUri), false);
  assert.equal(await store.readResource(typeUri), undefined);
});

test("resource reads reject symlinked storage directories and final files", async () => {
  const timestamp = "2026-10-07T09:14:00Z";
  const declarationText = `${JSON.stringify({
    description: "Things to do.",
    schema: { type: "object" },
  }, null, 2)}\n`;
  const recordText = `${JSON.stringify({
    createdAt: timestamp,
    updatedAt: timestamp,
    value: { title: "Outside the store" },
  }, null, 2)}\n`;
  const blobName = `${"a".repeat(64)}.pdf`;

  const directoryStore = await makeStore();
  const external = join(directoryStore.root, "external");
  await Promise.all([
    mkdir(join(external, "types"), { recursive: true }),
    mkdir(join(external, "blobs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(external, "types", "tasks.json"), declarationText),
    writeFile(join(external, "blobs", blobName), "outside blob"),
    symlink(join(external, "types"), join(directoryStore.dataFolder, "_types"), "dir"),
    symlink(join(external, "blobs"), join(directoryStore.dataFolder, "_blobs"), "dir"),
  ]);

  assert.deepEqual(await directoryStore.store.listResources(), []);
  assert.equal(
    await directoryStore.store.readResource("autofile:///_types/tasks"),
    undefined,
  );
  assert.equal(
    await directoryStore.store.readResource(`autofile:///_blobs/${blobName}`),
    undefined,
  );

  const fileStore = await makeStore();
  await fileStore.store.createType({
    type: "tasks",
    description: "Things to do.",
    schema: { type: "object" },
  });
  await fileStore.store.createType({
    type: "contacts",
    description: "People.",
    schema: { type: "object" },
  });
  await fileStore.store.createType({
    type: "events",
    description: "Events.",
    schema: { type: "object" },
  });
  await mkdir(join(fileStore.root, "outside-files"), { recursive: true });
  await Promise.all([
    writeFile(join(fileStore.root, "outside-files", "record.json"), recordText),
    writeFile(join(fileStore.root, "outside-files", "declaration.json"), declarationText),
    writeFile(join(fileStore.root, "outside-files", "blob.pdf"), "outside blob"),
    mkdir(join(fileStore.root, "outside-records"), { recursive: true }),
    mkdir(join(fileStore.dataFolder, "_blobs"), { recursive: true }),
  ]);
  await writeFile(join(fileStore.root, "outside-records", "one.json"), recordText);
  await rm(join(fileStore.dataFolder, "events"), { recursive: true });
  await rm(join(fileStore.dataFolder, "_types", "contacts.json"));
  await Promise.all([
    symlink(
      join(fileStore.root, "outside-records"),
      join(fileStore.dataFolder, "events"),
      "dir",
    ),
    symlink(
      join(fileStore.root, "outside-files", "record.json"),
      join(fileStore.dataFolder, "tasks", "linked.json"),
    ),
    symlink(
      join(fileStore.root, "outside-files", "declaration.json"),
      join(fileStore.dataFolder, "_types", "contacts.json"),
    ),
    symlink(
      join(fileStore.root, "outside-files", "blob.pdf"),
      join(fileStore.dataFolder, "_blobs", blobName),
    ),
  ]);

  const resources = await fileStore.store.listResources();
  for (const uri of [
    "autofile:///events/one",
    "autofile:///tasks/linked",
    "autofile:///_types/contacts",
    `autofile:///_blobs/${blobName}`,
  ]) {
    assert.equal(resources.some((resource) => resource.uri === uri), false);
    assert.equal(await fileStore.store.readResource(uri), undefined);
  }
});

test("resource reads reject FIFOs without waiting for a writer", { timeout: 5_000 }, async (context) => {
  const { dataFolder, store } = await makeStore();
  const blobName = `${"f".repeat(64)}.bin`;
  const blobFolder = join(dataFolder, "_blobs");
  const fifoPath = join(blobFolder, blobName);
  await mkdir(blobFolder, { recursive: true });
  if (!await makeFifo(fifoPath)) {
    context.skip("mkfifo is not available on this platform");
    return;
  }

  assert.equal(await store.readResource(`autofile:///_blobs/${blobName}`), undefined);
});

test("resource reads ignore storage paths whose components are not directories", async () => {
  const wrongRoots = await makeStore();
  await Promise.all([
    writeFile(join(wrongRoots.dataFolder, "_types"), "not a directory\n"),
    writeFile(join(wrongRoots.dataFolder, "_blobs"), "not a directory\n"),
  ]);
  assert.deepEqual(await wrongRoots.store.listResources(), []);
  assert.equal(
    await wrongRoots.store.readResource("autofile:///_types/tasks"),
    undefined,
  );
  assert.equal(
    await wrongRoots.store.readResource(`autofile:///_blobs/${"a".repeat(64)}.pdf`),
    undefined,
  );

  const wrongTypeFolder = await makeStore();
  await wrongTypeFolder.store.createType({
    type: "tasks",
    description: "Things to do.",
    schema: { type: "object" },
  });
  await rm(join(wrongTypeFolder.dataFolder, "tasks"), { recursive: true });
  await writeFile(join(wrongTypeFolder.dataFolder, "tasks"), "not a directory\n");
  assert.deepEqual(await wrongTypeFolder.store.listResources(), [{
    uri: "autofile:///_types/tasks",
    name: "_types/tasks",
    mimeType: "application/json",
    description: "Things to do.",
  }]);
  assert.equal(
    await wrongTypeFolder.store.readResource("autofile:///tasks/missing"),
    undefined,
  );
});

test("blob resources accept the size limit and ignore files one byte larger", async () => {
  const { dataFolder, store } = await makeStore();
  const maximumBlobBytes = 7_340_032;
  const acceptedName = `${"b".repeat(64)}.bin`;
  const oversizedName = `${"c".repeat(64)}.bin`;
  const blobFolder = join(dataFolder, "_blobs");
  await mkdir(blobFolder, { recursive: true });
  await Promise.all([
    writeFile(join(blobFolder, acceptedName), ""),
    writeFile(join(blobFolder, oversizedName), ""),
  ]);
  await Promise.all([
    truncate(join(blobFolder, acceptedName), maximumBlobBytes),
    truncate(join(blobFolder, oversizedName), maximumBlobBytes + 1),
  ]);

  const resources = await store.listResources();
  assert.deepEqual(resources, [{
    uri: `autofile:///_blobs/${acceptedName}`,
    name: `_blobs/${acceptedName}`,
    mimeType: "application/octet-stream",
    size: maximumBlobBytes,
  }]);
  const accepted = await store.readResource(`autofile:///_blobs/${acceptedName}`);
  assert.ok(accepted !== undefined && "blob" in accepted);
  assert.equal(Buffer.from(accepted.blob, "base64").byteLength, maximumBlobBytes);
  assert.equal(await store.readResource(`autofile:///_blobs/${oversizedName}`), undefined);
});

test("resources enforce recognized files but keep schema-invalid stored envelopes", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "kept",
    record: { title: "Kept", status: "active" },
  });
  await store.updateType({
    type: "tasks",
    schema: {
      type: "object",
      required: ["status"],
      properties: { status: { const: "complete" } },
    },
  });
  const keptUri = "autofile:///tasks/kept";
  const keptText = await readFile(join(dataFolder, "tasks", "kept.json"), "utf8");

  const timestamp = "2026-10-07T09:14:00Z";
  const blobDirectoryName = `${"d".repeat(64)}.pdf`;
  const validEnvelope = `${JSON.stringify({
    createdAt: timestamp,
    updatedAt: timestamp,
    value: { status: "complete" },
  }, null, 2)}\n`;
  await mkdir(join(dataFolder, "_blobs"), { recursive: true });
  await Promise.all([
    writeFile(join(dataFolder, "tasks", "malformed.json"), "{\n"),
    writeFile(join(dataFolder, "tasks", "invalid.json"), '{"value":{}}\n'),
    writeFile(join(dataFolder, "tasks", "Upper.json"), validEnvelope),
    writeFile(join(dataFolder, "tasks", "note.txt"), validEnvelope),
    mkdir(join(dataFolder, "tasks", "nested.json")),
    writeFile(join(dataFolder, "_types", "malformed.json"), "{\n"),
    writeFile(join(dataFolder, "_types", "invalid.json"), '{"description":42,"schema":{}}\n'),
    writeFile(
      join(dataFolder, "_types", "empty-title.json"),
      '{"description":"Bad title.","title":"","schema":{}}\n',
    ),
    writeFile(
      join(dataFolder, "_types", "bad-title.json"),
      '{"description":"Bad title.","title":42,"schema":{}}\n',
    ),
    writeFile(
      join(dataFolder, "_types", "empty-title-plural.json"),
      '{"description":"Bad plural title.","titlePlural":"","schema":{}}\n',
    ),
    writeFile(
      join(dataFolder, "_types", "bad-title-plural.json"),
      '{"description":"Bad plural title.","titlePlural":42,"schema":{}}\n',
    ),
    writeFile(
      join(dataFolder, "_types", "bad-schema.json"),
      '{"description":"Bad schema.","schema":{"type":"not-a-type"}}\n',
    ),
    writeFile(join(dataFolder, "_types", "Bad.json"), '{"description":"Bad","schema":{}}\n'),
    mkdir(join(dataFolder, "_types", "nested.json")),
    writeFile(join(dataFolder, "_blobs", "not-a-blob.pdf"), "ignored"),
    mkdir(join(dataFolder, "_blobs", blobDirectoryName)),
  ]);

  const resources = await store.listResources();
  assert.equal(resources.some(({ uri }) => uri === keptUri), true);
  assert.deepEqual(await store.readResource(keptUri), {
    uri: keptUri,
    mimeType: "application/json",
    text: keptText,
  });
  const listedTypes = await store.listTypes({});
  for (const type of [
    "empty-title",
    "bad-title",
    "empty-title-plural",
    "bad-title-plural",
  ]) {
    assert.equal(listedTypes.types.some((listed) => listed.type === type), false);
    assert.deepEqual(await store.getType({ type }), {
      errors: [{ uri: `autofile:///_types/${type}`, message: "type declaration is not valid" }],
    });
  }
  for (const uri of [
    "autofile:///tasks/malformed",
    "autofile:///tasks/invalid",
    "autofile:///tasks/Upper",
    "autofile:///tasks/note.txt",
    "autofile:///tasks/nested",
    "autofile:///_types/malformed",
    "autofile:///_types/invalid",
    "autofile:///_types/empty-title",
    "autofile:///_types/bad-title",
    "autofile:///_types/empty-title-plural",
    "autofile:///_types/bad-title-plural",
    "autofile:///_types/bad-schema",
    "autofile:///_types/Bad",
    "autofile:///_types/nested",
    "autofile:///_blobs/not-a-blob.pdf",
    `autofile:///_blobs/${blobDirectoryName}`,
  ]) {
    assert.equal(resources.some((resource) => resource.uri === uri), false);
    assert.equal(await store.readResource(uri), undefined);
  }
});

test("record readers ignore names and locations Autofile could not have written", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  const invalidRecord = `${JSON.stringify({
    createdAt: "2026-10-07T09:14:00Z",
    updatedAt: "2026-10-07T09:14:00Z",
    value: { title: "Invalid", status: "unknown" },
  }, null, 2)}\n`;
  await writeFile(join(dataFolder, "tasks", ".temporary.json"), invalidRecord);
  await writeFile(join(dataFolder, "tasks", "Upper.json"), invalidRecord);
  await writeFile(join(dataFolder, "tasks", "note.txt"), invalidRecord);
  await mkdir(join(dataFolder, "tasks", "nested.json"));
  await mkdir(join(dataFolder, "undeclared"));
  await writeFile(join(dataFolder, "undeclared", "record.json"), invalidRecord);

  assert.deepEqual(await store.updateType({ type: "tasks", description: "Still tasks." }), {
    uri: "autofile:///_types/tasks",
    errors: [],
  });
});

test("delete_record removes one file and delete_type requires an empty record folder", async () => {
  const { dataFolder, store } = await makeStore();
  await createTasksType(store);
  await store.createRecord({
    type: "tasks",
    key: "last",
    record: { title: "Last", status: "active" },
  });
  assert.match(errorMessages(await store.deleteType({ type: "tasks" }))[0] ?? "", /not empty/u);
  assert.deepEqual(await store.deleteRecord({ uri: "autofile:///tasks/last" }), {
    uri: "autofile:///tasks/last",
  });
  await assert.rejects(stat(join(dataFolder, "tasks", "last.json")));
  assert.match(errorMessages(await store.getRecord({ uri: "autofile:///tasks/last" }))[0] ?? "", /does not exist/u);
  assert.match(errorMessages(await store.deleteRecord({ uri: "autofile:///tasks/last" }))[0] ?? "", /does not exist/u);
  await writeFile(join(dataFolder, "tasks", ".DS_Store"), "ignored\n");
  assert.match(errorMessages(await store.deleteType({ type: "tasks" }))[0] ?? "", /not empty/u);
  await rm(join(dataFolder, "tasks", ".DS_Store"));
  assert.deepEqual(await store.deleteType({ type: "tasks" }), {
    uri: "autofile:///_types/tasks",
  });
  await assert.rejects(stat(join(dataFolder, "_types", "tasks.json")));
  await assert.rejects(stat(join(dataFolder, "tasks")));
});

test("several processes serialize generated-key creates and updates without losing records", async () => {
  const { dataFolder, root, store } = await makeStore();
  const writeLockPath = join(root, "autofile-home", "write.lock");
  await store.createType({
    type: "events",
    description: "Concurrent test events.",
    schema: {
      type: "object",
      required: ["worker", "index"],
      properties: {
        worker: { type: "integer" },
        index: { type: "integer" },
        complete: { type: "boolean" },
      },
      additionalProperties: false,
    },
  });
  const storeModule = pathToFileURL(resolve("dist/store.js")).href;
  const childScript = `
    import { openStore } from ${JSON.stringify(storeModule)};
    const [dataFolder, writeLockPath, workerText] = process.argv.slice(1);
    const childStore = await openStore({ dataFolder, writeLockPath });
    const worker = Number(workerText);
    for (let index = 0; index < 8; index += 1) {
      const created = await childStore.createRecord({ type: "events", record: { worker, index } });
      if (!("uri" in created)) throw new Error(JSON.stringify(created));
      const updated = await childStore.updateRecord({ uri: created.uri, patch: { complete: true } });
      if (!("uri" in updated)) throw new Error(JSON.stringify(updated));
    }
  `;
  await Promise.all(Array.from({ length: 4 }, (_, worker) => runChild(childScript, [
    dataFolder,
    writeLockPath,
    String(worker),
  ])));

  const names = (await readdir(join(dataFolder, "events"))).sort();
  assert.equal(names.length, 32);
  assert.equal(new Set(names).size, 32);
  for (const name of names) {
    assert.match(name, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}\.json$/u);
    const record = await store.getRecord({
      uri: `autofile:///events/${name.slice(0, -".json".length)}`,
    });
    assert.ok("value" in record);
    assert.equal(record.value.complete, true);
  }
  assert.equal((await readdir(dirname(writeLockPath))).includes("write.lock"), false);
});

test("concurrent processes preserve every merge patch to one record", async () => {
  const { dataFolder, root, store } = await makeStore();
  const writeLockPath = join(root, "autofile-home", "write.lock");
  const startPath = join(root, "start-patches");
  const workerCount = 6;
  await store.createType({
    type: "shared",
    description: "One record patched by several processes.",
    schema: {
      type: "object",
      additionalProperties: { type: "boolean" },
    },
  });
  await store.createRecord({ type: "shared", key: "one", record: { base: true } });

  const storeModule = pathToFileURL(resolve("dist/store.js")).href;
  const childScript = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { openStore } from ${JSON.stringify(storeModule)};
    const [dataFolder, writeLockPath, readyPath, startPath, workerText] = process.argv.slice(1);
    const childStore = await openStore({ dataFolder, writeLockPath });
    await writeFile(readyPath, "ready\\n");
    while (true) {
      try { await access(startPath); break; } catch {}
      await delay(5);
    }
    const worker = Number(workerText);
    const result = await childStore.updateRecord({
      uri: "autofile:///shared/one",
      patch: { [\`worker-\${worker}\`]: true },
    });
    if (!("uri" in result)) throw new Error(JSON.stringify(result));
  `;
  const readyPaths = Array.from(
    { length: workerCount },
    (_, worker) => join(root, `patch-worker-${String(worker)}-ready`),
  );
  const workers = readyPaths.map((readyPath, worker) => runChild(childScript, [
    dataFolder,
    writeLockPath,
    readyPath,
    startPath,
    String(worker),
  ]));
  for (let attempt = 0; !await allPathsExist(readyPaths); attempt += 1) {
    if (attempt === 500) assert.fail("patch workers did not become ready");
    await delay(10);
  }
  await writeFile(startPath, "start\n");
  await Promise.all(workers);

  const result = await store.getRecord({ uri: "autofile:///shared/one" });
  assert.ok("value" in result);
  assert.deepEqual(result.value, {
    base: true,
    ...Object.fromEntries(Array.from(
      { length: workerCount },
      (_, worker) => [`worker-${String(worker)}`, true],
    )),
  });
});

test("reads racing repeated updates see only complete record versions", async () => {
  const { dataFolder, root, store } = await makeStore();
  const writeLockPath = join(root, "autofile-home", "write.lock");
  const readyPath = join(root, "updater-ready");
  const startPath = join(root, "start-updates");
  const writerStartedPath = join(root, "writer-started");
  const readerObservedPath = join(root, "reader-observed");
  const iterations = 60;
  const payloadSize = 32_768;
  await store.createType({
    type: "snapshots",
    description: "Large records used to exercise atomic reads.",
    schema: {
      type: "object",
      required: ["version", "checksum", "payload"],
      properties: {
        version: { type: "integer", minimum: 0, maximum: iterations },
        checksum: { type: "string" },
        payload: { type: "string" },
      },
      additionalProperties: false,
    },
  });
  await store.createRecord({
    type: "snapshots",
    key: "current",
    record: {
      version: 0,
      checksum: "version-0",
      payload: `0:${"x".repeat(payloadSize)}`,
    },
  });

  const storeModule = pathToFileURL(resolve("dist/store.js")).href;
  const childScript = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { openStore } from ${JSON.stringify(storeModule)};
    const [
      dataFolder,
      writeLockPath,
      readyPath,
      startPath,
      writerStartedPath,
      readerObservedPath,
      iterationsText,
      sizeText,
    ] = process.argv.slice(1);
    const childStore = await openStore({ dataFolder, writeLockPath });
    await writeFile(readyPath, "ready\\n");
    while (true) {
      try { await access(startPath); break; } catch {}
      await delay(5);
    }
    const iterations = Number(iterationsText);
    const size = Number(sizeText);
    for (let version = 1; version <= iterations; version += 1) {
      const result = await childStore.updateRecord({
        uri: "autofile:///snapshots/current",
        patch: {
          version,
          checksum: \`version-\${version}\`,
          payload: \`\${version}:\${"x".repeat(size)}\`,
        },
      });
      if (!("uri" in result)) throw new Error(JSON.stringify(result));
      if (version === 1) {
        await writeFile(writerStartedPath, "started\\n");
        while (true) {
          try { await access(readerObservedPath); break; } catch {}
          await delay(5);
        }
        await delay(100);
      }
      await delay(2);
    }
  `;
  let updateSettled = false;
  const updater = runChild(childScript, [
    dataFolder,
    writeLockPath,
    readyPath,
    startPath,
    writerStartedPath,
    readerObservedPath,
    String(iterations),
    String(payloadSize),
  ]).finally(() => {
    updateSettled = true;
  });
  for (let attempt = 0; !await pathExists(readyPath); attempt += 1) {
    if (attempt === 500) assert.fail("updater did not become ready");
    await delay(10);
  }
  await writeFile(startPath, "start\n");
  for (let attempt = 0; !await pathExists(writerStartedPath); attempt += 1) {
    if (attempt === 500) assert.fail("updater did not write its first version");
    await delay(10);
  }
  await writeFile(readerObservedPath, "observed\n");

  const observedVersions = new Set<number>();
  let totalReads = 0;
  while (!updateSettled || totalReads < 100) {
    const result = await store.getRecord({ uri: "autofile:///snapshots/current" });
    assert.ok("value" in result, JSON.stringify(result));
    assert.ok(!("error" in result), JSON.stringify(result));
    const { version, checksum, payload } = result.value;
    if (typeof version !== "number") assert.fail("record version must be a number");
    assert.ok(Number.isInteger(version) && version >= 0 && version <= iterations);
    assert.equal(checksum, `version-${String(version)}`);
    assert.equal(payload, `${String(version)}:${"x".repeat(payloadSize)}`);
    observedVersions.add(version);
    totalReads += 1;
  }
  await updater;
  assert.ok(
    [...observedVersions].some((version) => version > 0 && version < iterations),
    "reader did not observe a complete intermediate version while updates remained",
  );
});

test("a public write waits until another process releases write.lock", async () => {
  const { root, store } = await makeStore();
  await createTasksType(store);
  const autofileHome = join(root, "autofile-home");
  const writeLockPath = join(autofileHome, "write.lock");
  const readyPath = join(root, "holder-ready");
  const releasePath = join(root, "release-holder");
  const holderScript = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import lockfile from "proper-lockfile";
    const [lockTarget, writeLockPath, readyPath, releasePath] = process.argv.slice(1);
    const release = await lockfile.lock(lockTarget, {
      lockfilePath: writeLockPath,
      stale: 10_000,
      update: 5_000,
      retries: 0,
    });
    await writeFile(readyPath, "ready\\n");
    while (true) {
      try { await access(releasePath); break; } catch {}
      await delay(10);
    }
    await release();
  `;
  const holder = runChild(holderScript, [autofileHome, writeLockPath, readyPath, releasePath]);
  for (let attempt = 0; !await pathExists(readyPath); attempt += 1) {
    if (attempt === 500) assert.fail("lock holder did not become ready");
    await delay(10);
  }

  let writeSettled = false;
  const write = store.createRecord({
    type: "tasks",
    key: "waited",
    record: { title: "Waited for the lock", status: "active" },
  }).finally(() => {
    writeSettled = true;
  });
  await delay(150);
  try {
    assert.equal(writeSettled, false);
  } finally {
    await writeFile(releasePath, "release\n");
  }
  await holder;
  assert.deepEqual(await write, { uri: "autofile:///tasks/waited" });
});

test("a write fails promptly when the lock path is unusable", async () => {
  const { dataFolder, root } = await makeStore();
  const writeLockPath = join(root, "autofile-home", "write.lock");
  const storeModule = pathToFileURL(resolve("dist/store.js")).href;
  const childScript = `
    import { rm, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    import { openStore } from ${JSON.stringify(storeModule)};
    const [dataFolder, writeLockPath] = process.argv.slice(1);
    const childStore = await openStore({ dataFolder, writeLockPath });
    const lockParent = dirname(writeLockPath);
    await rm(lockParent, { recursive: true });
    await writeFile(lockParent, "not a directory\\n");
    try {
      await childStore.createType({
        type: "cannot-lock",
        description: "This write must fail.",
        schema: { type: "object" },
      });
      throw new Error("write unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTDIR") throw error;
    }
  `;

  await runChild(childScript, [dataFolder, writeLockPath], 2_000);
});

test("a write takes over a lock left stale for more than ten seconds", async () => {
  const { root, store } = await makeStore();
  await createTasksType(store);
  const writeLockPath = join(root, "autofile-home", "write.lock");
  await mkdir(writeLockPath);
  const oldTime = new Date(Date.now() - 20_000);
  await utimes(writeLockPath, oldTime, oldTime);

  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("the stale write lock was not taken over")), 2_000);
  });
  let result;
  try {
    result = await Promise.race([
      store.createRecord({
        type: "tasks",
        key: "after-stale-lock",
        record: { title: "Recovered", status: "active" },
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(result, { uri: "autofile:///tasks/after-stale-lock" });
  assert.equal(await pathExists(writeLockPath), false);
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function allPathsExist(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(pathExists))).every(Boolean);
}

function decodeTid(tid: string): bigint {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const character of tid) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1);
    value = (value << 5n) | BigInt(digit);
  }
  return value;
}

function encodeTid(input: bigint): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let value = input;
  let tid = "";
  for (let index = 0; index < 13; index += 1) {
    tid = `${alphabet[Number(value & 31n)]}${tid}`;
    value >>= 5n;
  }
  return tid;
}
