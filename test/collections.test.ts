/** Exercises collections: the built-in type, record membership, queries and deletion. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { Autofile, AutofileError, type ChangeEvent } from "@telepath-computer/autofile";
import { buildServer } from "../dist/server.js";

const roots: string[] = [];
const stores: Autofile[] = [];
const closers: Array<() => Promise<void>> = [];
const noteDefinition = {
  description: "Notes.",
  titleField: "title",
  schema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
    additionalProperties: false,
  },
};
const collectionDeclaration = {
  uri: "autofile:///types/collection",
  type: "collection",
  description: "Collections group records the way folders do. A record joins a collection through its collections list, not through a field.",
  title: "Collection",
  titleField: "title",
  schema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", description: "The name of the collection, as shown in a folder list." },
      description: { type: "string", description: "What belongs in the collection." },
    },
  },
};

async function fixture(): Promise<{ data: string; store: Autofile }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-collections-"));
  roots.push(root);
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "autofile-home");
  try {
    const data = join(root, "data");
    const store = new Autofile({ folder: data });
    stores.push(store);
    return { data, store };
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
}

async function withNotes(): Promise<{ data: string; store: Autofile }> {
  const result = await fixture();
  await result.store.types.create("note", noteDefinition);
  return result;
}

async function refusal(operation: Promise<unknown>): Promise<string[]> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof AutofileError);
    return error.problems.map(({ message }) => message);
  }
  assert.fail("expected a refusal");
}

async function connect(store: Autofile): Promise<Client> {
  const handler = createMcpHandler(() => buildServer(store, { blobLocation: "http" }), { legacy: "reject" });
  const transport = new StreamableHTTPClientTransport(new URL("http://autofile.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "collections-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(transport);
  closers.push(async () => { await client.close(); await handler.close(); });
  return client;
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

after(async () => {
  for (const store of stores) await store.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the built-in collection type is listed and cannot be created, changed or deleted", async () => {
  const { data, store } = await fixture();
  assert.deepEqual(await store.types.list(), [collectionDeclaration]);
  assert.deepEqual(await store.types.get("collection"), collectionDeclaration);

  await mkdir(join(data, "types"), { recursive: true });
  await writeFile(join(data, "types", "collection.json"), JSON.stringify({ description: "Mine", schema: { type: "object" } }));
  assert.deepEqual(await store.types.get("collection"), collectionDeclaration);
  assert.deepEqual((await store.types.list()).map(({ type }) => type), ["collection"]);

  const message = "type: collection is built in and cannot be created, changed or deleted";
  assert.deepEqual(await refusal(store.types.create("collection", noteDefinition)), [message]);
  assert.deepEqual(await refusal(store.types.update("collection", { description: "Folders" })), [message]);
  assert.deepEqual(await refusal(store.types.delete("collection")), [message]);
});

test("records join collections on create and update, stored beside value", async () => {
  const { data, store } = await withNotes();
  const recipes = await store.records.create("collection", { title: "Recipes" }, { key: "recipes" });
  const soups = await store.records.create("collection", { title: "Soups" }, { key: "soups", collections: [recipes.uri] });
  assert.deepEqual(soups.collections, [recipes.uri]);

  const note = await store.records.create("note", { title: "Tomato soup" }, { key: "tomato", collections: [soups.uri, recipes.uri] });
  assert.deepEqual(note.collections, [soups.uri, recipes.uri]);
  const stored = JSON.parse(await readFile(join(data, "records", "note", "tomato.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored), ["createdAt", "updatedAt", "collections", "value"]);
  assert.deepEqual(stored.value, { title: "Tomato soup" });

  const moved = await store.records.update(note.uri, {}, { collections: [recipes.uri] });
  assert.deepEqual(moved.collections, [recipes.uri]);
  assert.notEqual(moved.updatedAt, note.updatedAt);
  const renamed = await store.records.update(note.uri, { title: "Tomato and basil soup" });
  assert.deepEqual(renamed.collections, [recipes.uri]);

  const removed = await store.records.update(note.uri, {}, { collections: [] });
  assert.equal(removed.collections, undefined);
  const plain = JSON.parse(await readFile(join(data, "records", "note", "tomato.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(plain), ["createdAt", "updatedAt", "value"]);
  assert.deepEqual((await store.records.get(note.uri))?.collections, undefined);
});

test("collection lists must name existing collections, once each, without loops", async () => {
  const { store } = await withNotes();
  const a = await store.records.create("collection", { title: "A" }, { key: "a" });
  const b = await store.records.create("collection", { title: "B" }, { key: "b", collections: [a.uri] });
  const c = await store.records.create("collection", { title: "C" }, { key: "c", collections: [b.uri] });
  const note = await store.records.create("note", { title: "N" }, { key: "n" });

  assert.deepEqual(
    await refusal(store.records.create("note", { title: "X" }, { collections: ["autofile:///records/collection/missing"] })),
    ["collections: autofile:///records/collection/missing is not a collection that exists"],
  );
  assert.deepEqual(
    await refusal(store.records.create("note", { title: "X" }, { collections: [note.uri] })),
    [`collections: ${note.uri} is not a collection URI`],
  );
  assert.deepEqual(
    await refusal(store.records.create("note", { title: "X" }, { collections: [a.uri, a.uri] })),
    ["collections: must not list a collection more than once"],
  );
  assert.deepEqual(
    await refusal(store.records.create("note", { title: "X" }, { collections: "a" as unknown as string[] })),
    ["collections: must be an array of collection URIs"],
  );
  assert.deepEqual(await refusal(store.records.update(a.uri, {}, { collections: [a.uri] })), [
    `collections: would put ${a.uri} inside itself`,
  ]);
  assert.deepEqual(await refusal(store.records.update(a.uri, {}, { collections: [c.uri] })), [
    `collections: would put ${a.uri} inside itself`,
  ]);
  assert.deepEqual((await store.records.get(a.uri))?.collections, undefined);
});

test("find_records filters by direct membership, or by none with null", async () => {
  const { store } = await withNotes();
  const home = await store.records.create("collection", { title: "Home" }, { key: "home" });
  const garden = await store.records.create("collection", { title: "Garden" }, { key: "garden", collections: [home.uri] });
  await store.records.create("collection", { title: "Work" }, { key: "work" });
  await store.records.create("note", { title: "Boiler" }, { key: "boiler", collections: [home.uri] });
  await store.records.create("note", { title: "Roses" }, { key: "roses", collections: [garden.uri] });
  await store.records.create("note", { title: "Loose" }, { key: "loose" });

  const uris = async (query: Parameters<Autofile["records"]["find"]>[0]) => (await store.records.find(query)).records.map(({ uri }) => uri);
  assert.deepEqual(await uris({ collection: home.uri }), [
    "autofile:///records/collection/garden",
    "autofile:///records/note/boiler",
  ]);
  assert.deepEqual(await uris({ type: "collection", collection: null }), [
    "autofile:///records/collection/home",
    "autofile:///records/collection/work",
  ]);
  assert.deepEqual(await uris({ type: "note", collection: null }), ["autofile:///records/note/loose"]);
  assert.deepEqual(await refusal(store.records.find({ collection: "autofile:///records/collection/nope" })), [
    "collection does not exist",
  ]);
  assert.deepEqual(await refusal(store.records.find({ collection: 3 as unknown as string })), [
    "collection: must be a collection URI or null",
  ]);
});

test("deleting a collection removes it from every record and keeps the members", async () => {
  const { store } = await withNotes();
  const home = await store.records.create("collection", { title: "Home" }, { key: "home" });
  const work = await store.records.create("collection", { title: "Work" }, { key: "work" });
  const garden = await store.records.create("collection", { title: "Garden" }, { key: "garden", collections: [home.uri] });
  const shared = await store.records.create("note", { title: "Shared" }, { key: "shared", collections: [home.uri, work.uri] });
  const roses = await store.records.create("note", { title: "Roses" }, { key: "roses", collections: [garden.uri] });

  await store.records.delete(home.uri);
  assert.equal(await store.records.get(home.uri), undefined);
  assert.deepEqual((await store.records.get(shared.uri))?.collections, [work.uri]);
  const orphan = await store.records.get(garden.uri);
  assert.equal(orphan?.collections, undefined);
  assert.ok(orphan !== undefined && orphan.updatedAt > garden.updatedAt);
  assert.deepEqual((await store.records.get(roses.uri))?.collections, [garden.uri]);
});

test("malformed stored collections make the record unreadable", async () => {
  const { data, store } = await withNotes();
  const folder = join(data, "records", "note");
  await mkdir(folder, { recursive: true });
  const base = { createdAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-30T10:00:00Z", value: { title: "Bad" } };
  for (const [key, collections] of [["empty", []], ["text", "x"], ["twice", ["autofile:///records/collection/a", "autofile:///records/collection/a"]], ["other", ["autofile:///records/note/x"]]] as const) {
    await writeFile(join(folder, `${key}.json`), JSON.stringify({ ...base, collections }));
  }
  const result = await store.records.find({ type: "note" });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.unreadable.map(({ message }) => message), Array(4).fill("record is not valid"));
});

test("membership changes are reported as record changes", async () => {
  const { store } = await withNotes();
  const home = await store.records.create("collection", { title: "Home" }, { key: "home" });
  const note = await store.records.create("note", { title: "N" }, { key: "n" });
  const events: ChangeEvent[] = [];
  let seen: () => void = () => {};
  const arrived = new Promise<void>((resolve) => { seen = resolve; });
  const stop = await store.watch((changes) => {
    events.push(...changes);
    if (events.some(({ uri }) => uri === note.uri)) seen();
  });
  await store.records.update(note.uri, {}, { collections: [home.uri] });
  await arrived;
  await stop();
  assert.ok(events.some((event) => event.uri === note.uri && event.kind === "changed"));
});

test("MCP tools take collections on create and update and filter find_records", async () => {
  const { store } = await withNotes();
  const client = await connect(store);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  assert.ok((structured(await call("list_types", {})).types as Array<{ type: string }>).some(({ type }) => type === "collection"));
  await call("create_record", { type: "collection", key: "home", record: { title: "Home" } });
  const created = await call("create_record", {
    type: "note", key: "n", record: { title: "N" }, collections: ["autofile:///records/collection/home"],
  });
  assert.notEqual(created.isError, true);

  const fetched = structured(await call("get_record", { uri: "autofile:///records/note/n" }));
  assert.deepEqual(fetched.collections, ["autofile:///records/collection/home"]);

  const found = structured(await call("find_records", { collection: "autofile:///records/collection/home" }));
  assert.deepEqual((found.records as Array<{ uri: string; collections: string[] }>).map(({ uri, collections }) => ({ uri, collections })), [
    { uri: "autofile:///records/note/n", collections: ["autofile:///records/collection/home"] },
  ]);
  const top = structured(await call("find_records", { collection: null }));
  assert.deepEqual((top.records as Array<{ uri: string }>).map(({ uri }) => uri), ["autofile:///records/collection/home"]);

  const moved = await call("update_record", { uri: "autofile:///records/note/n", collections: [] });
  assert.deepEqual(moved.structuredContent, { uri: "autofile:///records/note/n" });
  assert.equal(structured(await call("get_record", { uri: "autofile:///records/note/n" })).collections, undefined);

  const neither = await call("update_record", { uri: "autofile:///records/note/n" });
  assert.equal(neither.isError, true);
  assert.deepEqual(structured(neither).errors, [{ uri: "autofile:///records/note/n", message: "supply patch, collections or both" }]);

  const refused = await call("create_type", { type: "collection", description: "x", schema: { type: "object" } });
  assert.equal(refused.isError, true);
});
