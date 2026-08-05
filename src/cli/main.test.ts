import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The command is exercised as a process, not as a function call: argument
// handling, output streams, and the exit code are what `validate` promises, and
// only a real run can show them.
const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

interface Run {
  stdout: string[];
  stderr: string[];
  code: number;
}

function autofile(cwd: string, ...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    collect(child.stdout, (chunk) => (stdout += chunk));
    collect(child.stderr, (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout: lines(stdout), stderr: lines(stderr), code: code ?? -1 }),
    );
  });
}

function collect(stream: Readable | null, onChunk: (chunk: string) => void): void {
  stream?.setEncoding('utf8').on('data', onChunk);
}

/** Output as the lines it is made of, without the trailing newline's empty tail. */
function lines(output: string): string[] {
  return output === '' ? [] : output.replace(/\n$/, '').split('\n');
}

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Creates a vault root holding the given files, keyed by path from the root.
 * The root is resolved, because the command names the working directory as the
 * process reports it and a temporary directory may sit behind a symlink.
 */
async function vault(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autofile-cli-')));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const VALID = {
  'autofile.yml': `
paths:
  /contacts:
    schema:
      required: [name]
      properties:
        name: { type: string }
    filename: { pattern: "^[a-z0-9-]+$" }
    body: false
`,
  'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
};

/** A vault holding one record breaking each rule, and one path with nothing at it. */
const BROKEN = {
  'autofile.yml': `
paths:
  /archive:
  /contacts:
    schema:
      required: [name]
      properties:
        name: { type: string }
    filename: { pattern: "^[a-z0-9-]+$" }
    body: false
`,
  'contacts/ada.md': '---\nname: [unclosed\n---\n',
  'contacts/bad name.md': '---\nname: Bad Name\n---\n',
  'contacts/no-name.md': '---\ntype: person\n---\n',
  'contacts/with-body.md': '---\nname: Has Body\n---\nSome body.\n',
};

