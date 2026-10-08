/** Exercises the store through its public JSON operations and real filesystem. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    `${JSON.stringify({ description: "Things to do.", titleField: "title", schema: taskSchema }, null, 2)}\n`,
  );
  assert.deepEqual(await store.getType({ type: "tasks" }), {
    uri: "autofile:///_types/tasks",
    description: "Things to do.",
    titleField: "title",
    schema: taskSchema,
  });
  assert.deepEqual(await store.listTypes({}), {
    types: [
      { uri: "autofile:///_types/contacts", type: "contacts", description: "People." },
      { uri: "autofile:///_types/tasks", type: "tasks", description: "Things to do." },
    ],
  });

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
    description: 42 as unknown as string,
  }), { errors: [{ message: "description: must be a string" }] });
  assert.deepEqual(await store.updateType({
    type: "tasks",
    schema: [] as unknown as JsonObject,
  }), { errors: [{ message: "schema: must be a JSON object" }] });
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

test("blob format accepts only lowercase Autofile blob URIs in stage 2", async () => {
  const { store } = await makeStore();
  await store.createType({
    type: "documents",
    description: "Documents.",
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { format: "blob" } },
    },
  });
  const hash = "a".repeat(64);
  for (const [key, file] of [["no-extension", `autofile:///_blobs/${hash}`], ["pdf", `autofile:///_blobs/${hash}.pdf`]]) {
    assert.deepEqual(await store.createRecord({ type: "documents", key, record: { file } }), {
      uri: `autofile:///documents/${key}`,
    });
  }
  const invalidBlobs: Array<[string, JsonValue]> = [
    ["path", "/tmp/file.pdf"],
    ["data", "data:application/pdf;base64,AA=="],
    ["short", "autofile:///_blobs/abcd.pdf"],
    ["uppercase", `autofile:///_blobs/${hash.toUpperCase()}.PDF`],
    ["number", 42],
  ];
  for (const [key, file] of invalidBlobs) {
    assert.match(errorMessages(await store.createRecord({ type: "documents", key, record: { file } }))[0] ?? "", /file/u);
  }
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
  });
  assert.ok("records" in result);
  assert.deepEqual(result.records.map(({ uri, value }) => ({ uri, value })), [{
    uri: "autofile:///tasks/matching",
    value: { title: "Needle", status: "complete" },
  }]);
  assert.deepEqual(result.errors.map(({ uri }) => uri), [
    "autofile:///tasks/invalid-matching",
    "autofile:///tasks/unreadable",
  ]);
  assert.match(result.errors[0]?.message ?? "", /unexpected|additional/u);
  assert.match(result.errors[1]?.message ?? "", /JSON/u);
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
    writeFile(join(dataFolder, "tasks", "b.json"), "{\n"),
    writeFile(join(dataFolder, "tasks", "a.json"), storedRecord("A")),
  ]);

  const first = await store.findRecords({ type: "tasks", limit: 2 });
  assert.ok("records" in first && first.cursor !== undefined);
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///tasks/a"]);
  assert.deepEqual(first.errors, [{
    uri: "autofile:///tasks/b",
    message: "record file cannot be read as JSON",
  }]);

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
        message: "uri: must be a record URI, such as autofile:///tasks/book-the-dentist",
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
      details: { owner: "Rupert", remove: true },
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
    details: { owner: "Rupert", note: "done" },
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
  const madeFifo = await new Promise<boolean>((resolveFifo, rejectFifo) => {
    const child = spawn("mkfifo", [fifoPath], { stdio: "ignore" });
    child.once("error", (error) => {
      if ("code" in error && error.code === "ENOENT") resolveFifo(false);
      else rejectFifo(error);
    });
    child.once("close", (code) => resolveFifo(code === 0));
  });
  if (!madeFifo) {
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
  for (const uri of [
    "autofile:///tasks/malformed",
    "autofile:///tasks/invalid",
    "autofile:///tasks/Upper",
    "autofile:///tasks/note.txt",
    "autofile:///tasks/nested",
    "autofile:///_types/malformed",
    "autofile:///_types/invalid",
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
