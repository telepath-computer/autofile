import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { VaultServer } from "@telepath-computer/vault-server";

import { parseConfig, type Config } from "../dist/config.js";
import { createVaultServer, watchVaultConfig } from "../dist/serve.js";

const recordContentType = "application/vnd.telepath.record+json";
const roots: string[] = [];

after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function vault(source: string): Promise<{ root: string; config: Config }> {
  const root = await mkdtemp(join(tmpdir(), "autofile-serve-"));
  roots.push(root);
  await writeFile(join(root, "autofile.yml"), source);
  const parsed = parseConfig(source);
  if (!parsed.ok) assert.fail(parsed.errors.map(({ message }) => message).join("; "));
  return { root, config: parsed.config };
}

async function listen(root: string, config: Config): Promise<VaultServer> {
  const server = createVaultServer(root, config);
  await server.listen({ port: 0 });
  return server;
}

async function put(server: VaultServer, path: string, record: object): Promise<Response> {
  assert.ok(server.url);
  return fetch(`${server.url}/${path}`, {
    method: "PUT",
    headers: { "connection": "close", "content-type": recordContentType },
    body: JSON.stringify(record),
  });
}

async function replaceConfig(root: string, source: string): Promise<void> {
  const temporary = join(root, ".autofile.yml.replacement");
  await writeFile(temporary, source);
  await rename(temporary, join(root, "autofile.yml"));
}

test("body format follows the most-specific folder entry", async (t) => {
  const { root, config } = await vault(`version: 1
folders:
  - path: archive
    description: Raw archive.
    body: raw
  - path: archive/prose
    description: Markdown nested inside the archive.
    body: markdown
`);
  await mkdir(join(root, "archive", "prose"), { recursive: true });
  await writeFile(join(root, "archive", "target.md"), "Target\n");
  await writeFile(join(root, "archive", "raw-note.md"), "[[archive/target]]\n");
  await writeFile(join(root, "archive", "prose", "note.md"), "[[archive/target]]\n");

  const server = await listen(root, config);
  t.after(() => server.close());

  const raw = await fetch(`${server.url}/archive/raw-note`, { headers: { connection: "close" } })
    .then((response) => response.json()) as { body: string };
  const markdown = await fetch(`${server.url}/archive/prose/note`, { headers: { connection: "close" } })
    .then((response) => response.json()) as { body: string };
  assert.equal(raw.body, "[[archive/target]]\n");
  assert.equal(markdown.body, "[archive/target](../target)\n");
});

test("a refused write returns ordered rule-prefixed findings and leaves no file", async (t) => {
  const { root, config } = await vault(`version: 1
folders:
  - path: contacts
    description: Contacts.
    filename_pattern: '^[a-z0-9][a-z0-9-]*$'
    schema:
      type: object
      properties:
        title: { type: string }
`);
  const server = await listen(root, config);
  t.after(() => server.close());

  const response = await put(server, "contacts/Jane-Doe", { fields: { title: 7 } });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "filename_pattern: \"Jane-Doe\" does not match \"^[a-z0-9][a-z0-9-]*$\"; schema: title must be a string",
  });
  await assert.rejects(access(join(root, "contacts", "Jane-Doe.md")));
  await assert.rejects(access(join(root, "contacts")));
});

test("dead links in submitted fields and prose do not refuse a write", async (t) => {
  const { root, config } = await vault(`version: 1
folders:
  - path: notes
    description: Notes.
`);
  const server = await listen(root, config);
  t.after(() => server.close());

  const response = await put(server, "notes/linked", {
    fields: { related: "[[notes/not-filed-yet]]" },
    body: "See [[notes/also-missing]].\n",
  });
  assert.equal(response.status, 201);
  assert.match(await readFile(join(root, "notes", "linked.md"), "utf8"), /not-filed-yet/u);
});