describe('autofile validate', () => {
  it('names what was checked and exits zero for a valid vault', async () => {
    const root = await vault(VALID);

    const run = await autofile(root, 'validate');

    assert.deepEqual(run.stdout, [`${root} — 1 record in 1 path, no violations`]);
    assert.deepEqual(run.stderr, []);
    assert.equal(run.code, 0);
  });

  it('reports every kind of violation, then warnings, and exits non-zero', async () => {
    const root = await vault(BROKEN);

    const run = await autofile(root, 'validate');

    const [parse, ...rest] = run.stdout;
    // The parse violation carries the YAML parser's own message, which quotes
    // the source, so only its shape is asserted.
    assert.match(parse ?? '', /^contacts\/ada\.md — .+ {3}\(\/contacts\)$/);
    assert.deepEqual(rest, [
      'contacts/bad name.md — must match pattern "^[a-z0-9-]+$"   (/contacts)',
      "contacts/no-name.md — must have required property 'name'   (/contacts)",
      'contacts/with-body.md — has a body where the path allows none   (/contacts)',
      'warning: /archive — nothing at this path',
      `${root} — 4 records in 2 paths, 4 violations`,
    ]);
    assert.deepEqual(run.stderr, []);
    assert.notEqual(run.code, 0);
  });

  it('renders a violation on one line however many the message runs to', async () => {
    const root = await vault(BROKEN);

    const run = await autofile(root, 'validate');

    assert.match(run.stdout[0] ?? '', /Flow sequence/);
    assert.equal(run.stdout.length, 6);
  });

  it('drops the column marker that collapsing a message points nowhere', async () => {
    const root = await vault(BROKEN);

    const run = await autofile(root, 'validate');

    // The YAML parser underlines the offending column on a line of its own,
    // which marks nothing once the message is one line.
    assert.doesNotMatch(run.stdout[0] ?? '', /\^/);
    assert.match(run.stdout[0] ?? '', /name: \[unclosed {3}\(\/contacts\)$/);
  });

  it('exits zero and shows the warning when the only finding is a warning', async () => {
    const root = await vault(VALID);
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'autofile.yml'), `${VALID['autofile.yml']}  /archive:\n`);

    const run = await autofile(root, 'validate');

    assert.deepEqual(run.stdout, [
      'warning: /archive — nothing at this path',
      `${root} — 1 record in 2 paths, no violations`,
    ]);
    assert.equal(run.code, 0);
  });

  it('reports a config violation, and nothing about what it could not check', async () => {
    const root = await vault({ 'autofile.yml': 'title: 12\n' });

    const run = await autofile(root, 'validate');

    assert.deepEqual(run.stdout, ['autofile.yml — /title: must be string']);
    assert.deepEqual(run.stderr, []);
    assert.equal(run.code, 1);
  });

  it('fails distinguishably from an invalid vault without an autofile.yml', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    const run = await autofile(root, 'validate');

    assert.deepEqual(run.stdout, []);
    assert.deepEqual(run.stderr, [`autofile: no autofile.yml in ${root}`]);
    // Not 1: an absent vault is the command failing to run, not a vault found
    // wanting, and a caller acting on the difference can tell them apart.
    assert.equal(run.code, 2);
  });

  it('produces identical output across runs over an unchanged vault', async () => {
    const root = await vault(BROKEN);

    const first = await autofile(root, 'validate');
    const second = await autofile(root, 'validate');

    assert.deepEqual(second, first);
  });

  it('rejects an unknown option', async () => {
    const root = await vault(VALID);

    const run = await autofile(root, 'validate', '--strict');

    assert.deepEqual(run.stdout, []);
    assert.equal(run.stderr[0], "autofile: unknown option '--strict'");
    assert.equal(run.code, 2);
  });

  it('rejects an unexpected argument', async () => {
    const root = await vault(VALID);

    const run = await autofile(root, 'validate', 'somewhere-else');

    assert.deepEqual(run.stdout, []);
    assert.equal(run.stderr[0], "autofile: unexpected argument 'somewhere-else'");
    assert.equal(run.code, 2);
  });
});

describe('autofile', () => {
  it('fails with usage on an unknown command', async () => {
    const root = await vault(VALID);

    const run = await autofile(root, 'serv');

    assert.deepEqual(run.stdout, []);
    assert.equal(run.stderr[0], "autofile: unknown command 'serv'");
    assert.ok(
      run.stderr.some((line) => line.startsWith('usage: autofile')),
      `expected usage, got ${run.stderr.join(' / ')}`,
    );
    assert.ok(
      run.stderr.some((line) => line.includes('validate')),
      `expected the commands listed, got ${run.stderr.join(' / ')}`,
    );
    assert.equal(run.code, 2);
  });

  it('prints usage on standard output and exits zero for --help', async () => {
    // Nowhere near a vault: asking what the binary does needs no vault to do it
    // to.
    const root = await vault({});

    const run = await autofile(root, '--help');

    assert.equal(run.stdout[0], 'usage: autofile <command>');
    assert.ok(
      run.stdout.some((line) => line.includes('validate')),
      `expected the commands listed, got ${run.stdout.join(' / ')}`,
    );
    assert.deepEqual(run.stderr, []);
    assert.equal(run.code, 0);
  });

  it('answers --help asked of a command rather than rejecting it', async () => {
    const root = await vault(VALID);

    const run = await autofile(root, 'validate', '--help');

    assert.equal(run.stdout[0], 'usage: autofile <command>');
    assert.deepEqual(run.stderr, []);
    assert.equal(run.code, 0);
  });

  it('fails with usage when given no command', async () => {
    const root = await vault(VALID);

    const run = await autofile(root);

    assert.deepEqual(run.stdout, []);
    assert.ok(
      run.stderr.some((line) => line.startsWith('usage: autofile')),
      `expected usage, got ${run.stderr.join(' / ')}`,
    );
    assert.equal(run.code, 2);
  });
});
