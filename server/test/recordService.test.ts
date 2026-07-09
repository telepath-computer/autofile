import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { createRecordService, type RecordService } from "../src/recordService.js";

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "autofile-vault-"));
}

describe("record service", () => {
  let root: string;
  let outsideRoot: string;
  let service: RecordService;

  before(async () => {
    root = await makeVault();
    outsideRoot = await makeVault();

    await mkdir(path.join(root, "tasks"));
    await writeFile(
      path.join(root, "tasks", "alpha.md"),
      "---\ntitle: Alpha task\ncreated_at: 2026-07-06\nproject: \"[[projects/x]]\"\n---\nAlpha body.\n"
    );
    await writeFile(path.join(root, "tasks", "bare.md"), "Just a body, no frontmatter.\n");
    await writeFile(path.join(root, "tasks", "broken.md"), "---\ntitle: [unclosed\n---\nBody.\n");
    await writeFile(path.join(root, "tasks", "zulu.md"), "---\ntitle: Zulu\n---\n");
    await writeFile(path.join(root, "tasks", "_draft.md"), "---\ntitle: Draft\n---\n");
    await writeFile(path.join(root, "tasks", ".hidden.md"), "---\ntitle: Hidden\n---\n");
    await writeFile(path.join(root, "tasks", "notes.txt"), "not markdown\n");
    await mkdir(path.join(root, "tasks", "nested"));
    await writeFile(path.join(root, "tasks", "nested", "deep.md"), "---\ntitle: Deep\n---\n");

    await mkdir(path.join(root, "empty"));

    await writeFile(path.join(outsideRoot, "secret.md"), "---\ntitle: Secret\n---\nOutside.\n");
    await symlink(path.join(outsideRoot, "secret.md"), path.join(root, "tasks", "escape.md"));
    await symlink(outsideRoot, path.join(root, "linked"));

    // A type folder with per-file fs failure modes: a symlink loop (real fs
    // error on resolve) and a dangling symlink (stand-in for a delete race).
    await mkdir(path.join(root, "flaky"));
    await writeFile(path.join(root, "flaky", "good.md"), "---\ntitle: Good\n---\nStill fine.\n");
    await symlink(path.join(root, "flaky", "loop.md"), path.join(root, "flaky", "loop.md"));
    await symlink(path.join(root, "flaky", "no-such-target.md"), path.join(root, "flaky", "dangling.md"));
    // Self-referencing anchors parse to a circular object that JSON cannot
    // serialize; it must surface as a parse error, not crash the response.
    await writeFile(path.join(root, "flaky", "circular.md"), "---\na: &x\n  self: *x\n---\nBody.\n");

    service = await createRecordService([{ name: "main", root }]);
  });

  describe("createRecordService", () => {
    it("rejects a vault path that does not resolve to a real directory", async () => {
      await assert.rejects(
        createRecordService([{ name: "bad", root: path.join(root, "no-such-dir") }]),
        /bad/
      );
      await assert.rejects(
        createRecordService([{ name: "bad", root: path.join(root, "tasks", "alpha.md") }]),
        /directory/i
      );
    });
  });

  describe("listRecords", () => {
    it("returns full records sorted byte-wise by id, hiding _/. prefixed, non-md, nested, and escaping files", async () => {
      const result = await service.listRecords("main", "tasks");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.deepEqual(
        result.collection.records.map((record) => record.id),
        ["tasks/alpha", "tasks/bare", "tasks/zulu"]
      );

      const alpha = result.collection.records[0];
      assert.equal(alpha.type, "tasks");
      assert.deepEqual(alpha.properties, {
        title: "Alpha task",
        created_at: "2026-07-06",
        project: "[[projects/x]]"
      });
      assert.equal(alpha.body, "Alpha body.\n");
      assert.match(alpha.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("orders by id byte-wise, not by filename: a prefix slug sorts before its extension", async () => {
      await mkdir(path.join(root, "sort"));
      await writeFile(path.join(root, "sort", "a.b.md"), "x\n");
      await writeFile(path.join(root, "sort", "a.md"), "y\n");

      const result = await service.listRecords("main", "sort");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      // Filename order would put "a.b.md" before "a.md"; id order is the reverse.
      assert.deepEqual(
        result.collection.records.map((record) => record.id),
        ["sort/a", "sort/a.b"]
      );
    });

    it("returns properties {} for a record with no frontmatter", async () => {
      const result = await service.listRecords("main", "tasks");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      const bare = result.collection.records.find((record) => record.id === "tasks/bare");
      assert.ok(bare);
      assert.deepEqual(bare.properties, {});
      assert.equal(bare.body, "Just a body, no frontmatter.\n");
    });

    it("reports unparseable files in errors with the .md path, without failing the collection", async () => {
      const result = await service.listRecords("main", "tasks");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.ok(result.collection.errors);
      assert.equal(result.collection.errors.length, 1);
      assert.equal(result.collection.errors[0].path, "tasks/broken.md");
      assert.ok(result.collection.errors[0].message.length > 0);
    });

    it("omits the errors field when every file parses", async () => {
      const result = await service.listRecords("main", "empty");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.deepEqual(result.collection, { records: [] });
      assert.equal("errors" in result.collection, false);
    });

    it("degrades per record: fs errors become error entries, vanished files are skipped", async () => {
      const result = await service.listRecords("main", "flaky");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.deepEqual(
        result.collection.records.map((record) => record.id),
        ["flaky/good"]
      );
      assert.deepEqual(result.collection.errors?.map((error) => error.path), [
        "flaky/circular.md",
        "flaky/loop.md"
      ]);
      assert.ok(result.collection.errors?.every((error) => error.message.length > 0));
    });

    it("returns notFound for a type folder that does not exist", async () => {
      assert.deepEqual(await service.listRecords("main", "no-such-type"), { kind: "notFound" });
    });

    it("returns notFound for a type folder symlinked outside the vault", async () => {
      assert.deepEqual(await service.listRecords("main", "linked"), { kind: "notFound" });
    });

    it("returns unknownVault for an unregistered vault", async () => {
      assert.deepEqual(await service.listRecords("nope", "tasks"), { kind: "unknownVault" });
    });

    it("rejects invalid type segments", async () => {
      for (const type of ["", ".", "..", "a/b", "a\\b", ".hidden", "_private"]) {
        const result = await service.listRecords("main", type);
        assert.equal(result.kind, "invalidSegment", JSON.stringify(type));
      }
    });
  });

  describe("getRecord", () => {
    it("returns the record with id, type, properties, body, and ISO mtime", async () => {
      const result = await service.getRecord("main", "tasks", "alpha");

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.equal(result.record.id, "tasks/alpha");
      assert.equal(result.record.type, "tasks");
      assert.equal(result.record.properties.title, "Alpha task");
      assert.equal(result.record.properties.created_at, "2026-07-06");
      assert.equal(result.record.body, "Alpha body.\n");
      assert.match(result.record.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("returns notFound for a missing record", async () => {
      assert.deepEqual(await service.getRecord("main", "tasks", "missing"), { kind: "notFound" });
    });

    it("returns notFound for a record symlinked outside the vault", async () => {
      assert.deepEqual(await service.getRecord("main", "tasks", "escape"), { kind: "notFound" });
    });

    it("returns notFound for a record whose file has vanished (dangling symlink)", async () => {
      assert.deepEqual(await service.getRecord("main", "flaky", "dangling"), { kind: "notFound" });
    });

    it("returns parseError with an Error body for a record that cannot be read", async () => {
      const result = await service.getRecord("main", "flaky", "loop");

      assert.equal(result.kind, "parseError");
      if (result.kind !== "parseError") return;
      assert.equal(result.error.path, "flaky/loop.md");
      assert.ok(result.error.message.length > 0);
    });

    it("returns parseError for frontmatter with circular YAML anchors", async () => {
      const result = await service.getRecord("main", "flaky", "circular");

      assert.equal(result.kind, "parseError");
      if (result.kind !== "parseError") return;
      assert.equal(result.error.path, "flaky/circular.md");
      assert.ok(result.error.message.length > 0);
    });

    it("returns parseError with the .md path for an unparseable record", async () => {
      const result = await service.getRecord("main", "tasks", "broken");

      assert.equal(result.kind, "parseError");
      if (result.kind !== "parseError") return;
      assert.equal(result.error.path, "tasks/broken.md");
      assert.ok(result.error.message.length > 0);
    });

    it("rejects a slug ending in .md", async () => {
      const result = await service.getRecord("main", "tasks", "alpha.md");
      assert.equal(result.kind, "invalidSegment");
    });

    it("rejects invalid slug segments", async () => {
      for (const slug of ["", ".", "..", "a/b", "a\\b", ".hidden", "_draft"]) {
        const result = await service.getRecord("main", "tasks", slug);
        assert.equal(result.kind, "invalidSegment", JSON.stringify(slug));
      }
    });

    it("returns unknownVault for an unregistered vault", async () => {
      assert.deepEqual(await service.getRecord("nope", "tasks", "alpha"), { kind: "unknownVault" });
    });
  });

  describe("putRecord", () => {
    it("creates a new record and returns it with server-computed fields", async () => {
      const result = await service.putRecord("main", "tasks", "created-by-put", {
        properties: { title: "New task", created_at: "2026-07-08" },
        body: "New body.\n"
      });

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.equal(result.created, true);
      assert.equal(result.record.id, "tasks/created-by-put");
      assert.equal(result.record.type, "tasks");
      assert.deepEqual(result.record.properties, { title: "New task", created_at: "2026-07-08" });
      assert.equal(result.record.body, "New body.\n");
      assert.match(result.record.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const written = await readFile(path.join(root, "tasks", "created-by-put.md"), "utf8");
      assert.match(written, /^---\n/);
      assert.match(written, /title: New task/);
      assert.match(written, /New body\./);
    });

    it("replaces an existing record and round-trips through getRecord", async () => {
      const first = await service.putRecord("main", "tasks", "replace-me", {
        properties: { title: "First" },
        body: "First body.\n"
      });
      assert.equal(first.kind, "ok");
      if (first.kind !== "ok") return;
      assert.equal(first.created, true);

      const second = await service.putRecord("main", "tasks", "replace-me", {
        properties: { title: "Second", status: "done" },
        body: "Second body.\n"
      });
      assert.equal(second.kind, "ok");
      if (second.kind !== "ok") return;
      assert.equal(second.created, false);

      const readBack = await service.getRecord("main", "tasks", "replace-me");
      assert.equal(readBack.kind, "ok");
      if (readBack.kind !== "ok") return;
      assert.deepEqual(readBack.record.properties, { title: "Second", status: "done" });
      assert.equal(readBack.record.body, "Second body.\n");
    });

    it("auto-creates a missing type folder", async () => {
      const result = await service.putRecord("main", "brand-new-type", "first", {
        properties: { title: "First of type" },
        body: "Body.\n"
      });

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.equal(result.created, true);

      const listed = await service.listRecords("main", "brand-new-type");
      assert.equal(listed.kind, "ok");
      if (listed.kind !== "ok") return;
      assert.deepEqual(listed.collection.records.map((record) => record.id), ["brand-new-type/first"]);
    });

    it("writes empty properties as a file with no frontmatter block", async () => {
      const result = await service.putRecord("main", "tasks", "no-props", {
        properties: {},
        body: "Only a body.\n"
      });

      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.deepEqual(result.record.properties, {});

      const written = await readFile(path.join(root, "tasks", "no-props.md"), "utf8");
      assert.equal(written, "Only a body.\n");
    });

    it("leaves the type folder containing exactly the expected files after writes", async () => {
      await service.putRecord("main", "tidy-type", "one", { properties: { a: 1 }, body: "b\n" });
      await service.putRecord("main", "tidy-type", "two", { properties: {}, body: "c\n" });
      await service.putRecord("main", "tidy-type", "one", { properties: { a: 2 }, body: "d\n" });

      const entries = await readdir(path.join(root, "tidy-type"));
      assert.deepEqual(entries.sort(), ["one.md", "two.md"]);
    });

    it("refuses when the type segment names an existing regular file", async () => {
      await writeFile(path.join(root, "occupied"), "a plain file where the type folder would go\n");

      const result = await service.putRecord("main", "occupied", "slug", {
        properties: {},
        body: "x\n"
      });

      assert.equal(result.kind, "refused");
      if (result.kind !== "refused") return;
      assert.ok(result.message.length > 0);
    });

    it("refuses to write through a type folder symlinked outside the vault", async () => {
      const result = await service.putRecord("main", "linked", "sneaky", {
        properties: {},
        body: "x\n"
      });
      assert.equal(result.kind, "refused");
      const outside = await readdir(outsideRoot);
      assert.equal(outside.includes("sneaky.md"), false);
    });

    it("rejects invalid segments and a slug ending in .md", async () => {
      const payload = { properties: {}, body: "x\n" };
      assert.equal((await service.putRecord("main", "..", "slug", payload)).kind, "invalidSegment");
      assert.equal((await service.putRecord("main", "_t", "slug", payload)).kind, "invalidSegment");
      assert.equal((await service.putRecord("main", "tasks", "slug.md", payload)).kind, "invalidSegment");
      assert.equal((await service.putRecord("main", "tasks", "a/b", payload)).kind, "invalidSegment");
    });

    it("returns unknownVault for an unregistered vault", async () => {
      const result = await service.putRecord("nope", "tasks", "x", { properties: {}, body: "" });
      assert.deepEqual(result, { kind: "unknownVault" });
    });
  });

  describe("write fidelity: PUT then GET round-trips byte-exact", () => {
    const cases: Array<{ name: string; slug: string; payload: { properties: Record<string, unknown>; body: string } }> = [
      {
        name: "body starting with --- and empty properties",
        slug: "rt-dashes-empty-props",
        payload: { properties: {}, body: "---\nnot: frontmatter\n---\nrest of body\n" }
      },
      {
        name: "body that is exactly --- with empty properties",
        slug: "rt-only-dashes",
        payload: { properties: {}, body: "---\n" }
      },
      {
        name: "body with no trailing newline",
        slug: "rt-no-trailing-newline",
        payload: { properties: { title: "T" }, body: "no trailing newline" }
      },
      {
        name: "empty body with non-empty properties",
        slug: "rt-empty-body",
        payload: { properties: { title: "T" }, body: "" }
      },
      {
        name: "empty body with empty properties",
        slug: "rt-all-empty",
        payload: { properties: {}, body: "" }
      },
      {
        name: "body containing --- lines with non-empty properties",
        slug: "rt-dashes-inside",
        payload: { properties: { title: "T", n: 3 }, body: "before\n---\nafter\n" }
      },
      {
        name: "body without trailing newline and empty properties",
        slug: "rt-bare-no-newline",
        payload: { properties: {}, body: "bare body, no newline" }
      }
    ];

    for (const { name, slug, payload } of cases) {
      it(`round-trips ${name}`, async () => {
        const put = await service.putRecord("main", "roundtrip", slug, payload);

        assert.equal(put.kind, "ok");
        if (put.kind !== "ok") return;
        assert.deepEqual(put.record.properties, payload.properties);
        assert.equal(put.record.body, payload.body);

        const get = await service.getRecord("main", "roundtrip", slug);
        assert.equal(get.kind, "ok");
        if (get.kind !== "ok") return;
        assert.deepEqual(get.record.properties, payload.properties);
        assert.equal(get.record.body, payload.body);
      });
    }

    it("writes a bare body byte-exact when omitting the frontmatter block is safe", async () => {
      await service.putRecord("main", "roundtrip", "rt-plain", {
        properties: {},
        body: "plain body\n"
      });
      assert.equal(await readFile(path.join(root, "roundtrip", "rt-plain.md"), "utf8"), "plain body\n");
    });
  });
});