test("collision validation considers only paths governed as check governs them", async (t) => {
  const { root, config } = await vault(`version: 1
folders:
  - path: files
    description: Governed files.
`);
  await mkdir(join(root, "Files"));
  await writeFile(join(root, "Files", "existing.md"), "Outside governance.\n");
  await mkdir(join(root, "files"));
  await writeFile(join(root, "files", "Jane.md"), "Governed.\n");
  const server = await listen(root, config);
  t.after(() => server.close());

  const allowed = await put(server, "files/new", { fields: {} });
  assert.equal(allowed.status, 201);

  const refused = await put(server, "files/jane", { fields: {} });
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), {
    error: "collision: collides with \"files/Jane.md\"",
  });
  await assert.rejects(access(join(root, "files", "jane.md")));
});

test("link_format reloads across repeated atomic config replacements", async (t) => {
  const wikilink = `version: 1
link_format: wikilink
folders:
  - path: notes
    description: Notes.
`;
  const markdown = wikilink.replace("link_format: wikilink", "link_format: markdown");
  const { root, config } = await vault(wikilink);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "target.md"), "Target.\n");
  const server = await listen(root, config);
  t.after(() => server.close());

  let reloadListener: (config: Config) => void = () => undefined;
  const watcher = watchVaultConfig(root, server, {
    onReload: (reloaded) => reloadListener(reloaded),
  });
  t.after(() => watcher.close());

  assert.equal((await put(server, "notes/one", {
    fields: { related: { $type: "ref", path: "notes/target" } },
  })).status, 201);
  assert.match(await readFile(join(root, "notes", "one.md"), "utf8"), /\[\[notes\/target\]\]/u);

  const markdownReloaded = new Promise<void>((resolve) => {
    reloadListener = (reloaded) => { if (reloaded.linkFormat === "markdown") resolve(); };
  });
  await replaceConfig(root, markdown);
  await markdownReloaded;
  assert.equal((await put(server, "notes/two", {
    fields: { related: { $type: "ref", path: "notes/target" } },
  })).status, 201);
  const markdownStored = await readFile(join(root, "notes", "two.md"), "utf8");
  assert.match(markdownStored, /\[notes\/target\]\(target\)/u);
  assert.doesNotMatch(markdownStored, /\[\[/u);

  const wikilinkReloaded = new Promise<void>((resolve) => {
    reloadListener = (reloaded) => { if (reloaded.linkFormat === "wikilink") resolve(); };
  });
  await replaceConfig(root, wikilink);
  await wikilinkReloaded;
  assert.equal((await put(server, "notes/three", {
    fields: { related: { $type: "ref", path: "notes/target" } },
  })).status, 201);
  assert.match(await readFile(join(root, "notes", "three.md"), "utf8"), /\[\[notes\/target\]\]/u);
});

test("an invalid config edit is reported, not adopted, and does not stop serving", async (t) => {
  const valid = `version: 1
link_format: wikilink
folders:
  - path: notes
    description: Notes.
`;
  const invalid = `version: 1
link_format: markdown
folders:
  - path: notes
    description: Notes.
    shema: {}
`;
  const { root, config } = await vault(valid);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "target.md"), "Target.\n");
  const server = await listen(root, config);
  t.after(() => server.close());

  let errorListener: (message: string) => void = () => undefined;
  const watcher = watchVaultConfig(root, server, {
    onError: (message) => errorListener(message),
  });
  t.after(() => watcher.close());
  const reported = new Promise<string>((resolve) => {
    errorListener = (message) => { if (message.includes("shema")) resolve(message); };
  });
  await replaceConfig(root, invalid);
  assert.equal(await reported, 'folders notes has an unknown key "shema"');

  const response = await put(server, "notes/after-invalid", {
    fields: { related: { $type: "ref", path: "notes/target" } },
  });
  assert.equal(response.status, 201);
  assert.match(await readFile(join(root, "notes", "after-invalid.md"), "utf8"), /\[\[notes\/target\]\]/u);
  assert.equal((await fetch(`${server.url}/notes/target`, { headers: { connection: "close" } })).status, 200);
});
