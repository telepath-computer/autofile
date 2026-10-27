/** Checks schema JSON and caller-owned inputs through the public package API. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Autofile, AutofileError, type JsonObject, type TypeChanges } from "@telepath-computer/autofile";

const roots: string[] = [];
const stores: Autofile[] = [];

async function fixture(): Promise<{ root: string; store: Autofile }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-schema-input-"));
  roots.push(root);
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "home");
  try {
    const store = new Autofile({ folder: join(root, "data") });
    stores.push(store);
    return { root, store };
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
}

function isSchemaRefusal(error: unknown): boolean {
  assert.ok(error instanceof AutofileError);
  assert.match(error.message, /^schema:/u);
  return true;
}

after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("type writes snapshot nested schemas, replacements, descriptions and titles before I/O", async () => {
  const { store } = await fixture();
  const definition = {
    description: "Original notes.", title: "Note", titleField: "name",
    schema: { type: "object", properties: { name: { type: "string" } } },
  };
  const creating = store.types.create("notes", definition);
  definition.schema.properties.name.type = "number";
  definition.schema = { type: "object", properties: { name: { type: "boolean" } } };
  definition.description = "Changed description.";
  definition.title = "Changed title";
  definition.titleField = "changed";
  const created = await creating;
  assert.deepEqual(created, {
    uri: "autofile:///_types/notes", type: "notes", description: "Original notes.", title: "Note", titleField: "name",
    schema: { type: "object", properties: { name: { type: "string" } } },
  });
  assert.deepEqual(await store.types.get("notes"), created);
  await store.records.create("notes", { name: "Original" }, { key: "created" });
  await assert.rejects(store.records.create("notes", { name: 1 }), AutofileError);

  const changes = {
    description: "Updated notes.", title: "Notebook entry", titleField: "title",
    schema: { type: "object", properties: { title: { type: "string" } } },
  };
  const updating = store.types.update("notes", changes);
  changes.schema.properties.title.type = "number";
  changes.schema = { type: "object", properties: { title: { type: "boolean" } } };
  changes.description = "Changed update.";
  changes.title = "Changed title";
  changes.titleField = "changed";
  const updated = await updating;
  assert.deepEqual(updated, {
    uri: "autofile:///_types/notes", type: "notes", description: "Updated notes.", title: "Notebook entry", titleField: "title",
    schema: { type: "object", properties: { title: { type: "string" } } },
  });
  assert.deepEqual(await store.types.get("notes"), updated);
  await store.records.create("notes", { title: "Updated" }, { key: "updated" });
  await assert.rejects(store.records.create("notes", { title: 1 }), AutofileError);
});

test("record creation captures the supplied key before I/O", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const options = { key: "original" };
  const creating = store.records.create("notes", {}, options);
  options.key = "changed";
  const created = await creating;
  assert.equal(created.key, "original");
  assert.deepEqual(await store.records.get("autofile:///notes/original"), created);
  assert.equal(await store.records.get("autofile:///notes/changed"), undefined);
});

test("prepareSchema preserves the original schema after immediate caller mutation", async () => {
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const preparing = Autofile.prepareSchema(schema);
  schema.properties.title.type = "number";
  const prepared = await preparing;
  assert.deepEqual(await prepared.validate({ title: "Original" }), []);
  assert.ok((await prepared.validate({ title: 1 })).length > 0);
});

const invalidSchemaValues: Array<[string, () => unknown]> = [
  ["NaN", () => NaN],
  ["positive infinity", () => Infinity],
  ["negative infinity", () => -Infinity],
  ["negative zero", () => -0],
  ["undefined", () => undefined],
  ["function", () => () => 1],
  ["symbol", () => Symbol("lost")],
  ["bigint", () => 1n],
  ["sparse array", () => new Array(1)],
  ["date", () => new Date("2026-01-01T00:00:00Z")],
  ["proxy", () => new Proxy({}, {})],
  ["circular reference", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
];

test("schema preparation and type writes reject lossy JSON before changing storage", async (t) => {
  const { root, store } = await fixture();
  const original = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const path = join(root, "data", "_types", "notes.json");
  const previous = await readFile(path, "utf8");
  for (const [index, [name, input]] of invalidSchemaValues.entries()) {
    await t.test(name, async () => {
      const schema = { type: "object", properties: { reading: { const: input() } } } as JsonObject;
      await assert.rejects(Autofile.prepareSchema(schema), isSchemaRefusal);
      await assert.rejects(store.types.create(`refused-${index}`, { description: "Refused.", schema }), isSchemaRefusal);
      await assert.rejects(store.types.update("notes", { description: "Refused.", schema }), isSchemaRefusal);
      assert.equal(await readFile(path, "utf8"), previous);
      assert.deepEqual(await readdir(join(root, "data", "_types")), ["notes.json"]);
      assert.deepEqual(await readdir(join(root, "data")), ["_types", "notes"]);
      assert.deepEqual(await store.types.get("notes"), original);
    });
  }
});

test("schema rejection never invokes getters or toJSON and precedes initialization", async () => {
  const { root, store } = await fixture();
  let calls = 0;
  const run = (): never => { calls += 1; throw new Error("Schema input code must not run"); };
  for (const schema of [
    { const: { toJSON: run } },
    { const: Object.defineProperty({}, "value", { enumerable: true, get: run }) },
    { const: Object.defineProperty({}, "toJSON", { get: run }) },
    { const: Object.defineProperty([1], "0", { enumerable: true, get: run }) },
  ]) {
    await assert.rejects(Autofile.prepareSchema(schema as JsonObject), isSchemaRefusal);
    await assert.rejects(store.types.create("notes", { description: "Notes.", schema: schema as JsonObject }), isSchemaRefusal);
    await assert.rejects(store.types.update("notes", { schema: schema as JsonObject }), isSchemaRefusal);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("metadata updates refuse lossy schemas retained from external JSON without rewriting the type", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", {
    description: "Notes.", schema: { type: "object", properties: { reading: { const: 12 } } },
  });
  const path = join(root, "data", "_types", "notes.json");
  const original = await readFile(path, "utf8");
  for (const literal of ["1e400", "-1e400", "-0"]) {
    const external = original.replace('"const": 12', `"const": ${literal}`);
    assert.notEqual(external, original);
    await writeFile(path, external);
    await assert.rejects(store.types.update("notes", { description: "Changed." }), isSchemaRefusal);
    assert.equal(await readFile(path, "utf8"), external);
  }
  const repaired = await store.types.update("notes", { schema: { type: "object" } });
  assert.deepEqual(repaired.schema, { type: "object" });
  assert.equal(repaired.description, "Notes.");
});

test("externally edited lossy schemas cannot validate record writes or appear as valid declarations", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", {
    description: "Notes.", schema: { type: "object", properties: { reading: { const: 12 } } },
  });
  const record = await store.records.create("notes", { reading: 12 }, { key: "kept" });
  const declarationPath = join(root, "data", "_types", "notes.json");
  const recordPath = join(root, "data", "notes", "kept.json");
  const originalDeclaration = await readFile(declarationPath, "utf8");
  const originalRecord = await readFile(recordPath, "utf8");
  for (const literal of ["1e400", "-1e400", "-0"]) {
    const external = originalDeclaration.replace('"const": 12', `"const": ${literal}`);
    await writeFile(declarationPath, external);
    await assert.rejects(store.types.get("notes"), isSchemaRefusal);
    assert.deepEqual(await store.types.list(), []);
    await assert.rejects(store.records.get(record.uri), isSchemaRefusal);
    const value = { reading: literal === "-0" ? 0 : null };
    await assert.rejects(store.records.create("notes", value, { key: "refused" }), isSchemaRefusal);
    await assert.rejects(store.records.update(record.uri, value), isSchemaRefusal);
    assert.equal(await readFile(declarationPath, "utf8"), external);
    assert.equal(await readFile(recordPath, "utf8"), originalRecord);
    assert.deepEqual(await readdir(join(root, "data", "notes")), ["kept.json"]);
  }
});

test("type snapshots preserve optional undefined metadata and partial update semantics", async () => {
  const { store } = await fixture();
  const original = await store.types.create("notes", {
    description: "Notes.", schema: { type: "object" }, title: undefined, titleField: undefined,
  });
  const changes: TypeChanges = { description: undefined, schema: undefined, title: undefined, titleField: undefined };
  const updating = store.types.update("notes", changes);
  changes.description = "Caller changed undefined.";
  changes.schema = { type: "object", required: ["changed"] };
  changes.titleField = "changed";
  changes.title = "Changed title";
  assert.deepEqual(await updating, original);
  await store.types.update("notes", { title: "Note", titleField: "name" });
  assert.equal((await store.types.update("notes", { title: undefined })).title, "Note");
  assert.equal((await store.types.update("notes", { titleField: undefined })).titleField, "name");
  assert.equal(Object.hasOwn(await store.types.update("notes", { titleField: null }), "titleField"), false);
  const removing: TypeChanges = { title: null };
  const updatingTitle = store.types.update("notes", removing);
  removing.title = "Changed removal";
  assert.equal(Object.hasOwn(await updatingTitle, "title"), false);
});

test("type title validation never invokes accessors or serialization hooks and precedes initialization", async () => {
  const { root, store } = await fixture();
  let calls = 0;
  const run = (): never => { calls += 1; throw new Error("Title input code must not run"); };
  for (const descriptor of [
    { enumerable: true, get: run },
    { enumerable: false, value: "Note" },
    { enumerable: true, value: { toJSON: run } },
    { enumerable: true, value: Object.defineProperty({}, "toJSON", { get: run }) },
  ]) {
    const definition = Object.defineProperty({ description: "Notes.", schema: { type: "object" } }, "title", descriptor);
    await assert.rejects(store.types.create("notes", definition), AutofileError);
    const changes = Object.defineProperty({}, "title", descriptor);
    await assert.rejects(store.types.update("notes", changes), AutofileError);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("malformed schema roots still produce clear schema refusals", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  for (const schema of [null, [], true, "schema", undefined]) {
    await assert.rejects(Autofile.prepareSchema(schema as unknown as JsonObject), { name: "AutofileError", message: "schema: must be a JSON object" });
    await assert.rejects(store.types.create("invalid", { description: "Invalid.", schema: schema as unknown as JsonObject }), { name: "AutofileError", message: "schema: must be a JSON object" });
    if (schema !== undefined) {
      await assert.rejects(store.types.update("notes", { schema: schema as unknown as JsonObject }), { name: "AutofileError", message: "schema: must be a JSON object" });
    }
  }
});
