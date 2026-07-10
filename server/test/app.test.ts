import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";

import { createApp } from "../src/app.js";
import { createRecordService } from "../src/recordService.js";

async function listen(app: ReturnType<typeof createApp>): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

// fetch() normalizes %2E%2E to ".." and collapses it client-side, so traversal
// paths must be sent raw for the server-side rejection to be exercised.
function rawGetStatus(baseUrl: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path: rawPath, method: "GET" }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

function sendJson(method: "PUT" | "PATCH", url: string, body: unknown, headers: Record<string, string> = {}): Promise<globalThis.Response> {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function putJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<globalThis.Response> {
  return sendJson("PUT", url, body, headers);
}

function patchJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<globalThis.Response> {
  return sendJson("PATCH", url, body, headers);
}

describe("autofile-server HTTP app", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "autofile-app-"));
    await mkdir(path.join(root, "tasks"));
    await writeFile(
      path.join(root, "tasks", "alpha.md"),
      "---\ntitle: Alpha\ncreated_at: 2026-07-06\n---\nAlpha body.\n"
    );
    await writeFile(path.join(root, "tasks", "bare.md"), "No frontmatter here.\n");
    await writeFile(path.join(root, "tasks", "broken.md"), "---\ntitle: [unclosed\n---\nBody.\n");
    await mkdir(path.join(root, "empty"));

    const recordService = await createRecordService([{ name: "main", root }]);
    ({ baseUrl, server } = await listen(createApp({ recordService })));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  describe("GET /vaults/<vault>/records/<type>", () => {
    it("returns the collection as JSON with CORS, sorted by id, with parse errors reported", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/tasks`);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.ok(response.headers.get("content-type")?.startsWith("application/json"));
      assert.equal(response.headers.get("etag"), null);

      const collection = await response.json();
      assert.deepEqual(collection.records.map((record: { id: string }) => record.id), [
        "tasks/alpha",
        "tasks/bare"
      ]);
      assert.equal(collection.records[0].type, "tasks");
      assert.equal(collection.records[0].properties.created_at, "2026-07-06");
      assert.equal(collection.records[0].body, "Alpha body.\n");
      assert.deepEqual(collection.records[1].properties, {});
      assert.equal(collection.errors.length, 1);
      assert.equal(collection.errors[0].path, "tasks/broken.md");
      assert.ok(collection.errors[0].message.length > 0);
    });

    it("returns {records: []} without errors for an existing empty type folder", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/empty`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { records: [] });
    });

    it("returns 404 for a type folder that does not exist", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/no-such-type`);

      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(typeof body.message, "string");
    });

    it("returns 400 for invalid type segments", async () => {
      for (const type of ["_private", ".hidden", "a%2Fb", "a%5Cb"]) {
        const response = await fetch(`${baseUrl}/vaults/main/records/${type}`);
        assert.equal(response.status, 400, type);
        assert.ok(response.headers.get("content-type")?.startsWith("application/json"), type);
        const body = await response.json();
        assert.equal(typeof body.message, "string", type);
      }
      assert.equal(await rawGetStatus(baseUrl, "/vaults/main/records/%2E%2E"), 400);
    });

    it("returns 400 for malformed percent-encoding in a segment", async () => {
      assert.equal(await rawGetStatus(baseUrl, "/vaults/main/records/%zz"), 400);
    });
  });

  describe("GET /vaults/<vault>/records/<type>/<slug>", () => {
    it("returns a single record", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/tasks/alpha`);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const record = await response.json();
      assert.equal(record.id, "tasks/alpha");
      assert.equal(record.type, "tasks");
      assert.deepEqual(record.properties, { title: "Alpha", created_at: "2026-07-06" });
      assert.equal(record.body, "Alpha body.\n");
      assert.match(record.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("returns 404 for a missing record", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/tasks/missing`);
      assert.equal(response.status, 404);
      assert.equal(typeof (await response.json()).message, "string");
    });

    it("returns 422 with an Error body for an unparseable record", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/tasks/broken`);

      assert.equal(response.status, 422);
      const body = await response.json();
      assert.equal(body.path, "tasks/broken.md");
      assert.ok(body.message.length > 0);
    });

    it("returns 400 for a slug ending in .md and other invalid slugs", async () => {
      for (const slug of ["alpha.md", "_x", ".x", "a%2Fb", "a%5Cb"]) {
        const response = await fetch(`${baseUrl}/vaults/main/records/tasks/${slug}`);
        assert.equal(response.status, 400, slug);
      }
      assert.equal(await rawGetStatus(baseUrl, "/vaults/main/records/tasks/%2E%2E"), 400);
    });
  });

  describe("PUT /vaults/<vault>/records/<type>/<slug>", () => {
    it("creates a record with 201 and returns the resulting Record", async () => {
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/new-one`, {
        properties: { title: "New", created_at: "2026-07-08" },
        body: "New body.\n"
      });

      assert.equal(response.status, 201);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const record = await response.json();
      assert.equal(record.id, "tasks/new-one");
      assert.equal(record.type, "tasks");
      assert.deepEqual(record.properties, { title: "New", created_at: "2026-07-08" });
      assert.equal(record.body, "New body.\n");
      assert.match(record.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const readBack = await fetch(`${baseUrl}/vaults/main/records/tasks/new-one`);
      assert.equal(readBack.status, 200);
      assert.deepEqual((await readBack.json()).properties, { title: "New", created_at: "2026-07-08" });
    });

    it("replaces an existing record with 200", async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/twice`, {
        properties: { title: "First" },
        body: "One.\n"
      });
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/twice`, {
        properties: { title: "Second" },
        body: "Two.\n"
      });

      assert.equal(response.status, 200);
      const record = await response.json();
      assert.deepEqual(record.properties, { title: "Second" });
      assert.equal(record.body, "Two.\n");
    });

    it("auto-creates a missing type folder", async () => {
      const response = await putJson(`${baseUrl}/vaults/main/records/fresh-type/first`, {
        properties: {},
        body: "Hello.\n"
      });

      assert.equal(response.status, 201);
      const listed = await fetch(`${baseUrl}/vaults/main/records/fresh-type`);
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).records.map((record: { id: string }) => record.id), [
        "fresh-type/first"
      ]);
    });

    it("rejects a request without Content-Type: application/json", async () => {
      const noHeader = await fetch(`${baseUrl}/vaults/main/records/tasks/x`, {
        method: "PUT",
        body: JSON.stringify({ properties: {}, body: "" })
      });
      const wrongHeader = await fetch(`${baseUrl}/vaults/main/records/tasks/x`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ properties: {}, body: "" })
      });

      assert.equal(noHeader.status, 400);
      assert.equal(wrongHeader.status, 400);
    });

    it("rejects malformed JSON with a JSON error body", async () => {
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/x`, "{not json");

      assert.equal(response.status, 400);
      assert.ok(response.headers.get("content-type")?.startsWith("application/json"));
      assert.equal(typeof (await response.json()).message, "string");
    });

    it("rejects unknown top-level fields", async () => {
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/x`, {
        properties: {},
        body: "",
        mtime: "2026-01-01T00:00:00.000Z"
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /mtime/);
    });

    it("rejects missing or mistyped properties and body", async () => {
      const cases: unknown[] = [
        { body: "no properties" },
        { properties: {} },
        { properties: "not an object", body: "" },
        { properties: [], body: "" },
        { properties: {}, body: 42 },
        []
      ];
      for (const payload of cases) {
        const response = await putJson(`${baseUrl}/vaults/main/records/tasks/x`, payload);
        assert.equal(response.status, 400, JSON.stringify(payload));
      }
    });

    it("returns 400 for invalid segments on PUT", async () => {
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/bad.md`, {
        properties: {},
        body: ""
      });
      assert.equal(response.status, 400);
    });

    it("accepts request bodies well beyond express's 100kb default", async () => {
      const bigBody = "x".repeat(200 * 1024);
      const response = await putJson(`${baseUrl}/vaults/main/records/tasks/big-record`, {
        properties: { title: "Big" },
        body: bigBody
      });

      assert.equal(response.status, 201);
      assert.equal((await response.json()).body, bigBody);
    });

    it("returns a JSON error body when the body size limit fires", async () => {
      // A second app with a tiny limit, so the 413 path is exercised cheaply.
      const recordService = await createRecordService([{ name: "main", root }]);
      const small = await listen(createApp({ recordService, jsonBodyLimit: "1kb" }));
      try {
        const response = await putJson(`${small.baseUrl}/vaults/main/records/tasks/too-big`, {
          properties: {},
          body: "y".repeat(4 * 1024)
        });

        assert.equal(response.status, 413);
        assert.ok(response.headers.get("content-type")?.startsWith("application/json"));
        assert.equal(typeof (await response.json()).message, "string");
      } finally {
        small.server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          small.server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });

  describe("PATCH /vaults/<vault>/records/<type>/<slug>", () => {
    it("merges properties into an existing record and returns 200 with the result", async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/patch-merge`, {
        properties: { title: "Before", status: "available" },
        body: "Patch body.\n"
      });

      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/patch-merge`, {
        properties: { status: "done" }
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const record = await response.json();
      assert.equal(record.id, "tasks/patch-merge");
      assert.deepEqual(record.properties, { title: "Before", status: "done" });
      assert.equal(record.body, "Patch body.\n");
      assert.match(record.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const readBack = await fetch(`${baseUrl}/vaults/main/records/tasks/patch-merge`);
      assert.equal(readBack.status, 200);
      assert.deepEqual((await readBack.json()).properties, { title: "Before", status: "done" });
    });

    it('merges a property literally named "__proto__" end-to-end, and null deletes it', async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/patch-proto`, {
        properties: { title: "T" },
        body: ""
      });

      // Raw JSON string: a literal __proto__ key in a JS object would set the
      // prototype instead of surviving JSON.stringify as a data property.
      const response = await patchJson(
        `${baseUrl}/vaults/main/records/tasks/patch-proto`,
        '{"properties":{"__proto__":{"evil":1}}}'
      );

      assert.equal(response.status, 200);
      const record = await response.json();
      assert.deepEqual(Object.entries(record.properties), [
        ["title", "T"],
        ["__proto__", { evil: 1 }]
      ]);

      const readBack = await fetch(`${baseUrl}/vaults/main/records/tasks/patch-proto`);
      assert.equal(readBack.status, 200);
      assert.deepEqual(Object.entries((await readBack.json()).properties), [
        ["title", "T"],
        ["__proto__", { evil: 1 }]
      ]);

      const removed = await patchJson(
        `${baseUrl}/vaults/main/records/tasks/patch-proto`,
        '{"properties":{"__proto__":null}}'
      );
      assert.equal(removed.status, 200);
      assert.deepEqual(Object.entries((await removed.json()).properties), [["title", "T"]]);
    });

    it("removes a key set to null and never returns null property values", async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/patch-null`, {
        properties: { title: "T", status: "available" },
        body: ""
      });

      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/patch-null`, {
        properties: { status: null }
      });

      assert.equal(response.status, 200);
      const record = await response.json();
      assert.deepEqual(record.properties, { title: "T" });
    });

    it("replaces the body wholesale on a body-only patch", async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/patch-body`, {
        properties: { title: "Stays" },
        body: "Old.\n"
      });

      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/patch-body`, {
        body: "New.\n"
      });

      assert.equal(response.status, 200);
      const record = await response.json();
      assert.deepEqual(record.properties, { title: "Stays" });
      assert.equal(record.body, "New.\n");
    });

    it("returns the current record for an empty patch {}", async () => {
      await putJson(`${baseUrl}/vaults/main/records/tasks/patch-noop`, {
        properties: { title: "As is" },
        body: "Same.\n"
      });

      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/patch-noop`, {});

      assert.equal(response.status, 200);
      const record = await response.json();
      assert.deepEqual(record.properties, { title: "As is" });
      assert.equal(record.body, "Same.\n");
    });

    it("returns 404 for a missing record and does not create it", async () => {
      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/patch-missing`, {
        properties: { title: "Never lands" }
      });

      assert.equal(response.status, 404);
      assert.equal(typeof (await response.json()).message, "string");

      const readBack = await fetch(`${baseUrl}/vaults/main/records/tasks/patch-missing`);
      assert.equal(readBack.status, 404);
    });

    it("returns 422 with an Error body for an unparseable target", async () => {
      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/broken`, {
        properties: { title: "New" }
      });

      assert.equal(response.status, 422);
      const body = await response.json();
      assert.equal(body.path, "tasks/broken.md");
      assert.ok(body.message.length > 0);
    });

    it("rejects a request without Content-Type: application/json", async () => {
      const noHeader = await fetch(`${baseUrl}/vaults/main/records/tasks/alpha`, {
        method: "PATCH",
        body: JSON.stringify({})
      });
      const wrongHeader = await fetch(`${baseUrl}/vaults/main/records/tasks/alpha`, {
        method: "PATCH",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({})
      });

      assert.equal(noHeader.status, 400);
      assert.equal(wrongHeader.status, 400);
    });

    it("rejects unknown top-level fields", async () => {
      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/alpha`, {
        properties: {},
        mtime: "2026-01-01T00:00:00.000Z"
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /mtime/);
    });

    it("rejects mistyped properties and body", async () => {
      const cases: unknown[] = [
        { properties: "not an object" },
        { properties: [] },
        { properties: null },
        { body: 42 },
        { body: null },
        []
      ];
      for (const payload of cases) {
        const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/alpha`, payload);
        assert.equal(response.status, 400, JSON.stringify(payload));
      }
    });

    it("returns 400 for invalid segments on PATCH", async () => {
      const response = await patchJson(`${baseUrl}/vaults/main/records/tasks/bad.md`, {});
      assert.equal(response.status, 400);
    });
  });

  describe("cross-cutting behavior", () => {
    it("returns 404 for an unknown vault on every route", async () => {
      const collection = await fetch(`${baseUrl}/vaults/nope/records/tasks`);
      const single = await fetch(`${baseUrl}/vaults/nope/records/tasks/alpha`);
      const put = await putJson(`${baseUrl}/vaults/nope/records/tasks/alpha`, {
        properties: {},
        body: ""
      });
      const patch = await patchJson(`${baseUrl}/vaults/nope/records/tasks/alpha`, {});

      assert.equal(collection.status, 404);
      assert.equal(single.status, 404);
      assert.equal(put.status, 404);
      assert.equal(patch.status, 404);
    });

    it("answers OPTIONS preflight permitting GET, PUT, PATCH, and Content-Type", async () => {
      const response = await fetch(`${baseUrl}/vaults/main/records/tasks/alpha`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.test",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "Content-Type"
        }
      });

      assert.ok(response.status === 204 || response.status === 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /GET/);
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /PUT/);
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /PATCH/);
      assert.match(response.headers.get("access-control-allow-headers") ?? "", /Content-Type/i);
    });

    it("returns JSON 404 with CORS for unknown routes and record IDs with extra segments", async () => {
      for (const route of ["/", "/vaults", "/vaults/main/records", "/vaults/main/records/a/b/c"]) {
        const response = await fetch(`${baseUrl}${route}`);
        assert.equal(response.status, 404, route);
        assert.equal(response.headers.get("access-control-allow-origin"), "*", route);
        assert.ok(response.headers.get("content-type")?.startsWith("application/json"), route);
        assert.equal(typeof (await response.json()).message, "string", route);
      }
    });
  });
});
