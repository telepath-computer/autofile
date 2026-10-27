/** Attachment inputs are checked against the addresses stored in records. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Autofile, AutofileError, type JsonObject } from "@telepath-computer/autofile";

const roots: string[] = [];
const stores: Autofile[] = [];

async function fixture(): Promise<{ store: Autofile; folder: string }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-attachment-validation-"));
  roots.push(root);
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "home");
  try {
    const folder = join(root, "data");
    const store = new Autofile({ folder });
    stores.push(store);
    return { store, folder };
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
}

function dataUri(contents: string): string {
  return `data:application/pdf;base64,${Buffer.from(contents).toString("base64")}`;
}

async function put(store: Autofile, contents: string): Promise<string> {
  return store.blobs.put(Buffer.from(contents), "application/pdf");
}

function address(contents: string): string {
  return `autofile:///_blobs/${createHash("sha256").update(contents).digest("hex")}.pdf`;
}

after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("library creates and updates PDF attachments using existing address constraints", async () => {
  const { store, folder } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts.",
    schema: {
      type: "object", required: ["attachment"],
      properties: { attachment: { type: "string", format: "blob", pattern: "\\.pdf$" } },
    },
  });
  const created = await store.records.create("receipts", { attachment: await put(store, "first PDF") }, { key: "one" });
  assert.equal(created.value.attachment, address("first PDF"));
  assert.deepEqual(Buffer.from((await store.blobs.get(address("first PDF")))!.bytes), Buffer.from("first PDF"));
  const updated = await store.records.update(created.uri, { attachment: await put(store, "second PDF") });
  assert.equal(updated.value.attachment, address("second PDF"));
  const read = await store.records.get(created.uri);
  assert.deepEqual(read?.value, updated.value);
  assert.equal(read?.problems, undefined);
  const stored = JSON.parse(await readFile(join(folder, "receipts", "one.json"), "utf8")) as { value: unknown };
  assert.deepEqual(stored.value, updated.value);
  assert.equal(await store.blobs.get(address("first PDF")), undefined);
});

test("address constraints work through references, nested arrays and conditional fields without converting ordinary strings", async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "Nested PDF receipts.",
    schema: {
      type: "object",
      $defs: { attachment: { type: "string", format: "blob", pattern: "\\.pdf$" } },
      properties: {
        mode: { enum: ["plain", "attachment"] },
        note: { type: "string", pattern: "^data:" },
        source: { type: "string" },
        nested: { type: "array", items: { type: "object", properties: { scan: { $ref: "#/$defs/attachment" } } } },
      },
      allOf: [{
        if: { properties: { mode: { const: "attachment" } }, required: ["mode"] },
        then: { properties: { source: { $ref: "#/$defs/attachment" } } },
      }],
    },
  });
  const created = await store.records.create("receipts", {
    mode: "plain", note: dataUri("ordinary note"), source: dataUri("ordinary source"), nested: [{ scan: await put(store, "nested") }],
  });
  assert.equal(created.value.note, dataUri("ordinary note"));
  assert.equal(created.value.source, dataUri("ordinary source"));
  assert.deepEqual(created.value.nested, [{ scan: address("nested") }]);
  const updated = await store.records.update(created.uri, { mode: "attachment", source: await put(store, "conditional") });
  assert.equal(updated.value.source, address("conditional"));
  assert.equal(updated.value.note, dataUri("ordinary note"));
  assert.equal((await store.records.get(created.uri))?.problems, undefined);
});

test("a mismatched attachment address refuses creates and updates without changing uploads", async () => {
  const { store, folder } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts.",
    schema: {
      type: "object", properties: { attachment: { type: "string", format: "blob", pattern: "\\.pdf$" } },
    },
  });
  const created = await store.records.create("receipts", {}, { key: "one" });
  const wrong = await store.blobs.put(Buffer.from("hello"), "text/plain");
  await assert.rejects(store.records.create("receipts", { attachment: wrong }, { key: "refused" }), AutofileError);
  await assert.rejects(store.records.update(created.uri, { attachment: wrong }), AutofileError);
  assert.deepEqual((await store.records.get(created.uri))?.value, {});
  assert.deepEqual(await readdir(join(folder, "_blobs")), [wrong.split("/").at(-1)]);
});

test("failing schema branches do not convert ordinary data URIs or grant attachment ownership", async () => {
  const { store, folder } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts with notes.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" }, note: { type: "string" },
        attachment: { allOf: [{ type: "string", format: "blob" }, { pattern: "\\.pdf$" }] },
      },
      anyOf: [
        { properties: { kind: { const: "blob" }, note: { format: "blob" } }, required: ["kind"] },
        { properties: { kind: { const: "ordinary" } }, required: ["kind"] },
      ],
    },
  });
  const created = await store.records.create("receipts", {
    kind: "ordinary", note: dataUri("ordinary note"), attachment: await put(store, "first PDF"),
  });
  assert.equal(created.value.note, dataUri("ordinary note"));
  assert.equal(created.value.attachment, address("first PDF"));
  const unrelated = `autofile:///_blobs/${"a".repeat(64)}.pdf`;
  const updated = await store.records.update(created.uri, { note: unrelated, attachment: await put(store, "second PDF") });
  assert.equal(updated.value.note, unrelated);
  assert.equal(updated.value.attachment, address("second PDF"));
  assert.deepEqual(await readdir(join(folder, "_blobs")), [address("second PDF").split("/").at(-1)]);
});

for (const keyword of ["anyOf", "oneOf"]) test(`a successful ${keyword} ordinary-string alternative controls attachment annotations`, async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts with encoded ordinary notes.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" }, note: { type: "string" },
        attachment: { type: "string", format: "blob", pattern: "\\.pdf$" },
      },
      [keyword]: [
        { properties: { kind: { const: "blob" }, note: { format: "blob" } }, required: ["kind"] },
        { properties: { kind: { const: "ordinary" }, note: { pattern: "^data:" } }, required: ["kind"] },
      ],
    },
  });
  const note = dataUri("ordinary note");
  const created = await store.records.create("receipts", { kind: "ordinary", note, attachment: await put(store, "first PDF") });
  assert.equal(created.value.note, note);
  assert.equal(created.value.attachment, address("first PDF"));
  const updated = await store.records.update(created.uri, { attachment: await put(store, "second PDF") });
  assert.equal(updated.value.note, note);
  assert.equal(updated.value.attachment, address("second PDF"));
  assert.equal((await store.records.get(created.uri))?.problems, undefined);
});

for (const keyword of ["anyOf", "oneOf"]) test(`${keyword} attachment alternatives validate their own actual addresses`, async () => {
  const { store } = await fixture();
  const attachment = { type: "string", format: "blob", pattern: "\\.pdf$" };
  await store.types.create("receipts", {
    description: "PDF receipts with alternative schemas.",
    schema: {
      type: "object",
      [keyword]: [
        { properties: { kind: { const: "blob" }, note: { format: "blob" }, attachment }, required: ["kind", "attachment"] },
        { properties: { kind: { const: "ordinary" }, note: { pattern: "^data:" }, attachment }, required: ["kind", "attachment"] },
      ],
    },
  });
  const note = dataUri("ordinary note");
  const created = await store.records.create("receipts", { kind: "ordinary", note, attachment: await put(store, "first PDF") });
  assert.equal(created.value.note, note);
  assert.equal(created.value.attachment, address("first PDF"));
  const updated = await store.records.update(created.uri, { attachment: await put(store, "second PDF") });
  assert.equal(updated.value.note, note);
  assert.equal(updated.value.attachment, address("second PDF"));
});

test("attachment address suffixes choose between alternatives without interpreting ordinary notes", async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "Receipts whose notes depend on attachment media type.",
    schema: {
      type: "object", oneOf: [
        { properties: {
          note: { format: "blob" }, attachment: { format: "blob", pattern: "\\.txt$" },
        }, required: ["note", "attachment"] },
        { properties: {
          note: { pattern: "^data:" }, attachment: { format: "blob", pattern: "\\.pdf$" },
        }, required: ["note", "attachment"] },
      ],
    },
  });
  const note = dataUri("ordinary note");
  const created = await store.records.create("receipts", { note, attachment: await put(store, "first PDF") });
  assert.equal(created.value.note, note);
  assert.equal(created.value.attachment, address("first PDF"));
  const updated = await store.records.update(created.uri, { attachment: await put(store, "second PDF") });
  assert.equal(updated.value.note, note);
  assert.equal(updated.value.attachment, address("second PDF"));
});

test("mutually exclusive attachment alternatives select a valid final record", async () => {
  const { store } = await fixture();
  const pdf = { type: "string", format: "blob", pattern: "\\.pdf$" };
  await store.types.create("receipts", {
    description: "A PDF and an ordinary encoded string.",
    schema: { type: "object", anyOf: [
      { properties: { first: pdf, second: { pattern: "^data:" } }, required: ["first", "second"] },
      { properties: { first: { pattern: "^data:" }, second: pdf }, required: ["first", "second"] },
    ] },
  });
  const created = await store.records.create("receipts", { first: await put(store, "first"), second: dataUri("second") });
  const attachmentAddresses = [created.value.first, created.value.second].filter((value) => String(value).startsWith("autofile:"));
  assert.equal(attachmentAddresses.length, 1);
  assert.equal((await store.records.get(created.uri))?.problems, undefined);
});

test("negative and failed conditional predicates do not make ordinary text an attachment", async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts with conditional notes.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" }, note: { type: "string", pattern: "^data:" },
        attachment: { type: "string", format: "blob", pattern: "\\.pdf$" },
      },
      not: { properties: { kind: { const: "blob" }, note: { format: "blob" } }, required: ["kind"] },
      if: { properties: { kind: { const: "blob" }, note: { format: "blob" } }, required: ["kind"] },
      then: { required: ["nonexistent"] },
    },
  });
  const note = dataUri("ordinary note");
  const created = await store.records.create("receipts", { kind: "ordinary", note, attachment: await put(store, "PDF") });
  assert.equal(created.value.note, note);
  assert.equal(created.value.attachment, address("PDF"));
});

test("a successful contains match excludes ordinary nonmatching items from attachment annotations", async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "PDF receipts with mixed entries.",
    schema: {
      type: "object", properties: {
        attachment: { type: "string", format: "blob", pattern: "\\.pdf$" },
        entries: {
          type: "array",
          items: {
            if: { properties: { kind: { const: "ordinary" } }, required: ["kind"] },
            then: { properties: { note: { pattern: "^data:" } } },
          },
          contains: {
            type: "object", required: ["kind", "note"],
            properties: { kind: { const: "blob" }, note: { format: "blob" } },
          },
        },
      },
    },
  });
  const note = dataUri("ordinary note");
  const created = await store.records.create("receipts", {
    attachment: await put(store, "PDF"),
    entries: [{ kind: "ordinary", note }, { kind: "blob", note: await put(store, "entry PDF") }],
  });
  assert.deepEqual(created.value.entries, [{ kind: "ordinary", note }, { kind: "blob", note: address("entry PDF") }]);
});

test("schema preparation accepts only blob addresses and reports annotations for valid records", async () => {
  const schema = await Autofile.prepareSchema({
    type: "object", properties: { attachment: { format: "blob", pattern: "\\.pdf$" } },
  });
  const value = { attachment: address("PDF") };
  assert.deepEqual(await schema.validate(value), []);
  assert.deepEqual(schema.formatFields(value, "blob"), [
    { pointer: "/attachment", location: "attachment", value: value.attachment },
  ]);
  for (const attachment of [dataUri("PDF"), "/tmp/document.pdf", "input:one", "autofile:///_blobs/short.pdf"]) {
    assert.ok((await schema.validate({ attachment })).length > 0);
  }
});

const attachmentConstraints: JsonObject[] = [
  { const: address("allowed") },
  { enum: [address("allowed")] },
  { minLength: address("allowed").length, maxLength: address("allowed").length },
];
for (const constraint of attachmentConstraints) test(`attachment schemas enforce ${Object.keys(constraint).join(" and ")} on real addresses`, async () => {
  const { store } = await fixture();
  await store.types.create("receipts", {
    description: "Constrained attachments.",
    schema: { type: "object", properties: { attachment: { type: "string", format: "blob", ...constraint } } },
  });
  const allowed = await put(store, "allowed");
  assert.equal((await store.records.create("receipts", { attachment: allowed })).value.attachment, allowed);
  const refused = "minLength" in constraint
    ? await store.blobs.put(Buffer.from("other"), "application/json")
    : await put(store, "other");
  await assert.rejects(store.records.create("receipts", { attachment: refused }), AutofileError);
});

test("uploads accept bytes independently, deduplicate contents, normalize media types and preserve attachment addresses", async () => {
  const { store, folder } = await fixture();
  const bytes = Buffer.from("uploaded");
  const uri = await store.blobs.put(bytes, "APPLICATION/PDF");
  assert.equal(uri, address("uploaded"));
  assert.deepEqual(Buffer.from((await store.blobs.get(uri))!.bytes), bytes);
  assert.equal((await store.blobs.get(uri))!.mimeType, "application/pdf");
  const path = join(folder, "_blobs", uri.split("/").at(-1)!);
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await utimes(path, oldTime, oldTime);
  assert.equal(await store.blobs.put(bytes, "application/pdf"), uri);
  assert.equal((await stat(path)).mtime.toISOString(), oldTime.toISOString());
  const unknown = await store.blobs.put(bytes, "application/x-unrecognized-autofile-fixture");
  assert.equal(unknown, uri.slice(0, -".pdf".length));
  assert.equal((await store.blobs.get(unknown))!.mimeType, "application/octet-stream");
});

test("uploads accept exactly 7 MiB and reject invalid bytes, media types and larger inputs", async () => {
  const { store, folder } = await fixture();
  const bytes = Buffer.alloc(7_340_032);
  const uri = await store.blobs.put(bytes, "application/octet-stream");
  assert.equal((await store.blobs.get(uri))!.bytes.byteLength, bytes.length);
  await assert.rejects(store.blobs.put(Buffer.alloc(bytes.length + 1), "application/octet-stream"), (error: unknown) => {
    assert.ok(error instanceof AutofileError);
    assert.match(error.message, /7340033.*7340032/u);
    return true;
  });
  for (const value of [undefined, null, "bytes", [1, 2], new ArrayBuffer(2), new Uint16Array(2)]) {
    await assert.rejects(store.blobs.put(value as unknown as Uint8Array, "application/pdf"), AutofileError);
  }
  for (const mediaType of [undefined, null, 42, "", "pdf", "application/", "application/pdf\n", "application/pdf; charset=utf-8"]) {
    await assert.rejects(store.blobs.put(Buffer.from("no"), mediaType as string), AutofileError);
  }
  assert.equal((await readdir(join(folder, "_blobs"))).length, 1);
});

test("upload limits use the copied bytes even when the input shadows its byte length", async () => {
  const { store, folder } = await fixture();
  const bytes = Object.defineProperty(new Uint8Array(7_340_033), "byteLength", { value: 0 });
  await assert.rejects(store.blobs.put(bytes, "application/octet-stream"), (error: unknown) => {
    assert.ok(error instanceof AutofileError);
    assert.match(error.message, /7340033.*7340032/u);
    return true;
  });
  await assert.rejects(readdir(folder), { code: "ENOENT" });
});

test("uploads copy the precise byte view synchronously before callers mutate it", async () => {
  const { store } = await fixture();
  for (const bytes of [new Uint8Array([0, 1, 2, 3]).subarray(1, 3), Buffer.from([0, 1, 2, 3]).subarray(1, 3)]) {
    const putting = store.blobs.put(bytes, "application/octet-stream");
    bytes.fill(9);
    const uri = await putting;
    assert.deepEqual(Buffer.from((await store.blobs.get(uri))!.bytes), Buffer.from([1, 2]));
  }
});

test("blob reads ignore non-string addresses without invoking caller coercion", async () => {
  const { store } = await fixture();
  const uri = await put(store, "existing");
  let converted = false;
  const addressObject = { toString() { converted = true; return uri; } };
  for (const value of [undefined, null, 42, Symbol("blob"), {}, [uri], new String(uri), addressObject]) {
    assert.equal(await store.blobs.get(value as unknown as string), undefined);
  }
  assert.equal(converted, false);
});

test("records accept shared existing attachment URIs and refuse inline data, local paths and missing blobs", async () => {
  const { store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.", schema: { type: "object", properties: { attachment: { type: "string", format: "blob" } } },
  });
  const uri = await put(store, "shared");
  const first = await store.records.create("documents", { attachment: uri });
  const second = await store.records.create("documents", { attachment: uri });
  const third = await store.records.create("documents", {});
  assert.equal((await store.records.update(third.uri, { attachment: uri })).value.attachment, uri);
  for (const attachment of [dataUri("inline"), "/tmp/document.pdf", address("missing")]) {
    await assert.rejects(store.records.create("documents", { attachment }), AutofileError);
    await assert.rejects(store.records.update(first.uri, { attachment }), AutofileError);
  }
  assert.deepEqual(await store.records.get(first.uri), first);
  await store.records.delete(first.uri);
  await store.records.update(second.uri, { attachment: null });
  assert.ok(await store.blobs.get(uri));
  await store.records.delete(third.uri);
  assert.equal(await store.blobs.get(uri), undefined);
});

test("fresh never-held uploads survive unrelated updates and deletes, including attachment cleanup", async () => {
  const { store } = await fixture();
  await store.types.create("documents", {
    description: "Documents.", schema: { type: "object", properties: { attachment: { type: "string", format: "blob" }, title: { type: "string" } } },
  });
  const fresh = await put(store, "fresh");
  const previous = await put(store, "held");
  const record = await store.records.create("documents", { attachment: previous });
  await store.records.update(record.uri, { title: "Changed", attachment: null });
  assert.equal(await store.blobs.get(previous), undefined);
  assert.ok(await store.blobs.get(fresh));
  await store.records.delete(record.uri);
  assert.ok(await store.blobs.get(fresh));
  const attached = await store.records.create("documents", { attachment: fresh });
  await store.records.delete(attached.uri);
  assert.equal(await store.blobs.get(fresh), undefined);
});
