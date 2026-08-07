import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { InvalidIdentityError, UnknownCollectionError, WrongContentError } from '../src/errors.ts';
import { MarkdownVault } from '../src/vault.ts';
import { createServer } from '../src/server.ts';

const COLLECTIONS = `
collections:
  contacts:
    type: record
    title: Contacts
    description: People and organizations.
    schema:
      required: [name]
      properties:
        name: { type: string }
  events:
    type: record
  blobs:
    type: blob
    description: Everything that is not a record.
`;

const roots: string[] = [];
const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a vault root holding the given files, keyed by path from the root. */
async function vault(files: { [path: string]: string | Uint8Array }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-server-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

/**
 * Opens a vault over the given files and serves it on an ephemeral port. The
 * vault comes back too, so a test can stub `put` or `remove` on it: those are
 * what the server is asserted to call, and what they do to the folder is the
 * vault's own tested business.
 */
async function serving(files: {
  [path: string]: string | Uint8Array;
}): Promise<{ base: string; vault: MarkdownVault }> {
  const opened = await MarkdownVault.open(await vault(files));
  const server = createServer(opened);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, vault: opened };
}

/**
 * A request whose path reaches the server exactly as written, and what came
 * back. `fetch` builds a URL first, and a URL resolves `.` and `..` segments —
 * including their percent-encoded spellings — so the paths that matter most
 * here are the ones it will not send.
 */
async function raw(
  base: string,
  path: string,
  method = 'GET',
): Promise<{
  status: number;
  headers: { [name: string]: string | string[] | undefined };
  body: string;
}> {
  const { hostname, port } = new URL(base);
  return await new Promise((resolve, reject) => {
    const sent = request({ host: hostname, port, path, method }, (received) => {
      let body = '';
      received.setEncoding('utf8');
      received.on('data', (chunk: string) => (body += chunk));
      received.on('end', () =>
        resolve({ status: received.statusCode ?? 0, headers: received.headers, body }),
      );
    });
    sent.on('error', reject);
    sent.end();
  });
}

/** A listing's items, as plain JSON objects. */
async function listing(response: Response): Promise<{ [name: string]: unknown }[]> {
  const body = (await response.json()) as { items: { [name: string]: unknown }[] };
  assert.ok(Array.isArray(body.items), `expected a listing, got ${JSON.stringify(body)}`);
  return body.items;
}

/**
 * Asserts a value is a timestamp as JSON carries one, and answers with it, so a
 * whole-object comparison can pin the shape without pinning the clock.
 */
function iso(value: unknown): string {
  assert.equal(typeof value, 'string', `expected a timestamp, got ${JSON.stringify(value)}`);
  assert.match(value as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return value as string;
}

describe('GET /', () => {
  it("answers the vault's collections, each with everything it declares", async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(base);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      collections: [
        {
          name: 'contacts',
          type: 'record',
          title: 'Contacts',
          description: 'People and organizations.',
          schema: { required: ['name'], properties: { name: { type: 'string' } } },
        },
        { name: 'events', type: 'record' },
        { name: 'blobs', type: 'blob', description: 'Everything that is not a record.' },
      ],
    });
  });

  it('answers as JSON', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(base);

    assert.equal(response.headers.get('content-type'), 'application/json');
  });

  it('answers a vault that declares no collections', async () => {
    const { base } = await serving({ 'autofile.yml': '{}\n' });

    assert.deepEqual(await (await fetch(base)).json(), { collections: [] });
  });

  it("carries a collection rule that is this vault's own", async () => {
    const { base } = await serving({
      'autofile.yml': 'collections:\n  contacts:\n    type: record\n    body: false\n',
    });

    assert.deepEqual(await (await fetch(base)).json(), {
      collections: [{ name: 'contacts', type: 'record', body: false }],
    });
  });
});

