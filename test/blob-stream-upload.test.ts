/** Stream uploads write and hash each chunk without collecting the whole source. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Autofile, AutofileError } from "@telepath-computer/autofile";

const roots: string[] = [];
const stores: Autofile[] = [];

async function fixture(): Promise<{ store: Autofile; folder: string }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-stream-upload-"));
  roots.push(root);
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "home");
  try {
    const store = new Autofile({ folder: join(root, "data") });
    stores.push(store);
    return { store, folder: join(root, "data", "blobs") };
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
}

after(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("stream uploads persist chunks as consumed and preserve bytes, hash, permissions and deduplication", async () => {
  const { store, folder } = await fixture();
  const parts = [Buffer.alloc(1024 * 1024, 1), Buffer.alloc(0), Buffer.from([0, 2, 3, 4]).subarray(1, 3)];
  let written = 0;
  async function* chunks() {
    for (const part of parts) {
      yield part;
      written += part.length;
      const names = await readdir(folder);
      assert.equal(names.length, 1);
      assert.ok(names[0]!.startsWith("."));
      assert.equal((await stat(join(folder, names[0]!))).size, written, "the writer must persist each chunk before requesting another");
    }
  }
  const bytes = Buffer.concat(parts);
  const name = `${createHash("sha256").update(bytes).digest("hex")}.txt`;
  const uri = await store.blobs.putStream(chunks(), "TEXT/PLAIN");
  assert.equal(uri, `autofile:///blobs/${name}`);
  assert.deepEqual(await readdir(folder), [name]);
  assert.deepEqual(await readFile(join(folder, name)), bytes);
  assert.equal((await stat(join(folder, name))).mode & 0o777, 0o444);
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await utimes(join(folder, name), oldTime, oldTime);
  async function* repeated() { yield bytes; }
  assert.equal(await store.blobs.putStream(repeated(), "text/plain"), uri);
  assert.equal((await stat(join(folder, name))).mtime.toISOString(), oldTime.toISOString());
  assert.deepEqual(await readdir(folder), [name]);
  async function* empty() {}
  const emptyUri = await store.blobs.putStream(empty(), "application/octet-stream");
  assert.equal((await store.blobs.stat(emptyUri))?.size, 0);
});

test("stream uploads clean up temporary files on source errors and invalid chunks", async () => {
  const { store, folder } = await fixture();
  const failure = new Error("source stopped");
  let returned = false;
  async function* broken() {
    try { yield Buffer.from("partial"); throw failure; }
    finally { returned = true; }
  }
  await assert.rejects(store.blobs.putStream(broken(), "text/plain"), (error: unknown) => error === failure);
  assert.equal(returned, true);
  assert.deepEqual(await readdir(folder), []);
  async function* invalid() { yield Buffer.from("partial"); yield "invalid"; }
  await assert.rejects(store.blobs.putStream(invalid() as AsyncIterable<Uint8Array>, "text/plain"), AutofileError);
  assert.deepEqual(await readdir(folder), []);
  const usable = await store.blobs.put(Buffer.from("usable"), "text/plain");
  assert.ok(await store.blobs.stat(usable));
});

test("stream uploads remove temporary files after storage failures and validate their inputs", async () => {
  const { store, folder } = await fixture();
  const bytes = Buffer.from("blocked destination");
  const name = `${createHash("sha256").update(bytes).digest("hex")}.txt`;
  await mkdir(join(folder, name), { recursive: true });
  async function* chunks() { yield bytes; }
  await assert.rejects(store.blobs.putStream(chunks(), "text/plain"), { message: "Storage operation failed" });
  assert.deepEqual(await readdir(folder), [name]);
  for (const source of [undefined, null, {}, [], "bytes", new Uint8Array(2)]) {
    await assert.rejects(store.blobs.putStream(source as AsyncIterable<Uint8Array>, "text/plain"), AutofileError);
  }
  await assert.rejects(store.blobs.putStream(chunks(), "invalid"), AutofileError);
  await store.close();
  await assert.rejects(store.blobs.putStream(chunks(), "text/plain"), /closed/iu);
});
