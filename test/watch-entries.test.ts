/** Change subscriptions recognize the same regular files as public reads. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { Autofile, type ChangeEvent } from "@telepath-computer/autofile";

const definition = { description: "Tasks.", schema: { type: "object" } };
const record = JSON.stringify({
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  value: {},
});

async function fixture(): Promise<{ root: string; folder: string; store: Autofile }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-watch-entries-"));
  const previousHome = process.env.AUTOFILE_HOME;
  process.env.AUTOFILE_HOME = join(root, "home");
  const folder = join(root, "data");
  const store = new Autofile({ folder });
  if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
  else process.env.AUTOFILE_HOME = previousHome;
  await store.types.create("tasks", definition);
  return { root, folder, store };
}

async function waitForChange(changes: ChangeEvent[], expected: ChangeEvent): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!changes.some(({ uri, kind }) => uri === expected.uri && kind === expected.kind)) {
    if (Date.now() >= deadline) assert.fail(`Missing ${JSON.stringify(expected)}: ${JSON.stringify(changes)}`);
    await delay(20);
  }
}

test("watch ignores record and declaration symlink creation, replacement, and removal", {
  timeout: 15_000,
}, async () => {
  const { root, folder, store } = await fixture();
  const changes: ChangeEvent[] = [];
  const errors: Error[] = [];
  try {
    for (const name of ["first", "second"]) {
      await writeFile(join(root, `${name}-record.json`), record);
      await writeFile(join(root, `${name}-type.json`), JSON.stringify(definition));
    }
    await store.watch((batch) => { changes.push(...batch); }, { onError: (error) => { errors.push(error); } });
    const linkedRecord = join(folder, "tasks", "linked.json");
    const linkedType = join(folder, "_types", "linked.json");
    await symlink(join(root, "first-record.json"), linkedRecord);
    await symlink(join(root, "first-type.json"), linkedType);
    await delay(400);
    assert.equal(await store.records.get("autofile:///tasks/linked"), undefined);
    assert.equal(await store.types.get("linked"), undefined);
    assert.deepEqual(changes, [], "symlink creation produced public changes");

    for (const [target, path] of [["second-record.json", linkedRecord], ["second-type.json", linkedType]] as const) {
      const replacement = join(root, "replacement");
      await symlink(join(root, target), replacement);
      await rename(replacement, path);
    }
    await delay(400);
    assert.deepEqual(changes, [], "symlink replacement produced public changes");
    await unlink(linkedRecord);
    await unlink(linkedType);
    await delay(400);
    assert.deepEqual(changes, [], "symlink removal produced public changes");

    const regular = await store.records.create("tasks", {}, { key: "regular" });
    await waitForChange(changes, { uri: regular.uri, kind: "created" });
    await store.records.delete(regular.uri);
    await waitForChange(changes, { uri: regular.uri, kind: "deleted" });
    assert.deepEqual(changes, [
      { uri: regular.uri, kind: "created" },
      { uri: regular.uri, kind: "deleted" },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("watch never reports initially ignored entries when their type folder is removed", {
  timeout: 10_000,
}, async () => {
  const { root, folder, store } = await fixture();
  const changes: ChangeEvent[] = [];
  try {
    await writeFile(join(root, "record.json"), record);
    await symlink(join(root, "record.json"), join(folder, "tasks", "linked.json"));
    await mkdir(join(folder, "tasks", "directory.json"));
    const existing = await store.records.create("tasks", {}, { key: "existing" });
    await store.watch((batch) => { changes.push(...batch); });
    await rm(join(folder, "tasks"), { recursive: true });
    await waitForChange(changes, { uri: existing.uri, kind: "deleted" });
    await delay(400);
    assert.deepEqual(changes, [{ uri: existing.uri, kind: "deleted" }]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a recognized record or declaration with a symlink reports its deletion", {
  timeout: 10_000,
}, async () => {
  const { root, folder, store } = await fixture();
  const changes: ChangeEvent[] = [];
  try {
    const existing = await store.records.create("tasks", {}, { key: "existing" });
    await writeFile(join(root, "record.json"), record);
    await writeFile(join(root, "type.json"), JSON.stringify(definition));
    await store.watch((batch) => { changes.push(...batch); });
    const recordReplacement = join(root, "record-replacement");
    await symlink(join(root, "record.json"), recordReplacement);
    await rename(recordReplacement, join(folder, "tasks", "existing.json"));
    await waitForChange(changes, { uri: existing.uri, kind: "deleted" });
    assert.equal(await store.records.get(existing.uri), undefined);

    const declarationReplacement = join(root, "type-replacement");
    await symlink(join(root, "type.json"), declarationReplacement);
    await rename(declarationReplacement, join(folder, "_types", "tasks.json"));
    await waitForChange(changes, { uri: "autofile:///_types/tasks", kind: "deleted" });
    assert.equal(await store.types.get("tasks"), undefined);
    assert.deepEqual(changes, [
      { uri: existing.uri, kind: "deleted" },
      { uri: "autofile:///_types/tasks", kind: "deleted" },
    ]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing ignored symlinks with regular files starts record and declaration monitoring", {
  timeout: 15_000,
}, async () => {
  const { root, folder, store } = await fixture();
  const changes: ChangeEvent[] = [];
  const errors: Error[] = [];
  const entries = [
    { path: join(folder, "tasks", "linked.json"), content: record, uri: "autofile:///tasks/linked" },
    { path: join(folder, "_types", "linked.json"), content: JSON.stringify(definition), uri: "autofile:///_types/linked" },
  ];
  try {
    await writeFile(join(root, "target.json"), "{}");
    for (const entry of entries) await symlink(join(root, "target.json"), entry.path);
    await store.watch((batch) => { changes.push(...batch); }, { onError: (error) => { errors.push(error); } });

    for (const entry of entries) {
      const replacement = join(root, "regular.json");
      await writeFile(replacement, entry.content);
      await rename(replacement, entry.path);
      await waitForChange(changes, { uri: entry.uri, kind: "created" });
      await writeFile(entry.path, `${entry.content}\n`);
      await waitForChange(changes, { uri: entry.uri, kind: "changed" });
    }
    assert.notEqual(await store.records.get("autofile:///tasks/linked"), undefined);
    assert.notEqual(await store.types.get("linked"), undefined);
    assert.deepEqual(errors, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