describe('GET /{collection}', () => {
  it("answers a record collection's items, in key order", async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nPrintmaker.\n',
      'contacts/anna-hall.md': '---\nname: Anna Hall\n---\n',
    });

    const response = await fetch(`${base}/contacts`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    const items = await listing(response);
    assert.deepEqual(
      items.map((item) => item['id']),
      ['contacts/anna-hall', 'contacts/priya-narayan'],
    );
    assert.deepEqual(items[1], {
      type: 'record',
      id: 'contacts/priya-narayan',
      fields: { name: 'Priya Narayan', body: 'Printmaker.\n' },
      created: iso(items[1]?.['created']),
      updated: iso(items[1]?.['updated']),
    });
  });

  it("answers a blob collection's items with what is known about each", async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'assets/site/index.html': '<h1>Hello</h1>\n',
    });

    const items = await listing(await fetch(`${base}/blobs`));

    const found = items.find((item) => item['id'] === 'blobs/assets/site/index.html');
    assert.deepEqual(found, {
      type: 'blob',
      id: 'blobs/assets/site/index.html',
      content: { type: 'text/html', size: 15 },
      created: iso(found?.['created']),
      updated: iso(found?.['updated']),
    });
  });

  it('answers a declared collection with nothing in it', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contacts`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [] });
  });

  it('refuses a collection the vault does not declare, saying so', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contact`);

    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /contact/);
  });
});

describe('GET /{identity}', () => {
  it('answers a record on its own', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nPrintmaker.\n',
    });

    const response = await fetch(`${base}/contacts/priya-narayan`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    const body = (await response.json()) as { [name: string]: unknown };
    assert.deepEqual(body, {
      type: 'record',
      id: 'contacts/priya-narayan',
      fields: { name: 'Priya Narayan', body: 'Printmaker.\n' },
      created: iso(body['created']),
      updated: iso(body['updated']),
    });
  });

  it("answers a record whose key has slashes in it, from the key's segments", async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/family/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    const response = await fetch(`${base}/contacts/family/priya-narayan`);

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, 'contacts/family/priya-narayan');
  });

  it('carries a wikilink field as a reference', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': "---\nname: Priya\nrelated: ['[[events/zine-chat]]']\n---\n",
    });

    const body = (await (await fetch(`${base}/contacts/priya-narayan`)).json()) as {
      fields: unknown;
    };

    assert.deepEqual(body.fields, {
      name: 'Priya',
      related: [{ $ref: 'events/zine-chat' }],
    });
  });

  it('refuses a key its collection does not hold', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contacts/nobody`);

    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /contacts\/nobody/);
  });

  it('refuses an identity in a collection the vault does not declare', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contact/priya-narayan`);

    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /contact/);
  });

  it('reports a record it cannot read as the vault being broken', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: [unclosed\n---\n',
    });

    const response = await fetch(`${base}/contacts/priya-narayan`);

    assert.equal(response.status, 500);
    assert.match(((await response.json()) as { error: string }).error, /priya-narayan/);
  });

  it("answers a blob with its bytes, its media type and its size", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
    const { base } = await serving({ 'autofile.yml': COLLECTIONS, 'photos/cover.png': bytes });

    const response = await fetch(`${base}/blobs/photos/cover.png`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-length'), '7');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  });

  it('answers a blob at a key of several segments, so its relative links resolve', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'assets/site/index.html': '<h1>Hello</h1>\n',
    });

    const response = await fetch(`${base}/blobs/assets/site/index.html`);

    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.equal(await response.text(), '<h1>Hello</h1>\n');
  });

  it('refuses a blob key nothing is filed at', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    assert.equal((await fetch(`${base}/blobs/photos/cover.png`)).status, 404);
  });

  it('reads a blob from its stream rather than into memory', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const content = new Blob(['a video, in as many bytes']);
    for (const name of ['arrayBuffer', 'bytes', 'text']) {
      Object.defineProperty(content, name, {
        value: () => {
          throw new Error(`a vault can hold a video: ${name} must not be called`);
        },
      });
    }
    opened.get = async (id) => ({
      type: 'blob',
      id,
      created: new Date(),
      updated: new Date(),
      content,
    });

    const response = await fetch(`${base}/blobs/big.mp4`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'a video, in as many bytes');
  });

  it('sends what a blob has streamed before the rest exists', { timeout: 10_000 }, async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const encoder = new TextEncoder();
    // The rest of the blob is a quarter-second away, which is an age beside a
    // request to a loopback socket: a server that buffered would answer with
    // nothing until the whole of it had arrived.
    let rest = false;
    const content = new Blob(['first ', 'second']);
    Object.defineProperty(content, 'stream', {
      value: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('first '));
            await new Promise((resolve) => setTimeout(resolve, 250));
            rest = true;
            controller.enqueue(encoder.encode('second'));
            controller.close();
          },
        }),
    });
    opened.get = async (id) => ({
      type: 'blob',
      id,
      created: new Date(),
      updated: new Date(),
      content,
    });

    const response = await fetch(`${base}/blobs/big.mp4`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();

    assert.equal(new TextDecoder().decode(first.value), 'first ');
    assert.equal(rest, false, 'the whole blob was in memory before anything was sent');
    await reader.cancel();
  });
});

