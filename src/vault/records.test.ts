import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { VaultConfig } from './config.ts';
import { type VaultRecord, findRecords } from './records.ts';

const roots: string[] = [];

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a vault root holding the given files, keyed by path from the root. */
async function vault(files: Record<string, string>): Promise<string> {
  const root = await directory('autofile-records-');
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

/** A config listing the given paths, with no rules on any of them. */
function listing(...paths: string[]): VaultConfig {
  return { paths: Object.fromEntries(paths.map((path) => [path, {}])) };
}

function identities(records: VaultRecord[]): string[] {
  return records.map((record) => record.identity);
}

/** Asserts exactly one record was found, and that it parsed. */
function only(records: VaultRecord[]): Extract<VaultRecord, { status: 'parsed' }> {
  assert.equal(records.length, 1, `expected one record, got ${identities(records).join(', ')}`);
  const record = records[0];
  if (record?.status !== 'parsed') assert.fail(`expected a parsed record, got ${record?.status}`);
  return record;
}

describe('findRecords', () => {
  it('finds every record directly in a listed path', async () => {
    const root = await vault({
      'contacts/priya-narayan.md': '',
      'contacts/sam-oyelaran.md': '',
      'events/2026-06-03-standup.md': '',
    });

    const records = await findRecords(root, listing('/contacts', '/events'));

    assert.deepEqual(identities(records), [
      'contacts/priya-narayan',
      'contacts/sam-oyelaran',
      'events/2026-06-03-standup',
    ]);
  });

  it('names the path entry that governs each record', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    assert.equal(only(await findRecords(root, listing('/contacts'))).path, '/contacts');
  });

  it('ignores markdown in a folder that is not listed', async () => {
    const root = await vault({
      'contacts/priya-narayan.md': '',
      'scratch/note.md': '',
    });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('ignores markdown nested below a listed path', async () => {
    const root = await vault({
      'contacts/priya-narayan.md': '',
      'contacts/archive/old-friend.md': '',
    });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('finds records at a nested path that is listed in its own right', async () => {
    const root = await vault({ 'contacts/archive/old-friend.md': '' });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts/archive'))), [
      'contacts/archive/old-friend',
    ]);
  });

  it('ignores files in a listed path that are not markdown', async () => {
    const root = await vault({
      'contacts/priya-narayan.md': '',
      'contacts/priya-narayan.png': '',
      'contacts/notes.txt': '',
      'contacts/md': '',
    });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('ignores a file whose name begins with a dot', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '', 'contacts/.hidden.md': '' });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('finds a record whose name begins with an underscore', async () => {
    const root = await vault({ 'contacts/_draft.md': '' });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/_draft',
    ]);
  });

  it('ignores markdown in a listed path whose own folder begins with a dot', async () => {
    const root = await vault({ '.private/note.md': '', 'contacts/.archive/note.md': '' });

    assert.deepEqual(await findRecords(root, listing('/.private', '/contacts/.archive')), []);
  });

  it('ignores markdown named only for its extension', async () => {
    // `.md` is all extension and no name, and `...md` would name the folder
    // above; both begin with a dot, which is what puts them out of reach.
    const root = await vault({ 'contacts/.md': '', 'contacts/...md': '' });

    assert.deepEqual(await findRecords(root, listing('/contacts')), []);
  });

  it('yields no records for a path key that could never name anything', async () => {
    // The config schema rejects these keys, so a loaded config never holds one;
    // findRecords does not assume its config came through loadConfig.
    const root = await vault({ 'contacts/priya-narayan.md': '' });
    const keys = ['//contacts', '/./contacts', '/../contacts', '/events/../contacts'];

    assert.deepEqual(await findRecords(root, listing(...keys)), []);
  });

  it('reads a record with a header and a body', async () => {
    const root = await vault({
      'events/standup.md': '---\ntitle: Standup\ndate: 2026-06-03\n---\nWe shipped it.\n',
    });

    const record = only(await findRecords(root, listing('/events')));

    assert.deepEqual(record.header, { title: 'Standup', date: '2026-06-03' });
    assert.equal(record.body, 'We shipped it.\n');
  });

  it('reads a record with a header and no body', async () => {
    const root = await vault({ 'events/standup.md': '---\ntitle: Standup\n---\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.deepEqual(record.header, { title: 'Standup' });
    assert.equal('body' in record, false);
  });

  it('reads a record with a body and no header', async () => {
    const root = await vault({ 'events/standup.md': 'We shipped it.\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.equal('header' in record, false);
    assert.equal(record.body, 'We shipped it.\n');
  });

  it('reads a record with neither a header nor a body', async () => {
    const root = await vault({ 'events/standup.md': '' });

    const record = only(await findRecords(root, listing('/events')));

    assert.equal('header' in record, false);
    assert.equal('body' in record, false);
  });

  it('treats a whitespace-only body as no body', async () => {
    const root = await vault({ 'events/standup.md': '---\ntitle: Standup\n---\n\n  \n\t\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.deepEqual(record.header, { title: 'Standup' });
    assert.equal('body' in record, false);
  });

  it('keeps a body verbatim, including the blank line after the header', async () => {
    const root = await vault({ 'events/standup.md': '---\ntitle: Standup\n---\n\nWe shipped it.' });

    assert.equal(only(await findRecords(root, listing('/events'))).body, '\nWe shipped it.');
  });

  it('keeps --- lines further down the file in the body', async () => {
    const body = 'Intro.\n\n---\n\nAfter a break.\n\n---\n\nAnd another.\n';
    const root = await vault({ 'events/standup.md': `---\ntitle: Standup\n---\n${body}` });

    const record = only(await findRecords(root, listing('/events')));

    assert.deepEqual(record.header, { title: 'Standup' });
    assert.equal(record.body, body);
  });

  it('reads a record whose lines end in CRLF', async () => {
    const root = await vault({
      'events/standup.md': '---\r\ntitle: Standup\r\n---\r\nFirst line.\r\nSecond line.\r\n',
    });

    const record = only(await findRecords(root, listing('/events')));

    assert.deepEqual(record.header, { title: 'Standup' });
    assert.equal(record.body, 'First line.\r\nSecond line.\r\n');
  });

  it('treats a file of nothing but whitespace as having no body', async () => {
    const root = await vault({ 'events/standup.md': '   \n\t\n\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.equal('header' in record, false);
    assert.equal('body' in record, false);
  });

  it('takes a --- line as opening a header only at the start of the file', async () => {
    const root = await vault({ 'events/standup.md': 'Preamble.\n---\ntitle: Standup\n---\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.equal('header' in record, false);
    assert.equal(record.body, 'Preamble.\n---\ntitle: Standup\n---\n');
  });

  it('treats an unclosed opening fence as a body, not a header', async () => {
    const root = await vault({ 'events/standup.md': '---\nnot a header\n' });

    const record = only(await findRecords(root, listing('/events')));

    assert.equal('header' in record, false);
    assert.equal(record.body, '---\nnot a header\n');
  });

  it('reports a header that does not parse as a parse violation', async () => {
    const root = await vault({ 'events/standup.md': '---\ntitle: [unclosed\n---\nBody.\n' });

    const records = await findRecords(root, listing('/events'));

    assert.equal(records.length, 1);
    const record = records[0];
    if (record?.status !== 'violation') assert.fail(`expected a violation, got ${record?.status}`);
    assert.equal(record.identity, 'events/standup');
    assert.equal(record.path, '/events');
    assert.equal(record.finding.rule, 'parse');
    assert.equal(record.finding.severity, 'violation');
    assert.equal(record.finding.file, 'events/standup.md');
    assert.equal(record.finding.path, '/events');
    assert.ok(record.finding.message.length > 0);
  });

  it('reports a record that cannot be read as a parse violation', async () => {
    const root = await vault({ 'contacts/archive.md/kept.md': '' });

    const records = await findRecords(root, listing('/contacts'));

    assert.equal(records.length, 1);
    const record = records[0];
    if (record?.status !== 'violation') assert.fail(`expected a violation, got ${record?.status}`);
    assert.equal(record.identity, 'contacts/archive');
    assert.equal(record.finding.rule, 'parse');
    assert.equal(record.finding.severity, 'violation');
    assert.equal(record.finding.file, 'contacts/archive.md');
    assert.ok(record.finding.message.length > 0);
  });

  it('still returns the other records in a path holding an unparseable one', async () => {
    const root = await vault({
      'events/broken.md': '---\ntitle: [unclosed\n---\n',
      'events/standup.md': '---\ntitle: Standup\n---\n',
      'events/retro.md': '---\ntitle: Retro\n---\n',
    });

    const records = await findRecords(root, listing('/events'));

    assert.deepEqual(identities(records), ['events/broken', 'events/retro', 'events/standup']);
    assert.deepEqual(
      records.map((record) => record.status),
      ['violation', 'parsed', 'parsed'],
    );
  });

  it('yields no records for a listed path that is not on disk', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    assert.deepEqual(identities(await findRecords(root, listing('/contacts', '/events'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('yields no records for a listed path that is a file rather than a folder', async () => {
    const root = await vault({ 'events.md': '' });

    assert.deepEqual(await findRecords(root, listing('/events.md')), []);
  });

  it('yields no records for a config listing no paths', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    assert.deepEqual(await findRecords(root, {}), []);
  });

  it('follows a record symlinked in from outside the vault root', async () => {
    const outside = await directory('autofile-outside-');
    await writeFile(join(outside, 'source.md'), '---\ntitle: Elsewhere\n---\nFrom outside.\n');
    const root = await vault({});
    await mkdir(join(root, 'contacts'));
    await symlink(join(outside, 'source.md'), join(root, 'contacts', 'linked-in.md'));

    const record = only(await findRecords(root, listing('/contacts')));

    assert.equal(record.identity, 'contacts/linked-in');
    assert.deepEqual(record.header, { title: 'Elsewhere' });
    assert.equal(record.body, 'From outside.\n');
  });

  it('follows a listed path symlinked to a folder outside the vault root', async () => {
    const outside = await directory('autofile-outside-');
    await writeFile(join(outside, 'source.md'), '---\ntitle: Elsewhere\n---\n');
    const root = await vault({});
    await symlink(outside, join(root, 'contacts'));

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/source',
    ]);
  });

  it('skips a record that is not there, rather than failing the run', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });
    await symlink(join(root, 'contacts', 'gone.md'), join(root, 'contacts', 'dangling.md'));

    assert.deepEqual(identities(await findRecords(root, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('finds records under a vault root reached through a symlink', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });
    const link = join(await directory('autofile-link-'), 'vault');
    await symlink(root, link);

    assert.deepEqual(identities(await findRecords(link, listing('/contacts'))), [
      'contacts/priya-narayan',
    ]);
  });

  it('orders records by identity, byte by byte, whatever order the config lists', async () => {
    const root = await vault({
      'notes/Zulu.md': '',
      'notes/alpha.md': '',
      'notes/alpha.beta.md': '',
      'aa/x.md': '',
    });

    assert.deepEqual(identities(await findRecords(root, listing('/notes', '/aa'))), [
      'aa/x',
      'notes/Zulu',
      'notes/alpha',
      'notes/alpha.beta',
    ]);
  });
});
