import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const roots: string[] = [];
const running: ChildProcessWithoutNullStreams[] = [];

after(async () => {
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A folder holding a vault, and nothing else. Its real path, since that is what
 * the command sees as its working directory and reports as what it checked.
 */
async function folder(config?: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autofile-cli-')));
  roots.push(root);
  if (config !== undefined) await writeFile(join(root, 'autofile.yml'), config);
  return root;
}

/** A file in a vault, with whatever folders its path implies. */
async function file(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A port nothing is listening on, as far as the machine knows a moment ago. */
async function free(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Runs the command in `root`, and answers with the first line it says. */
async function serve(root: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
  running.push(child);
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')));
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('exit', () => reject(new Error(`the command ended: ${out}${err}`)));
    child.on('error', reject);
  });
}

/**
 * Runs the command in `root` to its end, for a run that has one. A run that
 * does not end is ended here and answers with no code at all, so a command that
 * served something it should have refused fails rather than hangs.
 */
async function ran(
  root: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
  running.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const ending = setTimeout(() => child.kill('SIGKILL'), 5_000);
  return await new Promise((resolve) => {
    child.on('exit', (code) => {
      clearTimeout(ending);
      resolve({ code, out, err });
    });
  });
}

describe('autofile-md serve', () => {
  it('answers the API for the folder it was run in', async () => {
    const root = await folder('collections:\n  contacts:\n    type: record\n');
    const port = await free();

    const announced = await serve(root, ['serve', '--host', '127.0.0.1', '--port', String(port)]);

    assert.match(announced, new RegExp(`http://127\\.0\\.0\\.1:${port}\\b`));
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      collections: [{ name: 'contacts', type: 'record' }],
    });
  });

  it('holds the vault open across requests', async () => {
    const root = await folder('collections:\n  contacts:\n    type: record\n');
    const port = await free();
    const announced = await serve(root, ['serve', '--port', String(port)]);

    // The host defaults to loopback, and binding wide is typed rather than
    // assumed: there is no authentication behind it.
    assert.match(announced, new RegExp(`http://127\\.0\\.0\\.1:${port}\\b`));
    const first = await fetch(`http://127.0.0.1:${port}/contacts`);
    const second = await fetch(`http://127.0.0.1:${port}/contacts`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });

  it('refuses a folder that is not a vault', async () => {
    const run = await ran(await folder(), ['serve', '--port', String(await free())]);

    assert.equal(run.code, 2);
    assert.match(run.err, /autofile\.yml/);
  });

  it('refuses an invocation it does not understand', async () => {
    const root = await folder('collections: {}\n');

    for (const args of [
      [],
      ['sniff'],
      ['serve', '--boat'],
      ['serve', '--boat', 'yes'],
      ['serve', '--port'],
      ['serve', '--port', 'soon'],
      ['serve', '--port', '99999'],
    ]) {
      const run = await ran(root, args);

      assert.equal(run.code, 2, args.join(' '));
      assert.match(run.err, /usage|port/, args.join(' '));
    }
  });
});

/** A vault whose record collections have rules a record can break. */
const CHECKED = `
collections:
  contacts:
    type: record
    schema:
      required: [name]
      properties:
        name: { type: string }
    body: false
  events:
    type: record
    schema:
      required: [date]
      properties:
        date: { type: string, format: date }
  blobs:
    type: blob
`;

/** The lines a run said, less the empty one a trailing newline leaves. */
function lines(out: string): string[] {
  return out.split('\n').filter((line) => line !== '');
}

describe('autofile-md validate', () => {
  it('reports the findings of the folder it was run in', async () => {
    const root = await folder(CHECKED);
    await file(root, 'contacts/priya-narayan.md', '---\nname: 7\n---\n');

    const run = await ran(root, ['validate']);

    assert.equal(run.code, 1);
    assert.deepEqual(lines(run.out), [
      'contacts/priya-narayan — /name: must be string   (contacts)',
      'warning: events — nothing is filed into it',
    ]);
  });

  it('names what was checked for a vault that keeps its own rules', async () => {
    const root = await folder(CHECKED);
    await file(root, 'contacts/priya-narayan.md', '---\nname: Priya Narayan\n---\n');
    await file(root, 'events/zine-paper-chat.md', '---\ndate: 2026-06-02\n---\nWe talked paper.\n');
    await file(root, 'contacts/priya-narayan.jpg', 'bytes');

    const run = await ran(root, ['validate']);

    // A run that found nothing is distinguishable from one that found
    // everything in order. The config counts among the blobs, since every file
    // in the vault has one role and it is not a record.
    assert.equal(run.code, 0);
    assert.deepEqual(lines(run.out), [
      `${root} — 2 records and 2 blobs in 3 collections, no violations`,
    ]);
  });

  it('does not fail a run for a warning', async () => {
    const root = await folder(CHECKED);
    await file(root, 'contacts/priya-narayan.md', '---\nname: Priya Narayan\n---\n');

    const run = await ran(root, ['validate']);

    // A warning that failed a build would not be a warning.
    assert.equal(run.code, 0);
    assert.deepEqual(lines(run.out), [
      'warning: events — nothing is filed into it',
      `${root} — 1 record and 1 blob in 3 collections, no violations`,
    ]);
  });

  it('turns a folder that will not open into a config finding', async () => {
    const run = await ran(await folder(), ['validate']);

    // A command about a folder rather than about a vault: a folder that will
    // not open is a finding about it rather than a run that could not start.
    assert.equal(run.code, 1);
    assert.equal(run.err, '');
    assert.deepEqual(lines(run.out).length, 1);
    assert.match(run.out, /^autofile\.yml cannot be read: /);
  });

  it('names neither a record nor a collection in a config finding', async () => {
    const root = await folder('collections:\n  contacts:\n    type: record\n    boat: yes\n');

    const run = await ran(root, ['validate']);

    assert.equal(run.code, 1);
    assert.deepEqual(lines(run.out), [
      "autofile.yml is not a valid config: /collections/contacts: unknown key 'boat'",
    ]);
  });

  it('flattens a finding that spans several lines onto one', async () => {
    const root = await folder(CHECKED);
    await file(root, 'contacts/priya-narayan.md', '---\nname: "unterminated\n---\n');

    const run = await ran(root, ['validate']);

    const said = lines(run.out);
    assert.equal(said.length, 2);
    assert.match(
      said[0] ?? '',
      /^contacts\/priya-narayan — its header does not parse as YAML: .+ {3}\(contacts\)$/,
    );
  });

  it('puts violations before warnings, in an order a second run repeats', async () => {
    // Declared in an order the answer must not follow, so the config's key
    // order cannot pass for the bytewise one.
    const root = await folder(`
collections:
  events:
    type: record
    schema: { required: [date], properties: { date: { type: string, format: date } } }
  contacts:
    type: record
    schema: { required: [name], properties: { name: { type: string } } }
    body: false
  notes:
    type: record
  blobs:
    type: blob
`);
    await file(root, 'contacts/zeta.md', '---\nname: 7\n---\n');
    await file(root, 'contacts/alpha.md', '---\nname: Alpha\n---\nProse.\n');
    await file(root, 'events/omega.md', '---\ndate: soon\n---\n');

    const first = await ran(root, ['validate']);
    const second = await ran(root, ['validate']);

    assert.equal(first.code, 1);
    assert.deepEqual(lines(first.out), [
      'contacts/alpha — it has a body where its collection allows none   (contacts)',
      'contacts/zeta — /name: must be string   (contacts)',
      'events/omega — /date: must match format "date"   (events)',
      'warning: notes — nothing is filed into it',
    ]);
    assert.equal(second.out, first.out);
  });

  it('refuses an invocation it does not understand', async () => {
    const root = await folder(CHECKED);

    for (const args of [
      ['validate', 'here'],
      ['validate', '--port', '8787'],
    ]) {
      const run = await ran(root, args);

      assert.equal(run.code, 2, args.join(' '));
      assert.match(run.err, /usage/, args.join(' '));
    }
  });
});