describe('a path becoming an identity', () => {
  it('decodes a segment that carries a character a path cannot', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    const response = await fetch(`${base}/contacts/priya%20narayan`);

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, 'contacts/priya narayan');
  });

  it('decodes each segment once, and only what is encoded', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/a%2Fb.md': '---\nname: literal\n---\n',
      'contacts/a+b.md': '---\nname: plus\n---\n',
    });

    // `%25` is a per cent sign; a second pass over it would find `%2F` and
    // invent a boundary. A `+` is a plus: this is a path, not a form.
    assert.equal(
      ((await (await fetch(`${base}/contacts/a%252Fb`)).json()) as { id: string }).id,
      'contacts/a%2Fb',
    );
    assert.equal(
      ((await (await fetch(`${base}/contacts/a+b`)).json()) as { id: string }).id,
      'contacts/a+b',
    );
  });

  it('refuses a segment that holds a slash once decoded, rather than splitting on it', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/family/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    for (const path of ['/contacts/family%2Fpriya-narayan', '/contacts/family%2fpriya-narayan']) {
      const response = await fetch(`${base}${path}`);

      assert.equal(response.status, 400, path);
      assert.doesNotMatch(await response.text(), /Priya Narayan/);
    }
  });

  it('refuses an encoded `..`, which is a `..` before anything is checked', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
      'secret.txt': 'not yours\n',
    });

    for (const path of [
      '/contacts/%2e%2e/secret.txt',
      '/contacts/%2E%2E/secret.txt',
      '/blobs/%2e%2e%2fsecret.txt',
      '/contacts/subfolder/%2e%2e/%2e%2e/secret.txt',
    ]) {
      const response = await raw(base, path);

      assert.equal(response.status, 400, path);
      assert.doesNotMatch(response.body, /not yours/, path);
    }
  });

  it('refuses a literal `..`, and a `.`', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS, 'secret.txt': 'not yours\n' });

    for (const path of ['/blobs/../secret.txt', '/blobs/./secret.txt', '/contacts/..']) {
      const response = await raw(base, path);

      assert.equal(response.status, 400, path);
      assert.doesNotMatch(response.body, /not yours/, path);
    }
  });

  it('takes a segment that merely begins with dots as the name it is', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/..hidden.md': '---\nname: Hidden\n---\n',
    });

    const response = await fetch(`${base}/contacts/..hidden`);

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, 'contacts/..hidden');
  });

  it('refuses a path with an empty segment', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    for (const path of ['/contacts/', '//contacts/priya-narayan', '/contacts//priya-narayan']) {
      assert.equal((await raw(base, path)).status, 400, path);
    }
  });

  it('refuses a path that is not percent-encoded', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    assert.equal((await raw(base, '/contacts/%zz')).status, 400);
    assert.equal((await raw(base, '/contacts/%')).status, 400);
  });

  it('names the same identity whatever query follows it', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    const response = await fetch(`${base}/contacts/priya-narayan?fields=name`);

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, 'contacts/priya-narayan');
  });

  it('decodes the collection segment too', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    assert.equal((await fetch(`${base}/cont%61cts`)).status, 200);
    assert.equal((await fetch(`${base}/cont%61cts/priya-narayan`)).status, 200);
  });
});

/**
 * A vault whose writes are recorded rather than performed. What `put` and
 * `remove` do to the folder is the vault's own tested business; what the server
 * owes is calling them with what the request said.
 */
function recording(opened: MarkdownVault): { put: unknown[][]; remove: unknown[][] } {
  const calls = { put: [] as unknown[][], remove: [] as unknown[][] };
  opened.put = async (id, content) => {
    calls.put.push([id, content]);
    return typeof content === 'object' && content instanceof globalThis.Blob
      ? { type: 'blob', id, created: new Date(), updated: new Date(), content }
      : { type: 'record', id, fields: content, created: new Date(), updated: new Date() };
  };
  opened.remove = async (id) => {
    calls.remove.push([id]);
  };
  return calls;
}

