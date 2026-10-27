/** Exercises the published library interface against real files and watchers. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  Autofile,
  AutofileError,
  type AutofileRecord,
  type ChangeEvent,
  type JsonObject,
  type RecordQuery,
} from "@telepath-computer/autofile";

const roots: string[] = [];
const stores: Autofile[] = [];
const taskDefinition = {
  description: "Things to do.",
  titleField: "name",
  schema: {
    type: "object",
    required: ["name", "status"],
    properties: {
      name: { type: "string" },
      status: { type: "string" },
      details: { type: "object" },
      labels: { type: "array" },
    },
    additionalProperties: false,
  },
};

async function fixture(): Promise<{ root: string; store: Autofile }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-library-"));
  roots.push(root);
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "autofile-home");
  try {
    const store = new Autofile({ folder: join(root, "data") });
    stores.push(store);
    return { root, store };
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
}

function isRefusal(error: unknown): boolean {
  assert.ok(error instanceof AutofileError);
  assert.equal(error.name, "AutofileError");
  assert.ok(error.problems.length > 0);
  assert.ok(error.problems.every(({ message }) => typeof message === "string"));
  return true;
}

async function waitForChange(changes: ChangeEvent[], uri: string, kind: ChangeEvent["kind"]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!changes.some((change) => change.uri === uri && change.kind === kind)) {
    if (Date.now() >= deadline) assert.fail(`Missing ${kind} for ${uri}: ${JSON.stringify(changes)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("the package imports without starting a process service or creating folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofile-import-"));
  roots.push(root);
  const script = `
    import assert from "node:assert/strict";
    const library = await import("@telepath-computer/autofile");
    assert.deepEqual(Object.keys(library).sort(), ["Autofile", "AutofileError"]);
    new library.Autofile({ folder: process.argv[1] });
  `;
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, join(root, "data")], {
      cwd: resolve("."),
      env: { ...process.env, HOME: root, AUTOFILE_HOME: join(root, "autofile-home") },
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectChild(new Error("Importing or constructing Autofile left a process service running"));
    }, 5_000);
    child.once("error", rejectChild);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveChild();
      else rejectChild(new Error(`Library import exited with ${String(code)}`));
    });
  });
  assert.deepEqual(await readdir(root), []);
});

test("construction does no I/O and concurrent first calls wait for folder setup", async () => {
  const { root, store } = await fixture();
  assert.equal("dataFolder" in store, false);
  assert.equal(Object.getOwnPropertySymbols(store).length, 0);
  await assert.rejects(stat(join(root, "data")), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);

  const [types, records, missingBlob] = await Promise.all([
    store.types.list(),
    store.records.find(),
    store.blobs.get(`autofile:///_blobs/${"a".repeat(64)}.txt`),
  ]);
  assert.deepEqual(types, []);
  assert.deepEqual(records, { records: [], unreadable: [] });
  assert.equal(missingBlob, undefined);
  assert.equal((await stat(join(root, "data"))).isDirectory(), true);
});

test("types and records complete their lifecycle through the exported class", async () => {
  const { root, store } = await fixture();
  const declaration = await store.types.create("tasks", taskDefinition);
  assert.deepEqual(declaration, {
    uri: "autofile:///_types/tasks", type: "tasks", ...taskDefinition,
  });
  assert.deepEqual(await store.types.get("tasks"), declaration);
  assert.deepEqual(await store.types.list(), [declaration]);

  const created: AutofileRecord = await store.records.create("tasks", {
    name: "Book dentist", status: "active", details: { owner: "Alex", remove: true }, labels: ["old"],
  }, { key: "book-dentist" });
  assert.deepEqual(created, {
    uri: "autofile:///tasks/book-dentist",
    type: "tasks",
    key: "book-dentist",
    title: "Book dentist",
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    value: { name: "Book dentist", status: "active", details: { owner: "Alex", remove: true }, labels: ["old"] },
  });
  assert.deepEqual(await store.records.get(created.uri), created);
  assert.deepEqual(JSON.parse(await readFile(join(join(root, "data"), "tasks", "book-dentist.json"), "utf8")), {
    createdAt: created.createdAt, updatedAt: created.updatedAt, value: created.value,
  });

  const updated = await store.records.update(created.uri, {
    name: "Dentist booked", status: "complete", details: { remove: null, note: "done" }, labels: ["new"],
  });
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.title, "Dentist booked");
  assert.deepEqual(updated.value, {
    name: "Dentist booked", status: "complete", details: { owner: "Alex", note: "done" }, labels: ["new"],
  });
  const changedType = await store.types.update("tasks", { description: "Tasks to keep.", titleField: null });
  assert.equal(changedType.description, "Tasks to keep.");
  assert.equal("titleField" in changedType, false);
  assert.equal("title" in (await store.records.get(created.uri))!, false);

  assert.equal(await store.records.delete(created.uri), undefined);
  assert.equal(await store.records.get(created.uri), undefined);
  assert.equal(await store.types.delete("tasks"), undefined);
  assert.equal(await store.types.get("tasks"), undefined);
});

test("titles come from the complete value even when selected fields omit the title", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" }, titleField: "name" });
  await store.records.create("notes", { name: "A title", body: "Search needle", title: "Unrelated field" }, { key: "one" });
  await store.records.create("notes", { name: 42 }, { key: "two" });
  const found = await store.records.find({ q: "needle", fields: ["body"] });
  assert.equal(found.records[0]?.title, "A title");
  assert.deepEqual(found.records[0]?.value, { body: "Search needle" });
  assert.equal("title" in (await store.records.get("autofile:///notes/two"))!, false);
});

test("find supports all types, multiple types, value filters, and URI-ordered paging", async () => {
  const { root, store } = await fixture();
  for (const type of ["tasks", "projects", "notes"]) {
    await store.types.create(type, { description: `${type}.`, schema: { type: "object" } });
  }
  await store.records.create("tasks", { name: "Needle task", status: "active", type: "value-type" }, { key: "a" });
  await store.records.create("projects", { name: "Needle project", status: "active", type: "value-type" }, { key: "z" });
  await store.records.create("projects", { name: "Finished project", status: "complete" }, { key: "a" });
  await store.records.create("notes", { name: "A note" }, { key: "a" });
  assert.deepEqual((await store.records.find()).records.map(({ uri }) => uri), [
    "autofile:///notes/a", "autofile:///projects/a", "autofile:///projects/z", "autofile:///tasks/a",
  ]);
  const query: RecordQuery = {
    type: ["tasks", "projects", "tasks"], q: "needle", where: { type: "value-type", status: "active" }, limit: 1,
  };
  const first = await store.records.find(query);
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///projects/z"]);
  assert.ok(first.cursor);
  await store.records.delete(first.records[0]!.uri);
  const second = await store.records.find({ ...query, cursor: first.cursor });
  assert.deepEqual(second.records.map(({ uri }) => uri), ["autofile:///tasks/a"]);
  assert.equal(second.cursor, undefined);
  assert.deepEqual((await store.records.find({ where: { status: null } })).records.map(({ uri }) => uri), ["autofile:///notes/a"]);
  assert.deepEqual(await store.records.find({ type: [] }), { records: [], unreadable: [] });
});

test("refusals throw AutofileError and leave existing files unchanged", async () => {
  const { root, store } = await fixture();
  await store.types.create("tasks", taskDefinition);
  const record = await store.records.create("tasks", { name: "Kept", status: "active" }, { key: "kept" });
  await assert.rejects(store.records.create("tasks", { name: "Missing status" }), isRefusal);
  await assert.rejects(store.records.update(record.uri, { name: null }), (error: unknown) => {
    assert.ok(error instanceof AutofileError);
    assert.equal(error.problems[0]?.uri, record.uri);
    return true;
  });
  assert.deepEqual(await store.records.get(record.uri), record);
  await assert.rejects(store.records.create("tasks", record.value, { key: "kept" }), isRefusal);
  await assert.rejects(store.records.update("autofile:///tasks/missing", {}), isRefusal);
  await assert.rejects(store.records.delete("autofile:///tasks/missing"), isRefusal);
  await assert.rejects(store.types.delete("tasks"), isRefusal);
  await assert.rejects(store.types.create("Tasks", taskDefinition), isRefusal);
  await assert.rejects(store.records.find({ where: { status: { $in: ["active"] } } }), isRefusal);
});

test("library methods refuse non-string names, keys and record addresses without coercion", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const record = await store.records.create("notes", {}, { key: "kept" });
  for (const input of [null, 42, false, Symbol("name"), ["notes"], { toString: () => "notes" }]) {
    for (const [method, args] of [
      [store.types.create, [input, { description: "Invalid.", schema: { type: "object" } }]],
      [store.types.get, [input]],
      [store.types.update, [input, {}]],
      [store.types.delete, [input]],
      [store.records.create, [input, {}]],
      [store.records.create, ["notes", {}, { key: input }]],
    ] as const) {
      await assert.rejects(() => Reflect.apply(method, undefined, args), isRefusal);
    }
  }
  for (const uri of [[record.uri], { toString: () => record.uri }, Symbol("uri")]) {
    for (const [method, args] of [
      [store.records.get, [uri]],
      [store.records.update, [uri, {}]],
      [store.records.delete, [uri]],
    ] as const) {
      await assert.rejects(() => Reflect.apply(method, undefined, args), isRefusal);
    }
  }
  assert.deepEqual(await store.records.get(record.uri), record);
  assert.deepEqual((await store.types.list()).map(({ type }) => type), ["notes"]);
});

test("library methods refuse malformed argument objects with AutofileError", async () => {
  const { store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  for (const input of [null, [], 42, false, "notes"]) {
    for (const [method, args] of [
      [store.records.find, [input]],
      [store.records.create, ["notes", {}, input]],
      [store.types.create, ["invalid", input]],
      [store.types.update, ["notes", input]],
    ] as const) {
      await assert.rejects(() => Reflect.apply(method, undefined, args), isRefusal);
    }
  }
  assert.deepEqual((await store.records.find()).records, []);
  assert.deepEqual((await store.types.list()).map(({ type }) => type), ["notes"]);
});

test("cross-type pages order complete URIs when one type name prefixes another", async () => {
  const { root, store } = await fixture();
  for (const type of ["project", "project-notes"]) {
    await store.types.create(type, { description: `${type}.`, schema: { type: "object" } });
    await store.records.create(type, {}, { key: "one" });
  }
  const first = await store.records.find({ limit: 1 });
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///project-notes/one"]);
  assert.ok(first.cursor);
  const second = await store.records.find({ limit: 1, cursor: first.cursor });
  assert.deepEqual(second.records.map(({ uri }) => uri), ["autofile:///project/one"]);
  assert.equal(second.cursor, undefined);
});

test("find reports unreadable and matching invalid records without losing readable results", async () => {
  const { root, store } = await fixture();
  await store.types.create("tasks", taskDefinition);
  const valid = await store.records.create("tasks", { name: "Needle valid", status: "active" }, { key: "valid" });
  const invalid = await store.records.create("tasks", { name: "Needle invalid", status: "old" }, { key: "invalid" });
  const changed = await store.types.update("tasks", {
    schema: { ...taskDefinition.schema, properties: { ...taskDefinition.schema.properties, status: { const: "active" } } },
  });
  assert.ok(changed.problems?.some(({ uri, message }) => uri === invalid.uri && message.includes("status")));
  assert.equal((await store.types.get("tasks"))?.problems, undefined);
  await writeFile(join(join(root, "data"), "tasks", "broken.json"), "{\n");
  const readInvalid = await store.records.get(invalid.uri);
  assert.ok(readInvalid?.problems?.some(({ uri, message }) => uri === invalid.uri && message.includes("status")));
  assert.deepEqual({ ...readInvalid, problems: undefined }, { ...invalid, problems: undefined });
  const result = await store.records.find({ q: "needle" });
  assert.deepEqual(result.records, [valid]);
  assert.deepEqual(result.unreadable.map(({ uri }) => uri), ["autofile:///tasks/broken", invalid.uri]);
  assert.match(result.unreadable[0]?.message ?? "", /unavailable/u);
  assert.match(result.unreadable[1]?.message ?? "", /status/u);
  await assert.rejects(store.records.get("autofile:///tasks/broken"), isRefusal);
});

test("blobs are explicitly uploaded and record fields accept existing addresses", async () => {
  const { root, store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.",
    schema: { type: "object", required: ["attachment"], properties: { attachment: { type: "string", format: "blob" } } },
  });
  const path = join(root, "local.txt");
  await writeFile(path, "local file");
  const obsoleteOptions = { key: "blocked", allowLocalPaths: true };
  await assert.rejects(store.records.create("documents", { attachment: path }, obsoleteOptions), isRefusal);
  assert.equal(await store.records.get("autofile:///documents/blocked"), undefined);
  const keptUri = await store.blobs.put(Buffer.from("kept"), "text/plain");
  const kept = await store.records.create("documents", { attachment: keptUri });
  const bytes = Buffer.from("uploaded attachment");
  const uploaded = await store.blobs.put(bytes, "text/plain");
  const record = await store.records.create("documents", { attachment: uploaded });
  const uri = String(record.value.attachment);
  const blob = await store.blobs.get(uri);
  assert.ok(blob);
  assert.equal(blob.mimeType, "text/plain");
  assert.deepEqual(Buffer.from(blob.bytes), bytes);
  await assert.rejects(store.records.update(record.uri, { attachment: path }), isRefusal);
  await assert.rejects(store.records.create("documents", { attachment: "data:text/plain;base64,a2VwdA==" }), isRefusal);
  const updated = await store.records.update(record.uri, { attachment: keptUri });
  assert.equal(updated.value.attachment, kept.value.attachment);
  assert.equal(await store.blobs.get(uri), undefined);
  await store.records.delete(kept.uri);
  assert.ok(await store.blobs.get(String(updated.value.attachment)));
  await store.records.delete(record.uri);
  assert.equal(await store.blobs.get(String(updated.value.attachment)), undefined);
});

test("prepareSchema validates without a folder and leaves link existence to writes", async () => {
  const schema: JsonObject = {
    type: "object", required: ["target"], properties: { target: { type: "string", format: "uri" } },
  };
  const prepared = await Autofile.prepareSchema(schema);
  assert.deepEqual(await prepared.validate({ target: "autofile:///notes/missing" }), []);
  assert.ok((await prepared.validate({})).some((message) => message.includes("target")));
  await assert.rejects(Autofile.prepareSchema({ $ref: "https://example.com/schema" }), isRefusal);
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Linked notes.", schema });
  await assert.rejects(store.records.create("notes", { target: "autofile:///notes/missing" }), isRefusal);
});

test("watch shares ready subscriptions, observes other writers, and stops each caller independently", { timeout: 30_000 }, async () => {
  const { root, store } = await fixture();
  await store.types.create("tasks", taskDefinition);
  const first: ChangeEvent[] = [];
  const second: ChangeEvent[] = [];
  const [stopFirst, stopSecond] = await Promise.all([
    store.watch((changes) => { first.push(...changes); }),
    store.watch(async (changes) => { second.push(...changes); }),
  ]);
  const record = await store.records.create("tasks", { name: "Watched", status: "active" }, { key: "watched" });
  await Promise.all([waitForChange(first, record.uri, "created"), waitForChange(second, record.uri, "created")]);
  await stopFirst();
  const checkpoint = first.length;
  await writeFile(join(join(root, "data"), "tasks", "watched.json"), `${JSON.stringify({
    createdAt: record.createdAt, updatedAt: new Date().toISOString(), value: { name: "Outside edit", status: "complete" },
  })}\n`);
  await waitForChange(second, record.uri, "changed");
  assert.equal(first.length, checkpoint);
  assert.deepEqual(Object.keys(second[0]!).sort(), ["kind", "uri"]);
  await stopSecond();
  await stopSecond();
});

test("close is idempotent and prevents every further instance operation", async () => {
  const { root, store } = await fixture();
  await store.close();
  await store.close();
  const actions = [
    () => store.records.find(),
    () => store.records.get("autofile:///tasks/missing"),
    () => store.records.create("tasks", {}),
    () => store.records.update("autofile:///tasks/missing", {}),
    () => store.records.delete("autofile:///tasks/missing"),
    () => store.types.list(),
    () => store.types.get("tasks"),
    () => store.types.create("tasks", taskDefinition),
    () => store.types.update("tasks", { description: "Closed" }),
    () => store.types.delete("tasks"),
    () => store.blobs.put(Buffer.from("closed"), "text/plain"),
    () => store.blobs.get(`autofile:///_blobs/${"a".repeat(64)}.txt`),
    () => store.watch(() => {}),
  ];
  for (const action of actions) await assert.rejects(async () => action(), /closed/iu);
  await assert.rejects(stat(join(root, "data")), { code: "ENOENT" });
});

test("close stops an active watcher and its subscription can still be stopped", async () => {
  const { root, store } = await fixture();
  const changes: ChangeEvent[] = [];
  const stop = await store.watch((batch) => { changes.push(...batch); });
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  await waitForChange(changes, "autofile:///_types/notes", "created");
  await store.close();
  const checkpoint = changes.length;
  await writeFile(join(join(root, "data"), "_types", "notes.json"), JSON.stringify({
    description: "Changed outside after closing.", schema: { type: "object" },
  }));
  await stop();
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  assert.equal(changes.length, checkpoint);
  await assert.rejects(store.watch(() => {}), /closed/iu);
});

test("a watch callback can await close without waiting for itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofile-watch-close-"));
  roots.push(root);
  const script = `
    import { Autofile } from "@telepath-computer/autofile";
    const store = new Autofile({ folder: process.argv[1] });
    let finished;
    const closed = new Promise((resolve) => { finished = resolve; });
    await store.watch(async () => {
      await store.close();
      finished();
    });
    await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
    await closed;
  `;
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, join(root, "data")], {
      cwd: resolve("."),
      env: { ...process.env, AUTOFILE_HOME: join(root, "home") },
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectChild(new Error("close deadlocked inside a watch callback"));
    }, 5_000);
    child.once("error", rejectChild);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveChild();
      else rejectChild(new Error(`Closing inside a watch callback exited with ${String(code)}`));
    });
  });
});


for (const [label, name, contents] of [
  ["an unreadable record", "broken.json", "{\n"],
  ["unrelated stored data", "ignored.txt", "not a record"],
] as const) {
  test(`type deletion refuses ${label} and preserves its declaration`, async () => {
    const { root, store } = await fixture();
    const declaration = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
    const path = join(root, "data", "notes", name);
    await writeFile(path, contents);

    await assert.rejects(store.types.delete("notes"), (error: unknown) => {
      assert.ok(error instanceof AutofileError);
      assert.deepEqual(error.problems, [{ uri: declaration.uri, message: "type still has stored data" }]);
      return true;
    });
    assert.deepEqual(await store.types.get("notes"), declaration);
    assert.equal(await readFile(path, "utf8"), contents);
  });
}

test("type deletion removes an empty type cleanly", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  await store.types.delete("notes");
  assert.equal(await store.types.get("notes"), undefined);
  await assert.rejects(stat(join(root, "data", "notes")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "data", "_types", "notes.json")), { code: "ENOENT" });
});

test("type deletion refuses stored data replacing the type directory", async () => {
  const { root, store } = await fixture();
  const declaration = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  await rm(join(root, "data", "notes"), { recursive: true });
  await writeFile(join(root, "data", "notes"), "unrelated storage contents");
  await assert.rejects(store.types.delete("notes"), { name: "AutofileError", message: "type still has stored data" });
  assert.deepEqual(await store.types.get("notes"), declaration);
  assert.equal(await readFile(join(root, "data", "notes"), "utf8"), "unrelated storage contents");
});

test("watch reports callback failures through the subscription's public onError option", async () => {
  const { store } = await fixture();
  const error = new Error("consumer failed");
  const errors: Error[] = [];
  const otherErrors: Error[] = [];
  const changes: ChangeEvent[] = [];
  await store.watch(() => { throw error; }, { onError: (failure) => { errors.push(failure); } });
  await store.watch((batch) => { changes.push(...batch); }, { onError: (failure) => { otherErrors.push(failure); } });
  const declaration = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  await waitForChange(changes, declaration.uri, "created");
  assert.deepEqual(errors, [error]);
  assert.deepEqual(otherErrors, []);
});


test("watch ignores attachment contents and undeclared record locations", async () => {
  const { root, store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.",
    schema: { type: "object", properties: { attachment: { type: "string", format: "blob" } } },
  });
  const record = await store.records.create("documents", { attachment: await store.blobs.put(Buffer.from("hello"), "text/plain") }, { key: "held" });
  const changes: ChangeEvent[] = [];
  await store.watch((batch) => { changes.push(...batch); });
  const attachmentId = String(record.value.attachment).slice("autofile:///_blobs/".length);
  await writeFile(join(root, "data", "_blobs", attachmentId), "changed attachment");
  await writeFile(join(root, "data", "_blobs", `${"a".repeat(64)}.txt`), "unheld attachment");
  await mkdir(join(root, "data", "undeclared"));
  await writeFile(join(root, "data", "undeclared", "ignored.json"), JSON.stringify({
    createdAt: record.createdAt, updatedAt: record.updatedAt, value: {},
  }));
  const sentinel = await store.records.create("documents", {}, { key: "sentinel" });
  await waitForChange(changes, sentinel.uri, "created");
  assert.deepEqual(changes, [{ uri: sentinel.uri, kind: "created" }]);
});


test("storage failures do not expose paths or platform error codes", async () => {
  const { root } = await fixture();
  const storage = join(root, "private-storage-location");
  await writeFile(storage, "not a usable storage location");
  const store = new Autofile({ folder: storage });
  stores.push(store);
  await assert.rejects(store.types.list(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Storage operation failed");
    assert.equal("path" in error, false);
    assert.equal("code" in error, false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("an accepted type update publicly reports records that cannot be checked", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const record = await store.records.create("notes", { name: "Unavailable" }, { key: "unavailable" });
  const path = join(root, "data", "notes", "unavailable.json");
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === path) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES", path });
    return originalOpen(...args);
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  try {
    const declaration = await store.types.update("notes", { description: "Updated notes." });
    assert.deepEqual(declaration.problems, [{ uri: record.uri, message: "record is unavailable" }]);
    assert.equal((await store.types.get("notes"))?.description, "Updated notes.");
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});


test("invalid storage configuration is refused without exposing a storage mechanism", () => {
  assert.throws(() => Reflect.construct(Autofile, [{ folder: 42 }]), (error: unknown) => {
    assert.ok(error instanceof AutofileError);
    assert.deepEqual(error.problems, [{ message: "folder: must be a non-empty string" }]);
    return true;
  });
});


test("records can share, retain and reorder existing attachment addresses", async () => {
  const { store } = await fixture();
  await store.types.create("documents", {
    description: "Documents with attachments.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        primary: { type: "string", format: "blob" },
        attachments: { type: "array", items: { type: "string", format: "blob" } },
      },
    },
  });
  const source = await store.records.create("documents", {
    title: "Source", attachments: [await store.blobs.put(Buffer.from("first"), "text/plain"), await store.blobs.put(Buffer.from("second"), "text/plain")],
  }, { key: "source" });
  const [first, second] = source.value.attachments as string[];
  const other = await store.records.create("documents", { primary: await store.blobs.put(Buffer.from("other"), "text/plain") }, { key: "other" });
  const copied = await store.records.create("documents", { primary: first! }, { key: "copied" });
  assert.equal(copied.value.primary, first);
  assert.equal((await store.records.update(source.uri, { primary: other.value.primary! })).value.primary, other.value.primary);
  const retained = await store.records.update(source.uri, { title: "Retained" });
  assert.deepEqual(retained.value.attachments, [first, second]);
  const moved = await store.records.update(source.uri, { primary: first!, attachments: [second!, first!] });
  assert.equal(moved.value.primary, first);
  assert.deepEqual(moved.value.attachments, [second, first]);
  const duplicate = await store.records.create("documents", { primary: first! });
  assert.equal(duplicate.value.primary, first);
  await store.records.update(source.uri, { primary: null, attachments: [second!] });
  assert.equal((await store.records.update(source.uri, { primary: first! })).value.primary, first);
  assert.ok(await store.blobs.get(first!));
});

test("updates retain attachments while repairing an invalid record and still require their bytes", async () => {
  const { root, store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.",
    schema: { type: "object", properties: { attachment: { type: "string", format: "blob" }, title: { type: "string" } } },
  });
  const source = await store.records.create("documents", { attachment: await store.blobs.put(Buffer.from("hello"), "text/plain") });
  await store.types.update("documents", {
    schema: { type: "object", required: ["title"], properties: { attachment: { type: "string", format: "blob" }, title: { type: "string" } } },
  });
  const repaired = await store.records.update(source.uri, { title: "Fixed" });
  assert.equal(repaired.value.attachment, source.value.attachment);
  await rm(join(root, "data", "_blobs", String(source.value.attachment).slice("autofile:///_blobs/".length)));
  await assert.rejects(store.records.update(source.uri, { title: "Missing bytes" }), isRefusal);
  assert.deepEqual(await store.records.get(source.uri), repaired);
});

test("conditional blob fields can share an existing URI", async () => {
  const { store } = await fixture();
  await store.types.create("documents", {
    description: "Documents with a conditional attachment.",
    schema: {
      type: "object",
      properties: {
        trigger: { type: "string", format: "blob" },
        extra: { type: "string" },
      },
      allOf: [{
        if: { properties: { trigger: { pattern: "^autofile:///_blobs/" } } },
        then: { properties: { extra: { format: "blob" } } },
      }],
    },
  });
  const upload = await store.blobs.put(Buffer.from("hello"), "text/plain");
  const first = await store.records.create("documents", { trigger: upload });
  const second = await store.records.create("documents", { trigger: upload, extra: first.value.trigger! });
  assert.equal(second.value.extra, first.value.trigger);
});
