/**
 * The commands as they ship: the built `dist`, the `bin` entry that names it,
 * and a folder on disk. Everything else in the suite runs the sources in this
 * process, which shows the pieces work rather than that they fit together — a
 * passing unit suite has already coexisted with a package that could not be
 * imported at all.
 *
 * The fixture vault is checked in beside this file and copied per test, so a
 * test works on its own folder and the fixture stays what it says it is.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'autofile-md';

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

const manifest = JSON.parse(await readFile(join(PACKAGE, 'package.json'), 'utf8')) as {
  bin?: { [name: string]: string };
};

/** What the package says its command is, which is what these tests run. */
const ENTRY = manifest.bin?.[NAME];
if (ENTRY === undefined) throw new Error(`the package declares no '${NAME}' bin entry`);
const COMMAND = join(PACKAGE, ENTRY);
if (!existsSync(COMMAND)) throw new Error(`${COMMAND} is not there: run \`npm run build\``);

/** How long anything here may take before it has hung rather than been slow. */
const PATIENCE = 15_000;

/**
 * A promise that must settle soon. Nothing here may wait forever: a child that
 * hung would otherwise stop the suite rather than fail a test.
 */
async function soon<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${PATIENCE}ms`)), PATIENCE);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** A port nothing is listening on, as far as the machine knows a moment ago. */
async function free(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A copy of the fixture vault, removed however the test ends. Its real path,
 * since that is what a command run in it sees as its working directory.
 */
async function vault(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autofile-e2e-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(FIXTURE, root, { recursive: true });
  return root;
}

/** Runs the built command in `root` to its end. */
async function ran(
  root: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [COMMAND, ...args], { cwd: root });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));

  try {
    const code = await soon(
      `${NAME} ${args.join(' ')}`,
      new Promise<number | null>((resolve, reject) => {
        child.on('exit', (status) => resolve(status));
        child.on('error', reject);
      }),
    );
    return { code, out, err };
  } finally {
    // Runs even when the wait above threw, so nothing outlives the test.
    child.kill('SIGKILL');
  }
}

/**
 * The built command serving `root`, and where it can be asked. Readiness is the
 * line it says once it is listening: a sleep is either too short to be reliable
 * or too long to be quick.
 */
async function serving(
  t: TestContext,
  root: string,
): Promise<{ base: string; child: ChildProcessWithoutNullStreams }> {
  const port = await free();
  const child = spawn(process.execPath, [COMMAND, 'serve', '--port', String(port)], { cwd: root });
  // Killed however the test ends, so an assertion that throws leaves nothing
  // running and nothing holding the port.
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let out = '';
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const announced = await soon(
    'the server starting',
    new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const end = out.indexOf('\n');
        if (end !== -1) resolve(out.slice(0, end));
      });
      child.on('exit', () => reject(new Error(`the server ended: ${out}${err}`)));
      child.on('error', reject);
    }),
  );

  assert.equal(announced, `${NAME}: serving ${root} on http://127.0.0.1:${port}`);
  return { base: `http://127.0.0.1:${port}`, child };
}