describe('PUT /{identity}', () => {
  it("takes a record's fields as the body, and answers with the record", async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    const response = await fetch(`${base}/contacts/priya-narayan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Priya Narayan', body: 'Printmaker.\n' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls.put, [
      ['contacts/priya-narayan', { name: 'Priya Narayan', body: 'Printmaker.\n' }],
    ]);
    const body = (await response.json()) as { [name: string]: unknown };
    assert.deepEqual(body, {
      type: 'record',
      id: 'contacts/priya-narayan',
      fields: { name: 'Priya Narayan', body: 'Printmaker.\n' },
      created: iso(body['created']),
      updated: iso(body['updated']),
    });
  });

  it('answers 200 whether or not anything was there', async () => {
    const { base, vault: opened } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });
    recording(opened);

    const replaced = await fetch(`${base}/contacts/priya-narayan`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Priya Narayan' }),
    });
    const created = await fetch(`${base}/contacts/anna-hall`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Anna Hall' }),
    });

    assert.equal(replaced.status, 200);
    assert.equal(created.status, 200);
  });

  it('reads the body as fields because the collection holds records, not a header', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    const response = await fetch(`${base}/contacts/priya-narayan`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'Priya Narayan' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls.put, [['contacts/priya-narayan', { name: 'Priya Narayan' }]]);
  });

  it('refuses a body that is not the kind the collection holds', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    for (const body of ['not json at all', '["fields"]', '"a string"', 'null', '']) {
      const response = await fetch(`${base}/contacts/priya-narayan`, { method: 'PUT', body });

      assert.equal(response.status, 415, body);
    }
    assert.deepEqual(calls.put, []);
  });

  it("refuses fields that fail the collection's schema, with the reasons", async () => {
    // The vault refuses these itself, so nothing is stubbed: what the server
    // owes is that the refusal arrives as its own status rather than as a
    // failure, and that the reasons come with it.
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contacts/priya-narayan`, {
      method: 'PUT',
      body: JSON.stringify({ name: 42 }),
    });

    assert.equal(response.status, 422);
    const body = (await response.json()) as { reasons: string[] };
    assert.deepEqual(body.reasons, ['/name: must be string']);
    assert.equal((await fetch(`${base}/contacts/priya-narayan`)).status, 404);
  });

  it('refuses a key the vault cannot hold as an identity it cannot spell', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    // `e` and a combining acute: a key that is not in Unicode NFC, which is
    // two spellings of one file rather than fields the collection objects to.
    const response = await fetch(`${base}/contacts/cafe%CC%81`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Cafe' }),
    });

    assert.equal(response.status, 400);
  });

  it('takes fields a collection with no schema is given', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    const response = await fetch(`${base}/events/zine-chat`, {
      method: 'PUT',
      body: JSON.stringify({ anything: true }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls.put, [['events/zine-chat', { anything: true }]]);
  });

  it('takes a record with no fields as having none', async () => {
    const { base, vault: opened } = await serving({
      'autofile.yml': 'collections:\n  events:\n    type: record\n',
    });
    const calls = recording(opened);

    const response = await fetch(`${base}/events/zine-chat`, { method: 'PUT', body: '{}' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls.put, [['events/zine-chat', {}]]);
  });

  it("takes a blob's bytes, claiming nothing about them the key does not", async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);
    const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff]);

    const response = await fetch(`${base}/blobs/photos/cover.png`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });

    assert.equal(response.status, 200);
    assert.equal(calls.put.length, 1);
    const [id, content] = calls.put[0] as [string, globalThis.Blob];
    assert.equal(id, 'blobs/photos/cover.png');
    assert.ok(content instanceof globalThis.Blob, 'the bytes did not arrive as bytes');
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
    // The media type is the extension's to say, so nothing on the way in is
    // recorded as a claim about the bytes.
    assert.equal(content.type, '');
  });

  it('answers a written blob with what is known about it', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    recording(opened);

    const response = await fetch(`${base}/blobs/notes.txt`, { method: 'PUT', body: 'hello' });

    const body = (await response.json()) as { [name: string]: unknown };
    assert.deepEqual(body, {
      type: 'blob',
      id: 'blobs/notes.txt',
      content: { type: '', size: 5 },
      created: iso(body['created']),
      updated: iso(body['updated']),
    });
  });

  it('takes JSON offered to a blob collection as bytes, since a .json file is a blob', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    const response = await fetch(`${base}/blobs/data/points.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ "a": 1 }',
    });

    assert.equal(response.status, 200);
    const [, content] = calls.put[0] as [string, globalThis.Blob];
    assert.ok(content instanceof globalThis.Blob);
    assert.equal(await content.text(), '{ "a": 1 }');
  });

  it('refuses a body where the collection forbids one', async () => {
    const { base } = await serving({
      'autofile.yml': 'collections:\n  contacts:\n    type: record\n    body: false\n',
    });

    const response = await fetch(`${base}/contacts/priya-narayan`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Priya Narayan', body: 'Printmaker.\n' }),
    });

    assert.equal(response.status, 422);
    assert.deepEqual(((await response.json()) as { reasons: string[] }).reasons, [
      'it has a body where its collection allows none',
    ]);
  });

  it("carries the vault's refusals through as they are", async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const refusals = {
      '/contacts/priya-narayan': new InvalidIdentityError('contacts/priya-narayan', 'no'),
      '/notes/one': new UnknownCollectionError('notes'),
      '/blobs/one.png': new WrongContentError('blobs/one.png', 'blob'),
    };
    opened.put = async (id) => {
      throw refusals[`/${id}` as keyof typeof refusals];
    };

    const statuses: number[] = [];
    for (const path of Object.keys(refusals)) {
      statuses.push(
        (await fetch(`${base}${path}`, { method: 'PUT', body: JSON.stringify({ name: 'x' }) }))
          .status,
      );
    }

    assert.deepEqual(statuses, [400, 404, 415]);
  });
});

describe('DELETE /{identity}', () => {
  it('removes the identity and answers 204', async () => {
    const { base, vault: opened } = await serving({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });
    const calls = recording(opened);

    const response = await fetch(`${base}/contacts/priya-narayan`, { method: 'DELETE' });

    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.deepEqual(calls.remove, [['contacts/priya-narayan']]);
  });

  it('answers 404 when nothing was there', async () => {
    // The same answer a GET on that identity would give, down to the body.
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const deleted = await fetch(`${base}/contacts/priya-narayan`, { method: 'DELETE' });
    const got = await fetch(`${base}/contacts/priya-narayan`);

    assert.equal(deleted.status, 404);
    assert.deepEqual(await deleted.json(), await got.json());
  });

  it("carries the vault's refusals through as they are", async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    opened.remove = async (id) => {
      throw id.startsWith('notes/')
        ? new UnknownCollectionError('notes')
        : new InvalidIdentityError(id, 'no');
    };

    assert.equal((await fetch(`${base}/notes/one`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${base}/contacts/one`, { method: 'DELETE' })).status, 400);
  });
});

