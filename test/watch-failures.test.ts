/** Exercises public change subscriptions when declaration metadata cannot be read. */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Autofile, type ChangeEvent } from "@telepath-computer/autofile";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

for (const knownType of [true, false]) {
  test(`watch preserves a batch and recovers when a ${knownType ? "known" : "new"} declaration read fails`, {
    timeout: 15_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "autofile-watch-failure-"));
    const previousHome = process.env.AUTOFILE_HOME;
    process.env.AUTOFILE_HOME = join(root, "home");
    const store = new Autofile({ folder: join(root, "data") });
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
    const originalOpen = fsPromises.open;
    const definition = { description: "Initial description", schema: { type: "object" } };
    const declarations = join(root, "data", "_types");
    const failedPath = join(declarations, "middle.json");
    const batches: ChangeEvent[][] = [];
    const errors: Error[] = [];
    let failing = true;
    try {
      for (const type of ["before", "after", "unrelated", ...(knownType ? ["middle"] : [])]) {
        await store.types.create(type, definition);
      }
      await mkdir(join(root, "data", "middle"), { recursive: true });
      await store.watch((changes) => { batches.push(changes); }, { onError: (error) => { errors.push(error); } });
      fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === failedPath && failing) {
          handle.readFile = (async () => {
            throw Object.assign(new Error(`EIO: private metadata at ${failedPath}`), {
              code: "EIO", path: failedPath, cause: new Error("private cause"),
            });
          }) as typeof handle.readFile;
        }
        return handle;
      }) as typeof originalOpen;
      syncBuiltinESMExports();

      // Synchronous writes keep all notices inside the real watcher's batch window.
      for (const type of ["before", "middle", "after"]) {
        writeFileSync(join(declarations, `${type}.json`), JSON.stringify({ ...definition, description: "Changed" }));
      }
      const record = { createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z", value: {} };
      for (const type of ["middle", "unrelated"]) {
        writeFileSync(join(root, "data", type, "first.json"), JSON.stringify(record));
      }

      await waitFor(() => errors.length > 0, "declaration read failure was not publicly reported");
      await waitFor(() => batches.some((batch) => batch.some(({ uri }) => uri === "autofile:///unrelated/first")),
        "declaration read failure discarded the unrelated record notice");
      const failedBatch = batches.find((batch) => batch.some(({ uri }) => uri === "autofile:///unrelated/first"))!;
      assert.deepEqual(new Set(failedBatch.map(({ uri }) => uri)), new Set([
        "autofile:///_types/before", "autofile:///_types/middle", "autofile:///_types/after",
        "autofile:///middle/first", "autofile:///unrelated/first",
      ]));
      for (const error of errors) {
        assert.equal(error.message, "Change monitoring failed");
        assert.equal("path" in error, false);
        assert.equal("code" in error, false);
        assert.equal(error.cause, undefined);
      }

      // A failed refresh must not evict an already known type from later batches.
      if (knownType) {
        writeFileSync(join(root, "data", "middle", "cached.json"), JSON.stringify(record));
        await waitFor(() => batches.flat().some(({ uri }) => uri === "autofile:///middle/cached"),
          "failed declaration refresh discarded the known type");
      }

      failing = false;
      writeFileSync(failedPath, JSON.stringify({ ...definition, description: "Recovered" }));
      await waitFor(() => batches.flat().filter(({ uri }) => uri === "autofile:///_types/middle").length === 2,
        "declaration monitoring did not recover");
      writeFileSync(join(root, "data", "middle", "recovered.json"), JSON.stringify(record));
      await waitFor(() => batches.flat().some(({ uri }) => uri === "autofile:///middle/recovered"),
        "record monitoring did not recover");
      assert.equal(errors.length, 1);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
