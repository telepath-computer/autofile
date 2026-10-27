/** Rejects lossy JavaScript values through the public library before writing. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Autofile, AutofileError, type JsonObject } from "@telepath-computer/autofile";

const roots: string[] = [];
const stores: Autofile[] = [];

async function fixture(): Promise<{ root: string; store: Autofile }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-json-input-"));
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

function isJsonRefusal(error: unknown): boolean {
  assert.ok(error instanceof AutofileError);
  assert.match(error.message, /JSON/u);
  assert.ok(error.problems.every(({ message }) => message.length > 0));
  return true;
}

after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("numeric schemas cannot persist NaN, infinities, or negative zero as changed JSON values", async () => {
  const { root, store } = await fixture();
  await store.types.create("numbers", {
    description: "Numeric measurements.",
    schema: { type: "object", required: ["reading"], properties: { reading: { type: "number" } } },
  });
  const record = await store.records.create("numbers", { reading: 12 }, { key: "kept" });
  const path = join(root, "data", "numbers", "kept.json");
  const previous = await readFile(path, "utf8");
  for (const reading of [NaN, Infinity, -Infinity, -0]) {
    await assert.rejects(store.records.create("numbers", { reading }, { key: "refused" }), isJsonRefusal);
    await assert.rejects(store.records.update(record.uri, { reading }), isJsonRefusal);
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await readdir(join(root, "data", "numbers")), ["kept.json"]);
    assert.deepEqual(await store.records.get(record.uri), record);
  }
});

test("updates refuse nonfinite values retained from external JSON without rewriting the record", async () => {
  const { root, store } = await fixture();
  await store.types.create("numbers", {
    description: "Numeric measurements.",
    schema: { type: "object", properties: { reading: { type: "number" }, note: { type: "string" } } },
  });
  const record = await store.records.create("numbers", { reading: 12 }, { key: "external" });
  const path = join(root, "data", "numbers", "external.json");
  const original = await readFile(path, "utf8");
  for (const literal of ["1e400", "-1e400", "-0"]) {
    const external = original.replace('"reading": 12', `"reading": ${literal}`);
    assert.notEqual(external, original);
    await writeFile(path, external);
    await assert.rejects(store.records.update(record.uri, { note: "Changed" }), isJsonRefusal);
    assert.equal(await readFile(path, "utf8"), external);
  }
  const repaired = await store.records.update(record.uri, { reading: 42, note: "Repaired" });
  assert.deepEqual(repaired.value, { reading: 42, note: "Repaired" });
});

const invalidInputs: Array<[string, () => unknown]> = [
  ["root undefined", () => undefined],
  ["root null", () => null],
  ["root scalar", () => "not an object"],
  ["root array", () => []],
  ["nested NaN", () => ({ nested: [{ reading: NaN }] })],
  ["nested positive infinity", () => ({ nested: { reading: Infinity } })],
  ["nested negative infinity", () => ({ nested: [-Infinity] })],
  ["nested negative zero", () => ({ nested: [-0] })],
  ["undefined object property", () => ({ nested: { lost: undefined } })],
  ["undefined array element", () => ({ nested: [undefined] })],
  ["function property", () => ({ nested: { lost() {} } })],
  ["function array element", () => ({ nested: [() => 1] })],
  ["symbol property value", () => ({ nested: Symbol("lost") })],
  ["symbol array element", () => ({ nested: [Symbol("lost")] })],
  ["bigint", () => ({ nested: { reading: 1n } })],
  ["sparse array", () => ({ nested: new Array(2) })],
  ["array with extra property", () => ({ nested: Object.assign([1], { lost: true }) })],
  ["array with non-index numeric key", () => ({ nested: Object.assign([1], { "01": true }) })],
  ["sparse array with an extra property", () => ({ nested: Object.assign(new Array(1), { lost: true }) })],
  ["array with nonenumerable property", () => ({ nested: Object.defineProperty([1], "lost", { value: true }) })],
  ["array with custom prototype", () => ({ nested: Object.setPrototypeOf([1], Object.create(Array.prototype)) })],
  ["array with symbol property", () => ({ nested: Object.assign([1], { [Symbol("lost")]: true }) })],
  ["date", () => ({ nested: new Date("2026-01-01T00:00:00Z") })],
  ["map", () => ({ nested: new Map([["lost", true]]) })],
  ["set", () => ({ nested: new Set([true]) })],
  ["typed array", () => ({ nested: new Uint8Array([1, 2]) })],
  ["boxed primitive", () => ({ nested: Object(12) })],
  ["class instance", () => ({ nested: new (class { reading = 12; })() })],
  ["custom object prototype", () => ({ nested: Object.assign(Object.create({ lost: true }), { reading: 12 }) })],
  ["proxy with altered property reads", () => ({ nested: new Proxy({ reading: 12 }, { get: () => NaN }) })],
  ["revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }],
  ["nonenumerable property", () => ({ nested: Object.defineProperty({}, "lost", { value: true }) })],
  ["symbol own property", () => ({ nested: { [Symbol("lost")]: true } })],
  ["object cycle", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
  ["array cycle", () => { const value: unknown[] = []; value.push(value); return { nested: value }; }],
];

test("create and update refuse every lossy input without changing record files", async (t) => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Plain data.", schema: { type: "object" } });
  const record = await store.records.create("notes", { name: "Kept", nested: { reading: 12 } }, { key: "kept" });
  const path = join(root, "data", "notes", "kept.json");
  const previous = await readFile(path, "utf8");
  for (const [index, [name, input]] of invalidInputs.entries()) {
    await t.test(name, async () => {
      await assert.rejects(store.records.create("notes", input() as JsonObject, { key: `refused-${index}` }), isJsonRefusal);
      await assert.rejects(store.records.update(record.uri, input() as JsonObject), isJsonRefusal);
      assert.equal(await readFile(path, "utf8"), previous);
      assert.deepEqual(await readdir(join(root, "data", "notes")), ["kept.json"]);
      assert.deepEqual(await store.records.get(record.uri), record);
    });
  }
});

test("input rejection never calls getters or toJSON and precedes storage initialization", async () => {
  const { root, store } = await fixture();
  let calls = 0;
  const run = (): never => { calls += 1; throw new Error("Input code must not run"); };
  for (const value of [
    { nested: { toJSON: run } },
    { nested: Object.defineProperty({}, "reading", { enumerable: true, get: run }) },
    { nested: Object.defineProperty([1], "0", { enumerable: true, get: run }) },
    { nested: Object.defineProperty({}, "toJSON", { get: run }) },
  ]) {
    await assert.rejects(store.records.create("notes", value as JsonObject), isJsonRefusal);
    await assert.rejects(store.records.update("autofile:///notes/missing", value as JsonObject), isJsonRefusal);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("raw JSON fragments cannot bypass ordinary JSON object serialization", async (t) => {
  const json = JSON as JSON & { rawJSON?: (text: string) => unknown };
  if (json.rawJSON === undefined) return t.skip("Raw JSON fragments are unavailable in this runtime");
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Plain data.", schema: { type: "object" } });
  const record = await store.records.create("notes", { reading: 12 }, { key: "kept" });
  const path = join(root, "data", "notes", "kept.json");
  const previous = await readFile(path, "utf8");
  const value = { nested: json.rawJSON("123") } as JsonObject;
  await assert.rejects(store.records.create("notes", value, { key: "refused" }), isJsonRefusal);
  await assert.rejects(store.records.update(record.uri, value), isJsonRefusal);
  assert.equal(await readFile(path, "utf8"), previous);
  assert.deepEqual(await readdir(join(root, "data", "notes")), ["kept.json"]);
});

test("record writes snapshot validated input before callers can mutate it during I/O", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Plain data.", schema: { type: "object" } });
  const value = { nested: { reading: 1 } };
  const creating = store.records.create("notes", value, { key: "snapshot" });
  value.nested.reading = NaN;
  const record = await creating;
  assert.deepEqual(record.value, { nested: { reading: 1 } });
  assert.deepEqual((await store.records.get(record.uri))?.value, record.value);

  const patch = { nested: { reading: 2 } };
  const updating = store.records.update(record.uri, patch);
  let getterCalls = 0;
  Object.defineProperty(patch.nested, "reading", { get: () => { getterCalls += 1; return Infinity; } });
  const updated = await updating;
  assert.equal(getterCalls, 0);
  assert.deepEqual(updated.value, { nested: { reading: 2 } });
  assert.deepEqual((await store.records.get(record.uri))?.value, updated.value);
});

test("record writes preserve shared JSON values containing attachment addresses", async (t) => {
  const { store } = await fixture();
  await store.types.create("documents", {
    description: "An attachment and ordinary text.",
    schema: {
      type: "object",
      properties: {
        first: { type: "object", properties: { scan: { type: "string", format: "blob" } } },
        second: { type: "object", properties: { scan: { type: "string" } } },
      },
    },
  });
  const attachment = await store.blobs.put(Buffer.from("%PDF-1.4\n"), "application/pdf");
  for (const operation of ["create", "update"] as const) {
    await t.test(operation, async () => {
      const shared = { scan: attachment };
      const value = { first: shared, second: shared };
      const result = operation === "create"
        ? await store.records.create("documents", value, { key: "created" })
        : await store.records.update((await store.records.create("documents", {}, { key: "updated" })).uri, value);
      const first = result.value.first as JsonObject;
      assert.match(String(first.scan), /^autofile:\/\/\/_blobs\//u);
      assert.deepEqual(result.value.second, { scan: attachment });
      assert.deepEqual(value, { first: { scan: attachment }, second: { scan: attachment } });
      assert.equal(value.first, value.second);
      assert.deepEqual((await store.records.get(result.uri))?.value, result.value);
    });
  }
});

test("plain objects, dense arrays, shared references, and finite numbers retain their JSON values", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Plain data.", schema: { type: "object" } });
  const shared = Object.freeze({ reading: 0, text: "Hello", active: false, absent: null });
  const value = {
    nested: [shared, shared, [], {}, Number.MIN_VALUE, Number.MAX_VALUE, 1.25],
    dictionary: Object.assign(Object.create(null), { reading: 12 }),
  };
  const expected = JSON.parse(JSON.stringify(value));
  const record = await store.records.create("notes", value, { key: "valid" });
  assert.deepEqual(record.value, expected);
  assert.deepEqual((await store.records.get(record.uri))?.value, expected);
  const updated = await store.records.update(record.uri, { nested: [shared, true, null, ""] });
  assert.deepEqual(updated.value, { ...expected, nested: [shared, true, null, ""] });
});