describe('the methods a route answers', () => {
  it('refuses a method the route has no meaning for, saying which it has', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    // There is no POST: an identity is chosen by whoever files, so nothing here
    // would know what to call a record it was handed.
    const posted = await raw(base, '/contacts/priya-narayan', 'POST');
    assert.equal(posted.status, 405);
    assert.equal(posted.headers['allow'], 'GET, PUT, DELETE, OPTIONS');

    const patched = await raw(base, '/contacts/priya-narayan', 'PATCH');
    assert.equal(patched.status, 405);
  });

  it('refuses a write to a collection, which is not an identity', async () => {
    const { base, vault: opened } = await serving({ 'autofile.yml': COLLECTIONS });
    const calls = recording(opened);

    for (const path of ['/contacts', '/']) {
      for (const method of ['PUT', 'DELETE']) {
        const response = await raw(base, path, method);

        assert.equal(response.status, 405, `${method} ${path}`);
        assert.equal(response.headers['allow'], 'GET, OPTIONS');
      }
    }
    assert.deepEqual(calls, { put: [], remove: [] });
  });

  it('answers the preflight, since the point of serving JSON is a web app', async () => {
    const { base } = await serving({ 'autofile.yml': COLLECTIONS });

    const response = await fetch(`${base}/contacts/priya-narayan`, { method: 'OPTIONS' });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, PUT, DELETE, OPTIONS');
    assert.ok(response.headers.get('access-control-allow-headers'));
  });

  it('carries the allowed origin on every answer', async () => {
    const { base } = await serving({
      'autofile.yml': COLLECTIONS,
      'assets/site/index.html': '<h1>Hello</h1>\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    for (const path of [
      '/',
      '/contacts',
      '/contacts/priya-narayan',
      '/blobs/assets/site/index.html',
      '/contacts/nobody',
      '/nothing',
    ]) {
      const response = await fetch(`${base}${path}`);

      assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
    }
    assert.equal((await raw(base, '/contacts/a%2Fb')).headers['access-control-allow-origin'], '*');
  });
});