/** Ends a running command, and answers with how it ended. */
async function stopped(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const ending = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, ended) => resolve({ code, signal: ended }));
  });
  child.kill(signal);
  try {
    return await soon('the server stopping', ending);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

/** The lines a run said, less the empty one a trailing newline leaves. */
function lines(out: string): string[] {
  return out.split('\n').filter((line) => line !== '');
}

/**
 * The fixture's deliberate violations, and the warning its empty collection is.
 * Removing these and filing something into `notes` is what makes the copy a
 * vault that keeps its own rules.
 */
const BROKEN = [
  'contacts/tam-oduya.md',
  'contacts/won-jae-lin.md',
  'events/2026-05-14-paper-order.md',
];

/** What the fixture holds once those are gone and `notes` has something in it. */
const CHECKED = '5 records and 2 blobs in 4 collections, no violations';

describe('what the package ships', () => {
  it('names a built command in its bin entry', async () => {
    assert.match(ENTRY ?? '', /^\.\/dist\//);
    // A shebang, since this is what a shell runs by name rather than through node.
    assert.match(await readFile(COMMAND, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  });

  it('can be imported by the name it publishes', async () => {
    const resolved = createRequire(import.meta.url).resolve('@autofile/vault-markdown');
    const built = (await import(pathToFileURL(resolved).href)) as { [name: string]: unknown };

    assert.match(resolved, /dist[/\\]index\.js$/);
    assert.equal(typeof built['MarkdownVault'], 'function');
    assert.equal(typeof built['splitIdentity'], 'function');
  });
});

describe('autofile-md validate, built and run over a folder', () => {
  it('reports what the folder breaks, violations before warnings', async (t) => {
    const root = await vault(t);

    const run = await ran(root, ['validate']);

    // Bytewise by collection and then by key, so the config's declaration order
    // — contacts, events, notes, blobs — never shows through.
    assert.equal(run.code, 1);
    assert.deepEqual(lines(run.out), [
      'contacts/tam-oduya — /type: must be equal to one of the allowed values   (contacts)',
      'contacts/won-jae-lin — it has a body where its collection allows none   (contacts)',
      'events/2026-05-14-paper-order — /date: must match format "date"   (events)',
      'warning: notes — nothing is filed into it',
    ]);
    assert.equal(run.err, '');
  });

  it('says the same thing on a second run over the same folder', async (t) => {
    const root = await vault(t);

    const first = await ran(root, ['validate']);
    const second = await ran(root, ['validate']);

    assert.equal(second.out, first.out);
    assert.equal(second.code, first.code);
  });

  it('names what was checked for a folder that keeps its own rules', async (t) => {
    const root = await vault(t);
    for (const path of BROKEN) await unlink(join(root, path));
    await mkdir(join(root, 'notes'));
    await writeFile(join(root, 'notes/paper-stock.md'), '---\ntitle: Paper stock\n---\nNewsprint.\n');

    const run = await ran(root, ['validate']);

    assert.equal(run.code, 0);
    assert.deepEqual(lines(run.out), [`${root} — ${CHECKED}`]);
  });

  it('makes a folder that will not open a finding about it', async (t) => {
    const root = await vault(t);
    await unlink(join(root, 'autofile.yml'));

    const run = await ran(root, ['validate']);

    // A command about a folder rather than about a vault: this is the `config`
    // violation, which `validate` the method can never answer with, since
    // `open` refuses every case it names before there is a vault to ask.
    assert.equal(run.code, 1);
    assert.equal(run.err, '');
    assert.equal(lines(run.out).length, 1);
    assert.match(run.out, /^autofile\.yml cannot be read: /);
  });
});

describe('autofile-md serve, built and run over a folder', () => {
  it('answers the API for the folder, and stops when told to', async (t) => {
    const root = await vault(t);
    const { base, child } = await serving(t, root);

    // The collections, so one call tells a client what it is talking to.
    const described = (await (await fetch(`${base}/`)).json()) as {
      collections: { name: string; type: string; title?: string; description?: string }[];
    };
    assert.deepEqual(
      described.collections.map((collection) => [collection.name, collection.type]),
      [
        ['contacts', 'record'],
        ['events', 'record'],
        ['notes', 'record'],
        ['blobs', 'blob'],
      ],
    );
    assert.equal(described.collections[0]?.title, 'Contacts');
    assert.match(described.collections[0]?.description ?? '', /^People and organizations\./);

    // A collection's items, in key order.
    const listed = (await (await fetch(`${base}/contacts`)).json()) as { items: { id: string }[] };
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [
        'contacts/family/sam-oyelaran',
        'contacts/priya-narayan',
        'contacts/riso-collective',
        'contacts/tam-oduya',
        'contacts/won-jae-lin',
      ],
    );

    // One record, with its wikilinks as references at whatever depth they sit.
    const read = await fetch(`${base}/contacts/priya-narayan`);
    assert.equal(read.status, 200);
    const priya = (await read.json()) as {
      id: string;
      created: string;
      updated: string;
      fields: { [name: string]: unknown };
    };
    assert.equal(priya.id, 'contacts/priya-narayan');
    // Its file's ctime and mtime, which a copy gave it a moment ago.
    assert.match(priya.created, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.match(priya.updated, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.deepEqual(priya.fields['related'], [
      { $ref: 'events/2026-06-02-zine-paper-chat' },
      { $ref: 'contacts/riso-collective' },
    ]);
    assert.deepEqual(priya.fields['sources'], {
      introduced_by: { $ref: 'contacts/family/sam-oyelaran' },
      // A string that reads like an identity is a string: only a wikilink converts.
      filed_from: 'contacts/riso-collective',
    });

    // Following that reference to the blob sitting beside the record.
    const photo = priya.fields['photo'] as { $ref: string };
    assert.equal(photo.$ref, 'blobs/contacts/priya-narayan.jpg');
    const bytes = await fetch(`${base}/${photo.$ref}`);
    const expected = await readFile(join(root, 'contacts/priya-narayan.jpg'));
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get('content-type'), 'image/jpeg');
    assert.equal(bytes.headers.get('content-length'), String(expected.length));
    const got = Buffer.from(await bytes.arrayBuffer());
    assert.deepEqual(got, expected);
    // The bytes themselves rather than something that merely has the length.
    assert.deepEqual(got.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));

    // Written, and read back on a request after the one that wrote it.
    const fields = {
      name: 'Ada Mensah',
      type: 'person',
      related: [{ $ref: 'contacts/priya-narayan' }],
    };
    const written = await fetch(`${base}/contacts/ada-mensah`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    assert.equal(written.status, 200);
    const back = await fetch(`${base}/contacts/ada-mensah`);
    assert.equal(back.status, 200);
    assert.deepEqual(((await back.json()) as { fields: unknown }).fields, fields);
    // And it is a file in the folder, spelled the way a folder of markdown is.
    assert.equal(
      await readFile(join(root, 'contacts/ada-mensah.md'), 'utf8'),
      '---\nname: Ada Mensah\ntype: person\nrelated:\n  - "[[contacts/priya-narayan]]"\n---\n',
    );

    // Removed, and gone.
    assert.equal((await fetch(`${base}/contacts/ada-mensah`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/contacts/ada-mensah`)).status, 404);
    assert.equal(existsSync(join(root, 'contacts/ada-mensah.md')), false);

    assert.deepEqual(await stopped(child, 'SIGTERM'), { code: null, signal: 'SIGTERM' });
  });

  it('refuses to serve a folder that is not a vault', async (t) => {
    const root = await vault(t);
    await unlink(join(root, 'autofile.yml'));

    const run = await ran(root, ['serve', '--port', String(await free())]);

    // Unlike `validate`, this is a run that could not start: there is no vault
    // to answer for.
    assert.equal(run.code, 2);
    assert.match(run.err, /autofile\.yml/);
    assert.equal(run.out, '');
  });
});

describe('both commands over one folder', () => {
  it('has validate see what the API wrote', async (t) => {
    const root = await vault(t);
    const { base, child } = await serving(t, root);

    assert.equal((await ran(root, ['validate'])).code, 1);

    for (const path of BROKEN) {
      const id = path.replace(/\.md$/, '');
      assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE' })).status, 204, id);
    }
    const filed = await fetch(`${base}/notes/paper-stock`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Paper stock', body: 'Newsprint.\n' }),
    });
    assert.equal(filed.status, 200);

    // The same folder, seen by the other command while the server still holds
    // it open.
    const run = await ran(root, ['validate']);

    assert.equal(run.code, 0);
    assert.deepEqual(lines(run.out), [`${root} — ${CHECKED}`]);

    assert.deepEqual(await stopped(child, 'SIGTERM'), { code: null, signal: 'SIGTERM' });
  });
});
