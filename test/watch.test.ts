/** Exercises resource watching through real filesystem events. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { openStore, type Store } from "./helpers/store.ts";
import { watchResources, type ResourceChange, type ResourceWatcher } from "../dist/mcp-watch.js";
import { buildResources, type Resources } from "../dist/mcp-resources.js";
import { watchFolder } from "../dist/watch.js";

const roots: string[] = [];
const waitTimeoutMs = 10_000;
const taskSchema = {
  type: "object",
  required: ["title", "status"],
  properties: {
    title: { type: "string" },
    status: { type: "string" },
  },
  additionalProperties: false,
};

interface ChangeLog {
  changes: ResourceChange[];
  listeners: Set<() => void>;
}

interface WatchFixture {
  changes: ChangeLog;
  dataFolder: string;
  errors: Error[];
  store: Store;
  watcher: ResourceWatcher;
}

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-watch-"));
  roots.push(root);
  return root;
}

function createChangeLog(): ChangeLog {
  return { changes: [], listeners: new Set() };
}

function recordChange(log: ChangeLog, change: ResourceChange): void {
  log.changes.push(change);
  for (const listener of log.listeners) listener();
}

async function waitForChanges(
  log: ChangeLog,
  start: number,
  expected: ResourceChange[],
  message: string,
  timeoutMs = waitTimeoutMs,
  allowUnexpected = false,
): Promise<void> {
  const matches = (change: ResourceChange, wanted: ResourceChange): boolean => (
    change.uri === wanted.uri
    && change.kind === wanted.kind
    && change.listChanged === wanted.listChanged
  );
  const hasExpectedChanges = (): boolean => {
    const observed = log.changes.slice(start);
    return expected.every((wanted) => observed.some((change) => matches(change, wanted)));
  };
  if (!hasExpectedChanges()) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`${message}; received ${JSON.stringify(log.changes.slice(start))}`));
      }, timeoutMs);
      const listener = () => {
        if (!hasExpectedChanges()) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        log.listeners.delete(listener);
      };
      log.listeners.add(listener);
    });
  }
  if (!allowUnexpected) {
    const unexpected = log.changes.slice(start).filter((change) => (
      !expected.some((wanted) => matches(change, wanted))
    ));
    assert.deepEqual(unexpected, [], `${message}; received unexpected resource changes`);
  }
}

function storedRecord(title: string, status: string, sequence = 0): string {
  const timestamp = new Date(Date.UTC(2026, 9, 8, 12, 0, sequence)).toISOString();
  return `${JSON.stringify({
    createdAt: timestamp,
    updatedAt: timestamp,
    value: { title, status },
  }, null, 2)}\n`;
}

function storedDeclaration(description: string): string {
  return `${JSON.stringify({
    description,
    schema: taskSchema,
    titleField: "title",
  }, null, 2)}\n`;
}

async function createFixture(options: {
  recordFiles?: Record<string, { status: string; title: string }>;
  records?: Record<string, { status: string; title: string }>;
  types?: string[];
  watchedResources?: (store: Resources) => Resources;
} = {}): Promise<WatchFixture> {
  const root = await temp();
  const dataFolder = join(root, "data");
  const store = await openStore({
    dataFolder,
    writeLockPath: join(root, "autofile-home", "write.lock"),
  });
  for (const type of options.types ?? ["tasks"]) {
    await store.createType({
      type,
      description: `${type} records.`,
      titleField: "title",
      schema: taskSchema,
    });
  }
  for (const [key, record] of Object.entries(options.records ?? {})) {
    await store.createRecord({ type: "tasks", key, record });
  }
  for (const [key, record] of Object.entries(options.recordFiles ?? {})) {
    await mkdir(join(dataFolder, "records", "tasks"), { recursive: true });
    await writeFile(
      join(dataFolder, "records", "tasks", `${key}.json`),
      storedRecord(record.title, record.status),
    );
  }


  const changes = createChangeLog();
  const errors: Error[] = [];
  const resources = buildResources(store.autofile);
  const subscription = await watchResources(
    store.autofile,
    (batch) => {
      for (const change of batch.changes) recordChange(changes, change);
    },
    (error) => errors.push(error),
    options.watchedResources?.(resources) ?? resources,
  );
  const watcher = {
    async close(): Promise<void> {
      await subscription.close();
      await store.autofile.close();
    },
  };
  return { changes, dataFolder, errors, store, watcher };
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("folder watching reports recognized file changes without reading their contents", {
  timeout: 30_000,
}, async () => {
  const dataFolder = join(await temp(), "data");
  await mkdir(join(dataFolder, "records", "undeclared"), { recursive: true });
  const changes = createChangeLog();
  const errors: Error[] = [];
  const watcher = await watchFolder(dataFolder, (batch) => {
    for (const change of batch) {
      assert.deepEqual(Object.keys(change).sort(), ["kind", "uri"]);
      recordChange(changes, { ...change, listChanged: false });
    }
  }, (error) => errors.push(error));
  try {
    await mkdir(join(dataFolder, "blobs"));
    await writeFile(join(dataFolder, "blobs", `${"a".repeat(64)}.txt`), "ignored attachment");
    const path = join(dataFolder, "records", "undeclared", "broken.json");
    await writeFile(path, "not JSON");
    await waitForChanges(changes, 0, [{
      uri: "autofile:///records/undeclared/broken",
      kind: "created",
      listChanged: false,
    }], "physical file creation was filtered by its contents");
    const start = changes.changes.length;
    await unlink(path);
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/undeclared/broken",
      kind: "deleted",
      listChanged: false,
    }], "physical file deletion was not reported");
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
});

test("the watcher maps record and declaration changes", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    records: { existing: { title: "Existing", status: "active" } },
  });
  const { changes, dataFolder, errors, store, watcher } = fixture;
  try {
    let start = changes.changes.length;
    const recordPath = join(dataFolder, "records", "tasks", "created.json");
    await writeFile(recordPath, storedRecord("Created", "active"));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/created",
      kind: "created",
      listChanged: true,
    }], "record creation was not reported");

    start = changes.changes.length;
    await writeFile(recordPath, storedRecord("Created", "complete", 1));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/created",
      kind: "changed",
      listChanged: false,
    }], "record content change was not reported");

    start = changes.changes.length;
    await writeFile(recordPath, storedRecord("Renamed", "complete", 2));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/created",
      kind: "changed",
      listChanged: true,
    }], "record title change did not change the resource list");

    start = changes.changes.length;
    await unlink(recordPath);
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/created",
      kind: "deleted",
      listChanged: true,
    }], "record deletion was not reported");

    start = changes.changes.length;
    await store.createType({
      type: "notes",
      description: "Notes.",
      titleField: "title",
      schema: taskSchema,
    });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/notes",
      kind: "created",
      listChanged: true,
    }], "declaration creation was not reported");

    start = changes.changes.length;
    await store.updateType({ type: "notes", description: "Changed notes." });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/notes",
      kind: "changed",
      listChanged: true,
    }], "declaration description change did not change the resource list");

    start = changes.changes.length;
    await store.updateType({ type: "notes", title: "Note" });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/notes",
      kind: "changed",
      listChanged: true,
    }], "declaration title change did not change the resource list");

    start = changes.changes.length;
    await store.deleteType({ type: "notes" });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/notes",
      kind: "deleted",
      listChanged: true,
    }], "declaration deletion was not reported");


    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
});

test("unattached blobs do not produce resource notices", {
  timeout: 30_000,
}, async () => {
  const { changes, dataFolder, errors, store, watcher } = await createFixture();
  try {
    const start = changes.changes.length;
    const blobName = `${"b".repeat(64)}.txt`;
    await mkdir(join(dataFolder, "blobs"), { recursive: true });
    await writeFile(join(dataFolder, "blobs", blobName), "unattached contents");
    await store.createRecord({
      type: "tasks", key: "after-blob", record: { title: "After blob", status: "active" },
    });
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/after-blob",
      kind: "created",
      listChanged: true,
    }], "an unattached blob produced a resource notice");

    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
});

test("a titleField change updates the resource list", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    records: { changing: { title: "Before", status: "active" } },
  });
  const { changes, store, watcher } = fixture;
  try {
    const start = changes.changes.length;
    await store.updateType({ type: "tasks", titleField: "status" });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/tasks",
      kind: "changed",
      listChanged: true,
    }], "changing titleField did not change the resource list");

  } finally {
    await watcher.close();
  }
});

test("record validity changes update the resource list", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    records: { changing: { title: "Before", status: "active" } },
  });
  const { changes, dataFolder, watcher } = fixture;
  const recordPath = join(dataFolder, "records", "tasks", "changing.json");
  try {
    let start = changes.changes.length;
    await writeFile(recordPath, "{\n");
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/changing",
      kind: "changed",
      listChanged: true,
    }], "a record that stopped being listable did not change the resource list");

    start = changes.changes.length;
    await writeFile(recordPath, storedRecord("After", "complete", 1));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/changing",
      kind: "changed",
      listChanged: true,
    }], "a record that became listable did not change the resource list");
  } finally {
    await watcher.close();
  }
});

test("a failed focused read of a new resource emits a hint and marks its metadata unknown", {
  timeout: 30_000,
}, async () => {
  let failNextRead = true;
  const uri = "autofile:///records/tasks/created";
  const fixture = await createFixture({
    records: { existing: { title: "Existing", status: "active" } },
    watchedResources: (store) => new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getResourceMetadata") {
          return async (resourceUri: string) => {
            if (resourceUri === uri && failNextRead) {
              failNextRead = false;
              throw new Error("new resource metadata temporarily unavailable");
            }
            return await target.getResourceMetadata(resourceUri);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  });
  const { changes, dataFolder, errors, watcher } = fixture;
  const path = join(dataFolder, "records", "tasks", "created.json");
  try {
    let start = changes.changes.length;
    await writeFile(path, storedRecord("First title", "active"));
    await waitForChanges(changes, start, [{
      uri,
      kind: "created",
      listChanged: true,
    }], "a failed first metadata read suppressed the creation hint");
    assert.deepEqual(
      errors.map(({ message }) => message),
      ["new resource metadata temporarily unavailable"],
    );

    start = changes.changes.length;
    await writeFile(path, storedRecord("Second title", "active", 1));
    await waitForChanges(changes, start, [{
      uri,
      kind: "changed",
      listChanged: true,
    }], "the first successful metadata read did not replace the unknown cache entry");
  } finally {
    await watcher.close();
  }
});

test("a failed focused read of a title change emits a hint and marks its metadata unknown", {
  timeout: 30_000,
}, async () => {
  let failNextRead = true;
  const fixture = await createFixture({
    records: { flaky: { title: "Flaky", status: "initial" } },
    watchedResources: (store) => new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getResourceMetadata") {
          return async (uri: string) => {
            if (uri === "autofile:///records/tasks/flaky" && failNextRead) {
              failNextRead = false;
              throw new Error("metadata temporarily unavailable");
            }
            return await target.getResourceMetadata(uri);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  });
  const { changes, dataFolder, errors, watcher } = fixture;
  const path = join(dataFolder, "records", "tasks", "flaky.json");
  try {
    let start = changes.changes.length;
    await writeFile(path, storedRecord("First title", "complete", 1));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/flaky",
      kind: "changed",
      listChanged: true,
    }], "a failed title read suppressed its resource-list hint");
    assert.deepEqual(errors.map(({ message }) => message), ["metadata temporarily unavailable"]);

    start = changes.changes.length;
    await writeFile(path, storedRecord("Second title", "archived", 2));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/flaky",
      kind: "changed",
      listChanged: true,
    }], "the next successful read did not replace the unknown cache entry");
  } finally {
    await watcher.close();
  }
});

test("a deletion after a failed focused read still emits a hint", {
  timeout: 30_000,
}, async () => {
  let failNextRead = true;
  const fixture = await createFixture({
    records: { doomed: { title: "Doomed", status: "initial" } },
    watchedResources: (store) => new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getResourceMetadata") {
          return async (uri: string) => {
            if (uri === "autofile:///records/tasks/doomed" && failNextRead) {
              failNextRead = false;
              throw new Error("metadata temporarily unavailable");
            }
            return await target.getResourceMetadata(uri);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  });
  const { changes, dataFolder, errors, watcher } = fixture;
  const path = join(dataFolder, "records", "tasks", "doomed.json");
  try {
    let start = changes.changes.length;
    await writeFile(path, storedRecord("Changed title", "complete", 1));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/doomed",
      kind: "changed",
      listChanged: true,
    }], "the failed focused read suppressed its resource hint");
    assert.deepEqual(errors.map(({ message }) => message), ["metadata temporarily unavailable"]);

    start = changes.changes.length;
    await unlink(path);
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/doomed",
      kind: "deleted",
      listChanged: true,
    }], "deletion after a failed focused read was not reported");
  } finally {
    await watcher.close();
  }
});

test("a failed declaration read emits a hint and marks that type's metadata unknown", {
  timeout: 30_000,
}, async () => {
  let failNextRead = true;
  const fixture = await createFixture({
    records: { flaky: { title: "Flaky", status: "initial" } },
    watchedResources: (store) => new Proxy(store, {
      get(target, property, receiver) {
        if (property === "listTypeResources") {
          return async (type: string) => {
            if (type === "tasks" && failNextRead) {
              failNextRead = false;
              throw new Error("type metadata temporarily unavailable");
            }
            return await target.listTypeResources(type);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  });
  const { changes, errors, store, watcher } = fixture;
  try {
    let start = changes.changes.length;
    await store.updateType({ type: "tasks", titleField: "status" });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/tasks",
      kind: "changed",
      listChanged: true,
    }], "a failed type metadata read suppressed the declaration hint");
    assert.deepEqual(
      errors.map(({ message }) => message),
      ["type metadata temporarily unavailable"],
    );

    start = changes.changes.length;
    await store.updateType({ type: "tasks", titleField: "title" });
    await waitForChanges(changes, start, [{
      uri: "autofile:///types/tasks",
      kind: "changed",
      listChanged: true,
    }], "the next successful type read did not replace the unknown cache entries", waitTimeoutMs, true);
  } finally {
    await watcher.close();
  }
});

test("the watcher ignores every path Autofile does not read", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture();
  const { changes, dataFolder, errors, watcher } = fixture;
  try {
    await Promise.all([
      mkdir(join(dataFolder, "records", "tasks", "nested"), { recursive: true }),
      mkdir(join(dataFolder, "records", "undeclared"), { recursive: true }),
      mkdir(join(dataFolder, "blobs"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(dirname(dataFolder), "outside.json"), "ignored"),
      writeFile(join(dataFolder, ".DS_Store"), "ignored"),
      writeFile(join(dataFolder, "types", "broken.json"), "{\n"),
      writeFile(join(dataFolder, "records", "tasks", ".draft.json"), storedRecord("Draft", "active")),
      writeFile(join(dataFolder, "records", "tasks", "Upper.json"), storedRecord("Upper", "active")),
      writeFile(join(dataFolder, "records", "tasks", "broken.json"), "{\n"),
      writeFile(join(dataFolder, "records", "tasks", "notes.txt"), "ignored"),
      writeFile(join(dataFolder, "records", "tasks", "nested", "extra.json"), storedRecord("Extra", "active")),
      writeFile(join(dataFolder, "records", "undeclared", "orphan.json"), storedRecord("Orphan", "active")),
      writeFile(join(dataFolder, "blobs", "not-a-hash.txt"), "ignored"),
    ]);

    const start = changes.changes.length;
    await writeFile(join(dataFolder, "records", "tasks", "sentinel.json"), storedRecord("Sentinel", "active"));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/sentinel",
      kind: "created",
      listChanged: true,
    }], "the sentinel resource was not reported after ignored files");
    const ignoredUris = new Set([
      "autofile:///records/tasks/.draft",
      "autofile:///records/tasks/Upper",
      "autofile:///records/tasks/broken",
      "autofile:///records/tasks/notes",
      "autofile:///records/tasks/nested/extra",
      "autofile:///records/undeclared/orphan",
      "autofile:///types/broken",
      "autofile:///blobs/not-a-hash.txt",
    ]);
    assert.equal(
      changes.changes.some(({ uri }) => ignoredUris.has(uri)),
      false,
      `ignored files produced changes: ${JSON.stringify(changes.changes)}`,
    );
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
});

test("a declaration changes whether pre-existing record files appear in the resource list", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    recordFiles: {
      alpha: { title: "Alpha", status: "active" },
      bravo: { title: "Bravo", status: "active" },
    },
    types: [],
  });
  const { changes, dataFolder, store, watcher } = fixture;
  try {
    let start = changes.changes.length;
    await store.createType({
      type: "tasks",
      description: "Tasks.",
      titleField: "title",
      schema: taskSchema,
    });
    await waitForChanges(changes, start, [
      { uri: "autofile:///types/tasks", kind: "created", listChanged: true },
      { uri: "autofile:///records/tasks/alpha", kind: "created", listChanged: true },
      { uri: "autofile:///records/tasks/bravo", kind: "created", listChanged: true },
    ], "declaration creation did not report the records that became resources");
    assert.deepEqual(
      (await store.listResources()).filter(({ uri }) => uri.startsWith("autofile:///records/tasks/"))
        .map(({ uri }) => uri),
      ["autofile:///records/tasks/alpha", "autofile:///records/tasks/bravo"],
    );

    start = changes.changes.length;
    await unlink(join(dataFolder, "types", "tasks.json"));
    await waitForChanges(changes, start, [
      { uri: "autofile:///types/tasks", kind: "deleted", listChanged: true },
      { uri: "autofile:///records/tasks/alpha", kind: "deleted", listChanged: true },
      { uri: "autofile:///records/tasks/bravo", kind: "deleted", listChanged: true },
    ], "declaration deletion did not report the records that stopped being resources");
    assert.deepEqual(
      (await store.listResources()).filter(({ uri }) => uri.startsWith("autofile:///records/tasks/")),
      [],
    );
  } finally {
    await watcher.close();
  }
});

test("a burst of many resources is reported without another whole-store scan", {
  timeout: 30_000,
}, async () => {
  let listResourcesCalls = 0;
  const fixture = await createFixture({
    records: { atomic: { title: "Atomic", status: "initial" } },
    watchedResources: (store) => new Proxy(store, {
      get(target, property, receiver) {
        if (property === "listResources") {
          return async () => {
            listResourcesCalls += 1;
            return await target.listResources();
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  });
  const { changes, dataFolder, store, watcher } = fixture;
  const restoredKeys = Array.from({ length: 24 }, (_, index) => `restored-${String(index)}`);
  const declarationTypes = Array.from({ length: 8 }, (_, index) => `burst-${String(index)}`);
  try {
    assert.equal(listResourcesCalls, 1);
    await Promise.all(restoredKeys.map(async (key, index) => {
      await writeFile(
        join(dataFolder, "records", "tasks", `${key}.json`),
        storedRecord(`Restored ${String(index)}`, "active", index),
      );
    }));
    await waitForChanges(changes, 0, restoredKeys.map((key) => ({
      uri: `autofile:///records/tasks/${key}`,
      kind: "created" as const,
      listChanged: true,
    })), "a burst of restored resources was not fully reported");

    let start = changes.changes.length;
    await Promise.all(declarationTypes.map(async (type) => {
      await writeFile(
        join(dataFolder, "types", `${type}.json`),
        storedDeclaration(`${type} records.`),
      );
    }));
    await waitForChanges(changes, start, declarationTypes.map((type) => ({
      uri: `autofile:///types/${type}`,
      kind: "created" as const,
      listChanged: true,
    })), "a burst of declarations was not fully reported");

    start = changes.changes.length;
    await Promise.all(declarationTypes.map(async (type) => {
      await unlink(join(dataFolder, "types", `${type}.json`));
    }));
    await waitForChanges(changes, start, declarationTypes.map((type) => ({
      uri: `autofile:///types/${type}`,
      kind: "deleted" as const,
      listChanged: true,
    })), "a burst of declaration deletions was not fully reported");

    start = changes.changes.length;
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await store.updateRecord({
        uri: "autofile:///records/tasks/atomic",
        patch: { status: `replacement-${String(index)}` },
      });
    }));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/atomic",
      kind: "changed",
      listChanged: false,
    }], "repeated atomic replacements did not produce a settled resource hint");

    await writeFile(join(dataFolder, "records", "tasks", "ephemeral.json"), storedRecord("Gone", "soon"));
    await unlink(join(dataFolder, "records", "tasks", "ephemeral.json"));
    start = changes.changes.length;
    await writeFile(join(dataFolder, "records", "tasks", "after-burst.json"), storedRecord("After", "active"));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/after-burst",
      kind: "created",
      listChanged: true,
    }], "watching did not continue after a rapid create and delete", waitTimeoutMs, true);
    assert.equal(listResourcesCalls, 1, "the burst triggered another whole-store scan");
  } finally {
    await watcher.close();
  }
});

test("the watcher resumes after a type folder is deleted and recreated", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    records: {
      alpha: { title: "Alpha", status: "active" },
      bravo: { title: "Bravo", status: "active" },
    },
  });
  const { changes, dataFolder, watcher } = fixture;
  try {
    let start = changes.changes.length;
    await rm(join(dataFolder, "records", "tasks"), { recursive: true });
    await waitForChanges(changes, start, ["alpha", "bravo"].map((key) => ({
      uri: `autofile:///records/tasks/${key}`,
      kind: "deleted" as const,
      listChanged: true,
    })), "type-folder deletion did not report its records");

    start = changes.changes.length;
    await mkdir(join(dataFolder, "records", "tasks"));
    await writeFile(join(dataFolder, "records", "tasks", "reborn.json"), storedRecord("Reborn", "active"));
    await waitForChanges(changes, start, [{
      uri: "autofile:///records/tasks/reborn",
      kind: "created",
      listChanged: true,
    }], "the recreated type folder was no longer watched");
  } finally {
    await watcher.close();
  }
});

test("the watcher resumes after the data folder is deleted and recreated", {
  timeout: 30_000,
}, async () => {
  const fixture = await createFixture({
    records: { existing: { title: "Existing", status: "active" } },
  });
  const { changes, dataFolder, errors, store, watcher } = fixture;
  try {
    let start = changes.changes.length;
    await rm(dataFolder, { recursive: true });
    await waitForChanges(changes, start, [
      { uri: "autofile:///types/tasks", kind: "deleted", listChanged: true },
      { uri: "autofile:///records/tasks/existing", kind: "deleted", listChanged: true },
    ], "data-folder deletion did not report its resources");

    start = changes.changes.length;
    await store.createType({
      type: "reborn",
      description: "Recreated data.",
      titleField: "title",
      schema: taskSchema,
    });
    await store.createRecord({
      type: "reborn",
      key: "new",
      record: { title: "New", status: "active" },
    });
    await waitForChanges(changes, start, [
      { uri: "autofile:///types/reborn", kind: "created", listChanged: true },
      { uri: "autofile:///records/reborn/new", kind: "created", listChanged: true },
    ], "notices stopped after data-folder recreation");
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
});
