/** Rejects inherited JSON serialization hooks without invoking caller code. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("record writes refuse inherited toJSON functions and accessors before storage initialization", () => {
  // Run outside the test runner: inherited hooks also affect its result transport.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autofile, AutofileError } from "@telepath-computer/autofile";

  const root = await mkdtemp(join(tmpdir(), "autofile-json-inherited-"));
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "home");
  const store = new Autofile({ folder: join(root, "data") });
  if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
  else process.env.AUTOFILE_HOME = previousHome;
  let calls = 0;
  const run = () => { calls += 1; throw new Error("Serialization hook must not run"); };
  const isRefusal = (error) => {
    assert.ok(error instanceof AutofileError);
    assert.match(error.message, /JSON/u);
    return true;
  };
  try {
    for (const prototype of [Object.prototype, Array.prototype]) {
      const original = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      try {
        for (const descriptor of [{ value: run }, { get: run }]) {
          Object.defineProperty(prototype, "toJSON", { ...descriptor, configurable: true });
          const value = { nested: [1] };
          await assert.rejects(store.records.create("notes", value), isRefusal);
          await assert.rejects(store.records.update("autofile:///notes/missing", value), isRefusal);
        }
      } finally {
        if (original === undefined) delete prototype.toJSON;
        else Object.defineProperty(prototype, "toJSON", original);
      }
    }
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
