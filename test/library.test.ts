/** Exercises the published library interface against real files and watchers. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsPromises, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  Autofile,
  AutofileError,
  type AutofileRecord,
  type BlobRange,
  type BlobStat,
  type ChangeEvent,
  type JsonObject,
  type RecordQuery,
  type TypeChanges,
  type TypeDeclaration,
  type TypeDefinition,
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
    store.blobs.get(`autofile:///blobs/${"a".repeat(64)}.txt`),
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
    uri: "autofile:///types/tasks", type: "tasks", ...taskDefinition,
  });
  assert.deepEqual(await store.types.get("tasks"), declaration);
  assert.deepEqual(await store.types.list(), [declaration]);

  const created: AutofileRecord = await store.records.create("tasks", {
    name: "Book dentist", status: "active", details: { owner: "Alex", remove: true }, labels: ["old"],
  }, { key: "book-dentist" });
  assert.deepEqual(created, {
    uri: "autofile:///records/tasks/book-dentist",
    type: "tasks",
    key: "book-dentist",
    title: "Book dentist",
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    value: { name: "Book dentist", status: "active", details: { owner: "Alex", remove: true }, labels: ["old"] },
  });
  assert.deepEqual(await store.records.get(created.uri), created);
  assert.deepEqual(JSON.parse(await readFile(join(join(root, "data"), "records", "tasks", "book-dentist.json"), "utf8")), {
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

test("type titles round-trip through the library and partial updates preserve, replace, and remove them", async () => {
  const { root, store } = await fixture();
  const definition: TypeDefinition = { description: "Journal entries.", title: "Journal entry", schema: { type: "object" } };
  const created: TypeDeclaration = await store.types.create("journal-entries", definition);
  assert.deepEqual(created, { uri: "autofile:///types/journal-entries", type: "journal-entries", ...definition });
  assert.deepEqual(await store.types.get("journal-entries"), created);
  const untitled = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  assert.equal(Object.hasOwn(untitled, "title"), false);
  assert.deepEqual(await store.types.list(), [created, untitled]);

  const preserved = await store.types.update("journal-entries", { description: "Dated entries." });
  assert.deepEqual(preserved, { ...created, description: "Dated entries." });
  const replaced = await store.types.update("journal-entries", { title: "Diary entry" });
  assert.deepEqual(replaced, { ...preserved, title: "Diary entry" });
  assert.deepEqual(await store.types.get("journal-entries"), replaced);
  assert.deepEqual(await store.types.list(), [replaced, untitled]);

  const changes: TypeChanges = { title: null };
  const removed = await store.types.update("journal-entries", changes);
  assert.deepEqual(removed, {
    uri: created.uri, type: "journal-entries", description: "Dated entries.", schema: definition.schema,
  });
  assert.deepEqual(await store.types.get("journal-entries"), removed);
  assert.deepEqual(await store.types.list(), [removed, untitled]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "data", "types", "journal-entries.json"), "utf8")), {
    description: "Dated entries.", schema: definition.schema,
  });
});

test("invalid type titles are refused without changing existing declarations", async () => {
  const { root, store } = await fixture();
  const original = await store.types.create("notes", { description: "Notes.", title: "Note", schema: { type: "object" } });
  const path = join(root, "data", "types", "notes.json");
  const previous = await readFile(path, "utf8");
  for (const [index, title] of ["", 42, false, {}, [], NaN, Infinity, -0, Symbol("title"), 1n, () => "Note"].entries()) {
    await assert.rejects(store.types.create(`invalid-${index}`, {
      description: "Invalid.", schema: { type: "object" }, title: title as string,
    }), { name: "AutofileError", message: "title: must be a non-empty string" });
    await assert.rejects(store.types.update("notes", { title: title as string }), {
      name: "AutofileError", message: "title: must be a non-empty string or null",
    });
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await store.types.get("notes"), original);
  }
  await assert.rejects(store.types.create("null-title", {
    description: "Invalid.", schema: { type: "object" }, title: null as unknown as string,
  }), { name: "AutofileError", message: "title: must be a non-empty string" });
  assert.deepEqual(await readdir(join(root, "data", "types")), ["notes.json"]);
});

test("stored declarations with invalid titles are unavailable through the library", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const path = join(root, "data", "types", "notes.json");
  for (const title of ["", null, 42, false, {}, []]) {
    const stored = JSON.stringify({ description: "Notes.", title, schema: { type: "object" } });
    await writeFile(path, stored);
    await assert.rejects(store.types.get("notes"), (error: unknown) => {
      assert.ok(error instanceof AutofileError);
      assert.deepEqual(error.problems, [{ uri: "autofile:///types/notes", message: "type declaration is not valid" }]);
      return true;
    });
    assert.deepEqual(await store.types.list(), []);
    await assert.rejects(store.types.update("notes", { title: "Note" }), isRefusal);
    assert.equal(await readFile(path, "utf8"), stored);
  }
});

test("titles come from the complete value even when selected fields omit the title", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" }, titleField: "name" });
  await store.records.create("notes", { name: "A title", body: "Search needle", title: "Unrelated field" }, { key: "one" });
  await store.records.create("notes", { name: 42 }, { key: "two" });
  const found = await store.records.find({ q: "needle", fields: ["body"] });
  assert.equal(found.records[0]?.title, "A title");
  assert.deepEqual(found.records[0]?.value, { body: "Search needle" });
  assert.equal("title" in (await store.records.get("autofile:///records/notes/two"))!, false);
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
    "autofile:///records/notes/a", "autofile:///records/projects/a", "autofile:///records/projects/z", "autofile:///records/tasks/a",
  ]);
  const query: RecordQuery = {
    type: ["tasks", "projects", "tasks"], q: "needle", where: { type: "value-type", status: "active" }, limit: 1,
  };
  const first = await store.records.find(query);
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///records/projects/z"]);
  assert.ok(first.cursor);
  await store.records.delete(first.records[0]!.uri);
  const second = await store.records.find({ ...query, cursor: first.cursor });
  assert.deepEqual(second.records.map(({ uri }) => uri), ["autofile:///records/tasks/a"]);
  assert.equal(second.cursor, undefined);
  assert.deepEqual((await store.records.find({ where: { status: null } })).records.map(({ uri }) => uri), ["autofile:///records/notes/a"]);
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
  await assert.rejects(store.records.update("autofile:///records/tasks/missing", {}), isRefusal);
  await assert.rejects(store.records.delete("autofile:///records/tasks/missing"), isRefusal);
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
  assert.deepEqual(first.records.map(({ uri }) => uri), ["autofile:///records/project-notes/one"]);
  assert.ok(first.cursor);
  const second = await store.records.find({ limit: 1, cursor: first.cursor });
  assert.deepEqual(second.records.map(({ uri }) => uri), ["autofile:///records/project/one"]);
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
  await writeFile(join(join(root, "data"), "records", "tasks", "broken.json"), "{\n");
  const readInvalid = await store.records.get(invalid.uri);
  assert.ok(readInvalid?.problems?.some(({ uri, message }) => uri === invalid.uri && message.includes("status")));
  assert.deepEqual({ ...readInvalid, problems: undefined }, { ...invalid, problems: undefined });
  const result = await store.records.find({ q: "needle" });
  assert.deepEqual(result.records, [valid]);
  assert.deepEqual(result.unreadable.map(({ uri }) => uri), ["autofile:///records/tasks/broken", invalid.uri]);
  assert.match(result.unreadable[0]?.message ?? "", /unavailable/u);
  assert.match(result.unreadable[1]?.message ?? "", /status/u);
  await assert.rejects(store.records.get("autofile:///records/tasks/broken"), isRefusal);
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
  assert.equal(await store.records.get("autofile:///records/documents/blocked"), undefined);
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
  assert.deepEqual(await prepared.validate({ target: "autofile:///records/notes/missing" }), []);
  assert.ok((await prepared.validate({})).some((message) => message.includes("target")));
  await assert.rejects(Autofile.prepareSchema({ $ref: "https://example.com/schema" }), isRefusal);
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Linked notes.", schema });
  await assert.rejects(store.records.create("notes", { target: "autofile:///records/notes/missing" }), isRefusal);
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
  await writeFile(join(join(root, "data"), "records", "tasks", "watched.json"), `${JSON.stringify({
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
    () => store.records.get("autofile:///records/tasks/missing"),
    () => store.records.create("tasks", {}),
    () => store.records.update("autofile:///records/tasks/missing", {}),
    () => store.records.delete("autofile:///records/tasks/missing"),
    () => store.types.list(),
    () => store.types.get("tasks"),
    () => store.types.create("tasks", taskDefinition),
    () => store.types.update("tasks", { description: "Closed" }),
    () => store.types.delete("tasks"),
    () => store.blobs.put(Buffer.from("closed"), "text/plain"),
    () => store.blobs.get(`autofile:///blobs/${"a".repeat(64)}.txt`),
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
  await waitForChange(changes, "autofile:///types/notes", "created");
  await store.close();
  const checkpoint = changes.length;
  await writeFile(join(join(root, "data"), "types", "notes.json"), JSON.stringify({
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
    const path = join(root, "data", "records", "notes", name);
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
  await assert.rejects(stat(join(root, "data", "records", "notes")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "data", "types", "notes.json")), { code: "ENOENT" });
});

test("type deletion refuses stored data replacing the type directory", async () => {
  const { root, store } = await fixture();
  const declaration = await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  await rm(join(root, "data", "records", "notes"), { recursive: true });
  await writeFile(join(root, "data", "records", "notes"), "unrelated storage contents");
  await assert.rejects(store.types.delete("notes"), { name: "AutofileError", message: "type still has stored data" });
  assert.deepEqual(await store.types.get("notes"), declaration);
  assert.equal(await readFile(join(root, "data", "records", "notes"), "utf8"), "unrelated storage contents");
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
  const attachmentId = String(record.value.attachment).slice("autofile:///blobs/".length);
  await chmod(join(root, "data", "blobs", attachmentId), 0o644);
  await writeFile(join(root, "data", "blobs", attachmentId), "changed attachment");
  await writeFile(join(root, "data", "blobs", `${"a".repeat(64)}.txt`), "unheld attachment");
  await mkdir(join(root, "data", "records", "undeclared"));
  await writeFile(join(root, "data", "records", "undeclared", "ignored.json"), JSON.stringify({
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
  const path = join(root, "data", "records", "notes", "unavailable.json");
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
  await rm(join(root, "data", "blobs", String(source.value.attachment).slice("autofile:///blobs/".length)));
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
        if: { properties: { trigger: { pattern: "^autofile:///blobs/" } } },
        then: { properties: { extra: { format: "blob" } } },
      }],
    },
  });
  const upload = await store.blobs.put(Buffer.from("hello"), "text/plain");
  const first = await store.records.create("documents", { trigger: upload });
  const second = await store.records.create("documents", { trigger: upload, extra: first.value.trigger! });
  assert.equal(second.value.extra, first.value.trigger);
});

test("blob metadata exposes the read-only local file and streaming supports whole, partial and empty reads", async () => {
  const { root, store } = await fixture();
  const bytes = Buffer.from("streamed attachment");
  const uri = await store.blobs.put(bytes, "text/plain");
  const metadata: BlobStat | undefined = await store.blobs.stat(uri);
  assert.deepEqual(metadata, { size: bytes.length, mimeType: "text/plain", path: join(root, "data", "blobs", uri.split("/").at(-1)!) });
  assert.equal((await stat(metadata!.path!)).mode & 0o777, 0o444);
  assert.deepEqual(await readFile(metadata!.path!), bytes);
  const ranges: Array<BlobRange | undefined> = [undefined, { start: 1, end: 7 }, { start: 4, end: 4 }, { start: bytes.length, end: bytes.length }];
  for (const range of ranges) {
    const stream = await store.blobs.stream(uri, range);
    assert.ok(stream instanceof ReadableStream);
    assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), range === undefined ? bytes : bytes.subarray(range.start, range.end));
  }
  const empty = await store.blobs.put(new Uint8Array(), "application/octet-stream");
  assert.equal((await new Response(await store.blobs.stream(empty)).arrayBuffer()).byteLength, 0);
});

test("cancelling a blob stream closes its file before and after reading", async () => {
  const { store } = await fixture();
  const uri = await store.blobs.put(Buffer.alloc(256 * 1024, 42), "application/octet-stream");
  const path = (await store.blobs.stat(uri))!.path!;
  const opened: Awaited<ReturnType<typeof fsPromises.open>>[] = [];
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) opened.push(handle);
    return handle;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  try {
    for (const readFirst of [false, true]) {
      const stream = await store.blobs.stream(uri);
      assert.ok(stream !== undefined);
      const handle = opened.at(-1)!;
      assert.ok(handle.fd >= 0, "the stream must own an open file before cancellation");
      const reader = stream.getReader();
      if (readFirst) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        assert.ok(chunk.value!.length < 256 * 1024);
      }
      await reader.cancel();
      assert.equal(handle.fd, -1, "cancellation must close the attachment file");
      await assert.rejects(handle.stat(), { code: "EBADF" });
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
    }
    assert.equal(opened.length, 2);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await Promise.all(opened.map((handle) => handle.close()));
  }
});

test("a blob stream read failure closes its file and hides storage details", async () => {
  const { store } = await fixture();
  const uri = await store.blobs.put(Buffer.alloc(256 * 1024, 42), "application/octet-stream");
  const path = (await store.blobs.stat(uri))!.path!;
  const opened: Awaited<ReturnType<typeof fsPromises.open>>[] = [];
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) {
      opened.push(handle);
      const read = handle.read.bind(handle);
      let reads = 0;
      handle.read = ((...input: Parameters<typeof handle.read>) => {
        if (++reads === 2) return Promise.reject(Object.assign(new Error(`EIO: ${path}`), { code: "EIO", path }));
        return read(...input);
      }) as typeof handle.read;
    }
    return handle;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  try {
    const stream = await store.blobs.stream(uri);
    assert.ok(stream !== undefined);
    const reader = stream.getReader();
    assert.equal((await reader.read()).done, false);
    await assert.rejects(reader.read(), { message: "Storage operation failed" });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.fd, -1, "a failed read must close the attachment file");
    await assert.rejects(opened[0]!.stat(), { code: "EBADF" });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await Promise.all(opened.map((handle) => handle.close()));
  }
});

test("blob streams refuse invalid ranges, return absent for unavailable entries, and obey close", async () => {
  const { root, store } = await fixture();
  const uri = await store.blobs.put(Buffer.from("hello"), "text/plain");
  for (const range of [
    { start: -1, end: 2 }, { start: 2, end: 1 }, { start: 0, end: 6 },
    { start: 0.5, end: 2 }, { start: 0, end: NaN }, { start: 0, end: Infinity },
    null, {}, { start: 0 }, { end: 2 },
  ]) await assert.rejects(store.blobs.stream(uri, range as { start: number; end: number }), isRefusal);
  const absent = `autofile:///blobs/${"a".repeat(64)}.txt`;
  for (const value of [absent, "autofile:///blobs/short.txt", undefined, 42]) {
    assert.equal(await store.blobs.stat(value as string), undefined);
    assert.equal(await store.blobs.stream(value as string), undefined);
  }
  await mkdir(join(root, "data", "blobs", "b".repeat(64)));
  assert.equal(await store.blobs.stat(`autofile:///blobs/${"b".repeat(64)}`), undefined);
  assert.equal(await store.blobs.stream(`autofile:///blobs/${"b".repeat(64)}`), undefined);
  await store.close();
  await assert.rejects(store.blobs.stat(uri), /closed/iu);
  await assert.rejects(store.blobs.stream(uri), /closed/iu);
});

test("throwing stream range accessors leave no attachment file open", async () => {
  const { store } = await fixture();
  const uri = await store.blobs.put(Buffer.from("hello"), "text/plain");
  const path = (await store.blobs.stat(uri))!.path!;
  const opened: Awaited<ReturnType<typeof fsPromises.open>>[] = [];
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) opened.push(handle);
    return handle;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  try {
    for (const field of ["start", "end"]) {
      const failure = new Error(`Cannot read ${field}`);
      const range = Object.defineProperty({ start: 0, end: 1 }, field, { get() { throw failure; } });
      await assert.rejects(store.blobs.stream(uri, range), (error: unknown) => error === failure);
      assert.ok(opened.every((handle) => handle.fd === -1), "a rejected stream left an attachment file open");
    }
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await Promise.all(opened.map((handle) => handle.close()));
  }
});

test("records create, update and clean up attachments larger than the MCP inline limit without reading them", async () => {
  const { root, store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.", schema: { type: "object", properties: { attachment: { format: "blob" }, title: { type: "string" } } },
  });
  const bytes = Buffer.alloc(7_340_033, 1);
  const uri = await store.blobs.put(bytes, "application/octet-stream");
  const path = join(root, "data", "blobs", uri.split("/").at(-1)!);
  const originalOpen = fsPromises.open;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === path) throw new Error("Record writes must never open attachment bytes");
    return originalOpen(...args);
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  let record: AutofileRecord;
  try {
    assert.equal((await store.blobs.stat(uri))?.size, bytes.length);
    record = await store.records.create("documents", { attachment: uri });
    await store.records.update(record.uri, { title: "Retained" });
    const other = await store.records.create("documents", {});
    await store.records.update(other.uri, { attachment: uri });
    await store.records.delete(record.uri);
    assert.ok(await store.blobs.stat(uri));
    await store.records.delete(other.uri);
    assert.equal(await store.blobs.stat(uri), undefined);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("the store uses the records, types and blobs tree and ignores every other root entry", async () => {
  const { root, store } = await fixture();
  const folder = join(root, "data");
  await mkdir(join(folder, "notes"), { recursive: true });
  await writeFile(join(folder, "notes", "unrelated.json"), "{\n");
  await writeFile(join(folder, "unrelated.json"), "{\n");
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const record = await store.records.create("notes", {}, { key: "one" });
  assert.equal(record.uri, "autofile:///records/notes/one");
  assert.deepEqual((await store.records.find()).unreadable, []);
  assert.deepEqual(JSON.parse(await readFile(join(folder, "records", "notes", "one.json"), "utf8")), {
    createdAt: record.createdAt, updatedAt: record.updatedAt, value: {},
  });
  assert.ok(await stat(join(folder, "types", "notes.json")));
  const changes: ChangeEvent[] = [];
  await store.watch((batch) => { changes.push(...batch); });
  await writeFile(join(folder, "notes", "another.json"), "{\n");
  const sentinel = await store.records.create("notes", {}, { key: "sentinel" });
  await waitForChange(changes, sentinel.uri, "created");
  assert.deepEqual(changes, [{ uri: sentinel.uri, kind: "created" }]);
  await store.records.delete(record.uri);
  await store.records.delete(sentinel.uri);
  await store.types.delete("notes");
  assert.equal(await readFile(join(folder, "notes", "unrelated.json"), "utf8"), "{\n");
});

test("record reads and queries ignore a symlink at the records root", async () => {
  const { root, store } = await fixture();
  await store.types.create("notes", { description: "Notes.", schema: { type: "object" } });
  const record = await store.records.create("notes", {}, { key: "one" });
  const outside = join(root, "outside");
  await mkdir(join(outside, "notes"), { recursive: true });
  await writeFile(join(outside, "notes", "one.json"), JSON.stringify({ createdAt: record.createdAt, updatedAt: record.updatedAt, value: {} }));
  await rm(join(root, "data", "records"), { recursive: true });
  await symlink(outside, join(root, "data", "records"), "dir");
  assert.equal(await store.records.get(record.uri), undefined);
  assert.deepEqual((await store.records.find()).records, []);
});
