import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

const roots: string[] = [];
const running: ChildProcessWithoutNullStreams[] = [];

after(async () => {
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A folder holding a vault, and nothing else. */
async function folder(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-cli-'));
  roots.push(root);
  if (config !== undefined) await writeFile(join(root, 'autofile.yml'), config);
  return root;
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
