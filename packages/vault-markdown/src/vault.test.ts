import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Blob, Finding, Record } from '@autofile/core';

import { MarkdownVault } from './index.ts';
import {
  InvalidContentError,
  InvalidIdentityError,
  RecordParseError,
  UnknownCollectionError,
  VaultConfigError,
  WrongContentError,
} from './errors.ts';

/** A time no test run happens at, so a backdated mtime is unmistakable. */
const BACKDATED = new Date('2020-01-02T03:04:05.000Z');

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a vault root holding the given files, keyed by path from the root. */
async function vault(files: { [path: string]: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-markdown-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

describe('MarkdownVault.open', () => {
  it('reads the collections from autofile.yml', async () => {
    const root = await vault({
      'autofile.yml': `
collections:
  contacts:
    type: record
    title: Contacts
    description: People and organizations.
    schema:
      required: [name]
      properties:
        name: { type: string }
    body: false
  blobs:
    type: blob
`,
    });

    const opened = await MarkdownVault.open(root);

    assert.equal(opened.root, root);
    assert.deepEqual(opened.collections, {
      contacts: {
        type: 'record',
        name: 'contacts',
        title: 'Contacts',
        description: 'People and organizations.',
        schema: { required: ['name'], properties: { name: { type: 'string' } } },
        body: false,
      },
      blobs: { type: 'blob', name: 'blobs' },
    });
  });

  it('opens a config that declares no collections', async () => {
    const root = await vault({ 'autofile.yml': '{}\n' });

    assert.deepEqual((await MarkdownVault.open(root)).collections, {});
  });

  it('rejects a missing autofile.yml', async () => {
    const root = await vault({});

    await assert.rejects(MarkdownVault.open(root), VaultConfigError);
  });

  it('rejects an autofile.yml that cannot be read', async () => {
    const root = await vault({});
    await mkdir(join(root, 'autofile.yml'));

    await assert.rejects(MarkdownVault.open(root), VaultConfigError);
  });

  it('rejects an autofile.yml that does not parse', async () => {
    const root = await vault({ 'autofile.yml': 'collections: [\ncontacts: "\n' });

    await assert.rejects(MarkdownVault.open(root), {
      name: 'VaultConfigError',
      message: /parse/i,
    });
  });

  it('rejects an unknown key in the config', async () => {
    const root = await vault({ 'autofile.yml': 'paths:\n  /contacts: {}\n' });

    await assert.rejects(MarkdownVault.open(root), {
      name: 'VaultConfigError',
      message: /paths/,
    });
  });

  it('rejects an unknown key in a collection', async () => {
    const root = await vault({
      'autofile.yml': 'collections:\n  contacts:\n    type: record\n    filename: {}\n',
    });

    await assert.rejects(MarkdownVault.open(root), {
      name: 'VaultConfigError',
      message: /filename/,
    });
  });

  it('rejects a collection that does not say what it holds', async () => {
    const root = await vault({ 'autofile.yml': 'collections:\n  contacts:\n    title: Contacts\n' });

    await assert.rejects(MarkdownVault.open(root), {
      name: 'VaultConfigError',
      message: /type/,
    });
  });

  it('rejects a collection that holds something other than records or blobs', async () => {
    const root = await vault({ 'autofile.yml': 'collections:\n  contacts:\n    type: records\n' });

    await assert.rejects(MarkdownVault.open(root), VaultConfigError);
  });

  it('rejects a collection name that is not one', async () => {
    const root = await vault({ 'autofile.yml': 'collections:\n  a/b:\n    type: record\n' });

    await assert.rejects(MarkdownVault.open(root), VaultConfigError);
  });

  it('rejects a schema that is not usable as one', async () => {
    // `requred` is legal JSON Schema and a rule that would never fire.
    const root = await vault({
      'autofile.yml': 'collections:\n  contacts:\n    type: record\n    schema:\n      requred: [name]\n',
    });

    await assert.rejects(MarkdownVault.open(root), {
      name: 'VaultConfigError',
      message: /requred/,
    });
  });

  it('accepts a schema whose formats assert', async () => {
    const root = await vault({
      'autofile.yml': `
collections:
  events:
    type: record
    schema:
      properties:
        date: { type: string, format: date }
`,
    });

    assert.deepEqual(Object.keys((await MarkdownVault.open(root)).collections), ['events']);
  });

  it('rejects a second blob collection', async () => {
    const root = await vault({
      'autofile.yml': 'collections:\n  blobs:\n    type: blob\n  files:\n    type: blob\n',
    });

    await assert.rejects(MarkdownVault.open(root), VaultConfigError);
  });

  it('is its config as it was read', async () => {
    const root = await vault({ 'autofile.yml': 'collections:\n  contacts:\n    type: record\n' });

    const opened = await MarkdownVault.open(root);
    await writeFile(join(root, 'autofile.yml'), 'collections:\n  events:\n    type: record\n');

    assert.deepEqual(Object.keys(opened.collections), ['contacts']);
  });
});

/** A vault declaring a record collection and the blob collection both. */
const COLLECTIONS = `
collections:
  contacts:
    type: record
  events:
    type: record
  blobs:
    type: blob
`;

/** Asserts the answer was a record, and narrows to it. */
function record(answer: Record | Blob | null): Record {
  if (answer === null || answer.type !== 'record') {
    assert.fail(`expected a record, got ${answer === null ? 'null' : answer.type}`);
  }
  return answer;
}

/** Asserts the answer was a blob, and narrows to it. */
function blob(answer: Record | Blob | null): Blob {
  if (answer === null || answer.type !== 'blob') {
    assert.fail(`expected a blob, got ${answer === null ? 'null' : answer.type}`);
  }
  return answer;
}

describe('MarkdownVault.get', () => {
  it('reads a record with a header and a body', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\ntype: person\n---\nPrintmaker.\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.equal(answer.id, 'contacts/priya-narayan');
    assert.deepEqual(answer.fields, {
      name: 'Priya Narayan',
      type: 'person',
      body: 'Printmaker.\n',
    });
  });

  it('reads a record that is only a header', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, { name: 'Priya Narayan' });
  });

  it('reads a record that is only a body', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': 'Printmaker.\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, { body: 'Printmaker.\n' });
  });

  it('reads a record with neither a header nor a body', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/blank.md': '' });

    assert.deepEqual(record(await (await MarkdownVault.open(root)).get('contacts/blank')).fields, {});
  });

  it('does not count whitespace below the header as a body', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n\n  \n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, { name: 'Priya Narayan' });
  });

  it('counts an empty header as no fields at all', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/blank.md': '---\n---\n' });

    assert.deepEqual(record(await (await MarkdownVault.open(root)).get('contacts/blank')).fields, {});
  });

  it('keeps the header key order, with the body last', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nzeta: 1\nalpha: 2\nmiddle: 3\n---\nPrintmaker.\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(Object.keys(answer.fields), ['zeta', 'alpha', 'middle', 'body']);
  });

  it('reads a record whose key has several segments', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/family/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    const answer = await (await MarkdownVault.open(root)).get('contacts/family/priya-narayan');

    assert.equal(record(answer).id, 'contacts/family/priya-narayan');
  });

  it('opens the header only at the start of the file', async () => {
    const source = 'Printmaker.\n---\nname: not a header\n---\nAnd more.\n';
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.md': source });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, { body: source });
  });

  it('closes the header only at a line that is one', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\nrule: a---\n---\nPrintmaker.\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, {
      name: 'Priya Narayan',
      rule: 'a---',
      body: 'Printmaker.\n',
    });
  });

  it('takes a body that opens with a thematic break as a body', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\n\nPrintmaker.\n',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, { body: '---\n\nPrintmaker.\n' });
  });

  it('takes created from the file ctime and updated from its mtime', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });
    // Backdating the mtime leaves the ctime at now, so the two are told apart.
    await utimes(join(root, 'contacts/priya-narayan.md'), BACKDATED, BACKDATED);

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));
    const stats = await stat(join(root, 'contacts/priya-narayan.md'));

    assert.equal(answer.updated.getTime(), BACKDATED.getTime());
    assert.equal(answer.created.getTime(), stats.ctime.getTime());
    assert.notEqual(answer.created.getTime(), answer.updated.getTime());
  });

  it('answers null for a key its collection does not hold', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    assert.equal(await (await MarkdownVault.open(root)).get('contacts/nobody'), null);
  });

  it('is an error to name a collection the vault does not declare', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'notes/one.md': '' });

    await assert.rejects(
      (await MarkdownVault.open(root)).get('notes/one'),
      UnknownCollectionError,
    );
  });

  it('is an error to name something that is not spelled as an identity', async () => {
    const opened = await MarkdownVault.open(await vault({ 'autofile.yml': COLLECTIONS }));

    for (const id of ['contacts', 'contacts/', '/priya-narayan', '', '/']) {
      await assert.rejects(opened.get(id), InvalidIdentityError, id);
    }
  });

  it('is an error to name a key with a segment no file can have', async () => {
    const opened = await MarkdownVault.open(await vault({ 'autofile.yml': COLLECTIONS }));

    for (const id of [
      'contacts//priya-narayan',
      'contacts/family//priya-narayan',
      'contacts/family/',
      'contacts/./priya-narayan',
      'contacts/../priya-narayan',
      'contacts/..',
      'contacts/.',
      'blobs/../outside.jpg',
    ]) {
      await assert.rejects(opened.get(id), InvalidIdentityError, id);
    }
  });

  it('is an error to read a record whose header does not parse', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: "unterminated\n---\n',
    });

    await assert.rejects(
      (await MarkdownVault.open(root)).get('contacts/priya-narayan'),
      RecordParseError,
    );
  });

  it('is an error to read a record whose header is not a mapping', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\n- Priya Narayan\n---\n',
    });

    await assert.rejects(
      (await MarkdownVault.open(root)).get('contacts/priya-narayan'),
      RecordParseError,
    );
  });

  it('reads a blob sitting beside the record that references it', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nphoto: "[[blobs/contacts/priya-narayan.jpg]]"\n---\n',
      'contacts/priya-narayan.jpg': 'not really a jpeg',
    });

    const answer = blob(
      await (await MarkdownVault.open(root)).get('blobs/contacts/priya-narayan.jpg'),
    );

    assert.equal(answer.id, 'blobs/contacts/priya-narayan.jpg');
    assert.equal(answer.content.type, 'image/jpeg');
    assert.equal(answer.content.size, 17);
    assert.equal(await answer.content.text(), 'not really a jpeg');
  });

  it('takes a blob timestamps from the file the same way', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'site/index.html': '<p>hi</p>' });
    await utimes(join(root, 'site/index.html'), BACKDATED, BACKDATED);

    const answer = blob(await (await MarkdownVault.open(root)).get('blobs/site/index.html'));
    const stats = await stat(join(root, 'site/index.html'));

    assert.equal(answer.content.type, 'text/html');
    assert.equal(answer.updated.getTime(), BACKDATED.getTime());
    assert.equal(answer.created.getTime(), stats.ctime.getTime());
    assert.notEqual(answer.created.getTime(), answer.updated.getTime());
  });

  it('gives a name that is nothing but a dot and a suffix no media type', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, '.jpg': 'bytes' });

    assert.equal(
      blob(await (await MarkdownVault.open(root)).get('blobs/.jpg')).content.type,
      'application/octet-stream',
    );
  });

  it('gives a blob whose extension says nothing the general media type', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'scan.wat': 'bytes' });

    assert.equal(blob(await (await MarkdownVault.open(root)).get('blobs/scan.wat')).content.type, 'application/octet-stream');
  });

  it('counts the config as a blob, like every other file that is not a record', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    assert.equal(blob(await (await MarkdownVault.open(root)).get('blobs/autofile.yml')).id, 'blobs/autofile.yml');
  });

  it('counts a markdown file outside a record collection as a blob', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'notes/one.md': 'a note' });

    assert.equal(blob(await (await MarkdownVault.open(root)).get('blobs/notes/one.md')).id, 'blobs/notes/one.md');
  });

  it('does not answer with a record when asked for it as a blob', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.md': '' });

    assert.equal(await (await MarkdownVault.open(root)).get('blobs/contacts/priya-narayan.md'), null);
  });

  it('answers null for a blob key that names a folder or nothing', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.md': '' });
    const opened = await MarkdownVault.open(root);

    assert.equal(await opened.get('blobs/contacts'), null);
    assert.equal(await opened.get('blobs/nothing/here.jpg'), null);
  });

  it('converts a field that is a wikilink into a reference', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': `---
photo: "[[blobs/contacts/priya-narayan.jpg]]"
related:
  - "[[events/2026-06-02-zine-paper-chat]]"
  - "[[events/2026-06-09-studio-visit]]"
nested:
  by:
    hand: "[[contacts/sam-oyelaran]]"
  list:
    - { of: "[[contacts/sam-oyelaran]]" }
prose: see "[[contacts/sam-oyelaran]]" for more
filed_from: contacts/priya-narayan
---
`,
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.deepEqual(answer.fields, {
      photo: { $ref: 'blobs/contacts/priya-narayan.jpg' },
      related: [
        { $ref: 'events/2026-06-02-zine-paper-chat' },
        { $ref: 'events/2026-06-09-studio-visit' },
      ],
      nested: {
        by: { hand: { $ref: 'contacts/sam-oyelaran' } },
        list: [{ of: { $ref: 'contacts/sam-oyelaran' } }],
      },
      prose: 'see "[[contacts/sam-oyelaran]]" for more',
      filed_from: 'contacts/priya-narayan',
    });
  });

  it('leaves the links in a body to markdown', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n[[contacts/sam-oyelaran]]',
    });

    const answer = record(await (await MarkdownVault.open(root)).get('contacts/priya-narayan'));

    assert.equal(answer.fields['body'], '[[contacts/sam-oyelaran]]');
  });
});

describe('MarkdownVault.list', () => {
  it('lists a collection ordered bytewise by key', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/a.md': '',
      'contacts/a.b.md': '',
      'contacts/Zeta.md': '',
      'contacts/zeta.md': '',
      'contacts/éclair.md': '',
      'contacts/family/priya-narayan.md': '',
    });

    const items = await (await MarkdownVault.open(root)).list('contacts');

    // Sorted on the key rather than the filename, which would put `a.b` first;
    // byte by byte rather than by locale, which would not put `éclair` last.
    assert.deepEqual(
      items.map((item) => item.id),
      [
        'contacts/Zeta',
        'contacts/a',
        'contacts/a.b',
        'contacts/family/priya-narayan',
        'contacts/zeta',
        'contacts/éclair',
      ],
    );
  });

  it('lists the records themselves', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nPrintmaker.\n',
    });

    const items = await (await MarkdownVault.open(root)).list('contacts');

    assert.equal(items.length, 1);
    assert.deepEqual(record(items[0] ?? null).fields, {
      name: 'Priya Narayan',
      body: 'Printmaker.\n',
    });
  });

  it('answers with nothing for a collection that is real and empty', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    assert.deepEqual(await (await MarkdownVault.open(root)).list('events'), []);
  });

  it('does not read a collection it cannot read as an empty one', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    // A folder that is not there is a collection with nothing in it; one that
    // cannot be read is a vault that is broken, and saying `[]` would hide it.
    await symlink('contacts', join(root, 'contacts'));

    await assert.rejects((await MarkdownVault.open(root)).list('contacts'), { code: 'ELOOP' });
  });

  it('is an error to list a collection the vault does not declare', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'notes/one.md': '' });

    await assert.rejects((await MarkdownVault.open(root)).list('notes'), UnknownCollectionError);
  });

  it('is an error to list a collection holding a record that cannot be read', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: "unterminated\n---\n',
    });

    await assert.rejects((await MarkdownVault.open(root)).list('contacts'), RecordParseError);
  });

  it('leaves out of a record collection what is not a record', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '',
      'contacts/priya-narayan.jpg': 'bytes',
      'contacts/notes.txt': 'text',
    });

    const items = await (await MarkdownVault.open(root)).list('contacts');

    assert.deepEqual(
      items.map((item) => item.id),
      ['contacts/priya-narayan'],
    );
  });

  it('leaves out a file whose key would have a segment no file can have', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '',
      'contacts/.md': '',
      'contacts/..md': '',
    });

    const items = await (await MarkdownVault.open(root)).list('contacts');

    assert.deepEqual(
      items.map((item) => item.id),
      ['contacts/priya-narayan'],
    );
  });

  it('lists every file in the vault that is not a record as a blob', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '',
      'contacts/priya-narayan.jpg': 'bytes',
      'notes/one.md': 'a note',
      'site/index.html': '<p>hi</p>',
      '.hidden': 'still a file',
    });

    const items = await (await MarkdownVault.open(root)).list('blobs');

    assert.deepEqual(
      items.map((item) => item.id),
      [
        'blobs/.hidden',
        'blobs/autofile.yml',
        'blobs/contacts/priya-narayan.jpg',
        'blobs/notes/one.md',
        'blobs/site/index.html',
      ],
    );
    assert.equal(blob(items[3] ?? null).content.type, 'text/markdown');
  });

  it('lists nothing but the config when the vault holds only records', async () => {
    const root = await vault({
      'autofile.yml': 'collections:\n  contacts:\n    type: record\n  blobs:\n    type: blob\n',
      'contacts/priya-narayan.md': '',
    });
    // The config itself is a file the vault holds, so removing it is the only
    // way to have nothing but records; a vault with no config does not open.
    const items = await (await MarkdownVault.open(root)).list('blobs');

    assert.deepEqual(
      items.map((item) => item.id),
      ['blobs/autofile.yml'],
    );
  });
});

/** What is at a path below a vault root, as text. */
async function source(root: string, path: string): Promise<string> {
  return await readFile(join(root, path), 'utf8');
}

describe('MarkdownVault.put', () => {
  it('writes a record as a header and the region below it', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      name: 'Priya Narayan',
      type: 'person',
      body: 'Printmaker.\n',
    });

    assert.equal(
      await source(root, 'contacts/priya-narayan.md'),
      '---\nname: Priya Narayan\ntype: person\n---\nPrintmaker.\n',
    );
  });

  it('writes a record whose only field is a body with no header', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      body: 'Printmaker.\n',
    });

    assert.equal(await source(root, 'contacts/priya-narayan.md'), 'Printmaker.\n');
  });

  it('writes a record with no body field with nothing below the header', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      name: 'Priya Narayan',
    });

    assert.equal(await source(root, 'contacts/priya-narayan.md'), '---\nname: Priya Narayan\n---\n');
  });

  it('writes a record with no fields at all as an empty file', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/blank', {});

    assert.equal(await source(root, 'contacts/blank.md'), '');
  });

  it('writes the body below the header wherever the field sat', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      zeta: 1,
      body: 'Printmaker.\n',
      alpha: 2,
    });

    assert.equal(
      await source(root, 'contacts/priya-narayan.md'),
      '---\nzeta: 1\nalpha: 2\n---\nPrintmaker.\n',
    );
  });

  it('creates whatever folders a key implies', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/family/kin/priya-narayan', {
      name: 'Priya Narayan',
    });

    assert.equal(
      await source(root, 'contacts/family/kin/priya-narayan.md'),
      '---\nname: Priya Narayan\n---\n',
    );
  });

  it('writes the header from the fields rather than merging into what was there', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\n# who this is\nname: Priya Narayan\ntype: person\n---\nOld.\n',
    });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', { name: 'Priya N.' });

    assert.equal(await source(root, 'contacts/priya-narayan.md'), '---\nname: Priya N.\n---\n');
  });

  it('answers with the record as the vault now holds it', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    const answer = record(
      await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
        body: 'Printmaker.\n',
        name: 'Priya Narayan',
      }),
    );
    const stats = await stat(join(root, 'contacts/priya-narayan.md'));

    assert.equal(answer.id, 'contacts/priya-narayan');
    // The order it comes out in is the order it is stored in, with the body
    // below the header, so `put` and a later `get` answer the same thing.
    assert.deepEqual(Object.keys(answer.fields), ['name', 'body']);
    assert.deepEqual(answer.fields, { name: 'Priya Narayan', body: 'Printmaker.\n' });
    assert.equal(answer.created.getTime(), stats.ctime.getTime());
    assert.equal(answer.updated.getTime(), stats.mtime.getTime());
  });

  it('writes references back as quoted wikilinks, at any depth', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      photo: { $ref: 'blobs/contacts/priya-narayan.jpg' },
      related: [{ $ref: 'events/2026-06-02-zine-paper-chat' }],
      nested: { by: { hand: { $ref: 'contacts/sam-oyelaran' } } },
      deep: [[{ $ref: 'contacts/sam-oyelaran' }]],
    });

    assert.equal(
      await source(root, 'contacts/priya-narayan.md'),
      `---
photo: "[[blobs/contacts/priya-narayan.jpg]]"
related:
  - "[[events/2026-06-02-zine-paper-chat]]"
nested:
  by:
    hand: "[[contacts/sam-oyelaran]]"
deep:
  - - "[[contacts/sam-oyelaran]]"
---
`,
    );
  });

  it('leaves the wikilinks in a body to markdown', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      body: 'See [[contacts/sam-oyelaran]].\n',
    });

    assert.equal(await source(root, 'contacts/priya-narayan.md'), 'See [[contacts/sam-oyelaran]].\n');
  });
});

/**
 * Reads a record from the source given, writes it straight back, and answers
 * with what is on disk afterwards. Writing is the inverse of reading, so the
 * two are the same bytes.
 */
async function roundTrip(source: string): Promise<string> {
  const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.md': source });
  const opened = await MarkdownVault.open(root);
  const before = record(await opened.get('contacts/priya-narayan'));
  await opened.put('contacts/priya-narayan', before.fields);
  return await readFile(join(root, 'contacts/priya-narayan.md'), 'utf8');
}

describe('a record written back unchanged', () => {
  it('is byte-identical with a header and a body', async () => {
    const source = '---\nname: Priya Narayan\ntype: person\n---\nPrintmaker.\n\nGood on paper.\n';

    assert.equal(await roundTrip(source), source);
  });

  it('is byte-identical with only a header', async () => {
    const source = '---\nname: Priya Narayan\n---\n';

    assert.equal(await roundTrip(source), source);
  });

  it('is byte-identical with only a body', async () => {
    const source = 'Printmaker.\n';

    assert.equal(await roundTrip(source), source);
  });

  it('is byte-identical with neither', async () => {
    assert.equal(await roundTrip(''), '');
  });

  it('is byte-identical with references at depth', async () => {
    const source = `---
photo: "[[blobs/contacts/priya-narayan.jpg]]"
related:
  - "[[events/2026-06-02-zine-paper-chat]]"
  - "[[events/2026-06-09-studio-visit]]"
nested:
  by:
    hand: "[[contacts/sam-oyelaran]]"
  list:
    - of: "[[contacts/sam-oyelaran]]"
deep:
  - - "[[contacts/sam-oyelaran]]"
prose: see "[[contacts/sam-oyelaran]]" for more
filed_from: contacts/priya-narayan
---
See [[contacts/sam-oyelaran]] too.
`;

    assert.equal(await roundTrip(source), source);
  });

  it('is byte-identical with unusual but legal YAML in the header', async () => {
    const source = `---
scalars:
  int: 1
  float: 1.5
  yes: true
  nothing: null
  date: 2026-06-02
looks-like:
  one: "1"
  "true": "true"
  "null": "null"
  tilde: "~"
strings:
  empty: ""
  spaced: " lead and trail "
  tabbed: "\\t"
  hash: "#not a comment"
  dash: ---
  colon: ": y"
  crlf: "one\\r\\ntwo"
  long: ${'word '.repeat(40).trim()}
block: |-
  one
  two
"---": a key that is a rule
"": an empty key
a b: a key with a space
é: çà 🙂
containers:
  list: []
  map: {}
  ragged:
    - 1
    - a: 2
    - - 3
---
Below.
`;

    assert.equal(await roundTrip(source), source);
  });

  it('reads back from a write as the fields that went in', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const opened = await MarkdownVault.open(root);
    const fields = {
      name: 'Priya Narayan',
      related: [{ $ref: 'events/2026-06-02-zine-paper-chat' }],
      nested: { by: { hand: { $ref: 'contacts/sam-oyelaran' } } },
      count: 3,
      body: 'Printmaker.\n',
    };

    await opened.put('contacts/priya-narayan', fields);

    assert.deepEqual(record(await opened.get('contacts/priya-narayan')).fields, fields);
  });

  it('is byte-identical however many times it goes round', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const opened = await MarkdownVault.open(root);
    const file = join(root, 'contacts/priya-narayan.md');

    await opened.put('contacts/priya-narayan', {
      name: 'Priya Narayan',
      note: 'word '.repeat(40).trim(),
      body: 'Printmaker.\n',
    });
    const once = await readFile(file, 'utf8');
    await opened.put(
      'contacts/priya-narayan',
      record(await opened.get('contacts/priya-narayan')).fields,
    );

    assert.equal(await readFile(file, 'utf8'), once);
  });
});

describe('MarkdownVault.put on a blob', () => {
  it('writes a blob as its bytes', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put(
      'blobs/site/index.html',
      new globalThis.Blob(['<p>hi</p>']),
    );

    assert.equal(await source(root, 'site/index.html'), '<p>hi</p>');
  });

  it('writes the bytes it was given rather than their text', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

    const answer = blob(
      await (await MarkdownVault.open(root)).put('blobs/photo.png', new globalThis.Blob([bytes])),
    );

    assert.deepEqual(new Uint8Array(await answer.content.arrayBuffer()), bytes);
    assert.deepEqual(new Uint8Array(await readFile(join(root, 'photo.png'))), bytes);
  });

  it('creates whatever folders a blob key implies', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).put(
      'blobs/assets/site/deep/index.html',
      new globalThis.Blob(['<p>hi</p>']),
    );

    assert.equal(await source(root, 'assets/site/deep/index.html'), '<p>hi</p>');
  });

  it('answers with the blob, timestamps and all', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    const answer = blob(
      await (await MarkdownVault.open(root)).put(
        'blobs/site/index.html',
        new globalThis.Blob(['<p>hi</p>']),
      ),
    );
    const stats = await stat(join(root, 'site/index.html'));

    assert.equal(answer.id, 'blobs/site/index.html');
    assert.equal(answer.content.size, 9);
    assert.equal(answer.created.getTime(), stats.ctime.getTime());
    assert.equal(answer.updated.getTime(), stats.mtime.getTime());
  });

  it('does not store the media type it was handed', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const opened = await MarkdownVault.open(root);

    // The extension says what the bytes are, so the `content.type` on the way
    // in is only ever confirming it — or, here, contradicting it.
    const answer = blob(
      await opened.put('blobs/photo.jpg', new globalThis.Blob(['bytes'], { type: 'text/plain' })),
    );

    assert.equal(answer.content.type, 'image/jpeg');
    assert.equal(blob(await opened.get('blobs/photo.jpg')).content.type, 'image/jpeg');
  });

  it('replaces the bytes that were there', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'site/index.html': '<p>old</p>' });

    await (await MarkdownVault.open(root)).put(
      'blobs/site/index.html',
      new globalThis.Blob(['<p>new</p>']),
    );

    assert.equal(await source(root, 'site/index.html'), '<p>new</p>');
  });

  it('refuses a blob key that names a record file', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    // A `.md` file in a record collection is a record, so nothing can file a
    // blob there: `get` would answer null for what had just been written.
    await assert.rejects(
      (await MarkdownVault.open(root)).put(
        'blobs/contacts/priya-narayan.md',
        new globalThis.Blob(['bytes']),
      ),
      InvalidIdentityError,
    );
    assert.equal(await (await MarkdownVault.open(root)).get('blobs/contacts/priya-narayan.md'), null);
  });

  it('refuses fields where a collection holds blobs', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await assert.rejects(
      (await MarkdownVault.open(root)).put('blobs/site/index.html', { name: 'Priya Narayan' }),
      WrongContentError,
    );
  });

  it('refuses bytes where a collection holds records', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await assert.rejects(
      (await MarkdownVault.open(root)).put(
        'contacts/priya-narayan',
        new globalThis.Blob(['bytes']),
      ),
      WrongContentError,
    );
  });

  it('refuses an identity the vault cannot hold, whatever it was handed', async () => {
    const opened = await MarkdownVault.open(await vault({ 'autofile.yml': COLLECTIONS }));

    await assert.rejects(opened.put('contacts', { name: 'Priya Narayan' }), InvalidIdentityError);
    await assert.rejects(opened.put('contacts/../out', { name: 'x' }), InvalidIdentityError);
    await assert.rejects(opened.put('notes/one', { name: 'x' }), UnknownCollectionError);
  });
});

/** Whether a path below a vault root is there at all. */
async function exists(root: string, path: string): Promise<boolean> {
  try {
    await stat(join(root, path));
    return true;
  } catch {
    return false;
  }
}

describe('MarkdownVault.remove', () => {
  it('deletes a record file', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });
    const opened = await MarkdownVault.open(root);

    await opened.remove('contacts/priya-narayan');

    assert.equal(await exists(root, 'contacts/priya-narayan.md'), false);
    assert.equal(await opened.get('contacts/priya-narayan'), null);
  });

  it('deletes a blob file', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'site/index.html': '<p>hi</p>' });

    await (await MarkdownVault.open(root)).remove('blobs/site/index.html');

    assert.equal(await exists(root, 'site/index.html'), false);
  });

  it('deletes any parent folder it leaves empty', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/family/kin/priya-narayan.md': '',
    });

    await (await MarkdownVault.open(root)).remove('contacts/family/kin/priya-narayan');

    assert.equal(await exists(root, 'contacts/family/kin'), false);
    assert.equal(await exists(root, 'contacts/family'), false);
  });

  it('leaves a parent folder that still holds something', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/family/priya-narayan.md': '',
      'contacts/family/sam-oyelaran.md': '',
    });

    await (await MarkdownVault.open(root)).remove('contacts/family/priya-narayan');

    assert.equal(await exists(root, 'contacts/family'), true);
  });

  it('leaves a parent folder holding something that is not a record', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/family/priya-narayan.md': '',
      'contacts/family/priya-narayan.jpg': 'bytes',
    });

    await (await MarkdownVault.open(root)).remove('contacts/family/priya-narayan');

    assert.equal(await exists(root, 'contacts/family'), true);
  });

  it("stops at a collection's own folder", async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/family/priya.md': '' });

    await (await MarkdownVault.open(root)).remove('contacts/family/priya');

    // An empty collection folder is a vault that has changed shape rather than
    // one that has been tidied, so it stays.
    assert.equal(await exists(root, 'contacts/family'), false);
    assert.equal(await exists(root, 'contacts'), true);
  });

  it("stops at a collection's own folder when what it removed was a blob", async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.jpg': 'bytes' });

    await (await MarkdownVault.open(root)).remove('blobs/contacts/priya-narayan.jpg');

    assert.equal(await exists(root, 'contacts'), true);
  });

  it('stops at the vault root', async () => {
    // Removing the config as a blob is the only way to empty a vault root, a
    // config being the one file every vault has.
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await (await MarkdownVault.open(root)).remove('blobs/autofile.yml');

    assert.equal(await exists(root, '.'), true);
  });

  it('deletes a folder that is named for no collection', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'blobs/deep/one.txt': 'text' });

    // The blob collection is not a folder of its own, so a folder that happens
    // to share its name is an ordinary folder.
    await (await MarkdownVault.open(root)).remove('blobs/blobs/deep/one.txt');

    assert.equal(await exists(root, 'blobs'), false);
  });

  it('is not an error to remove what is not there', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const opened = await MarkdownVault.open(root);

    await opened.remove('contacts/nobody');
    await opened.remove('blobs/nothing/here.jpg');
    await opened.remove('blobs/contacts');
  });

  it('leaves a record where a blob key names its file', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/priya-narayan.md': '' });

    await (await MarkdownVault.open(root)).remove('blobs/contacts/priya-narayan.md');

    assert.equal(await exists(root, 'contacts/priya-narayan.md'), true);
  });

  it('refuses an identity the vault cannot hold', async () => {
    const opened = await MarkdownVault.open(await vault({ 'autofile.yml': COLLECTIONS }));

    await assert.rejects(opened.remove('contacts'), InvalidIdentityError);
    await assert.rejects(opened.remove('contacts/../out'), InvalidIdentityError);
    await assert.rejects(opened.remove('notes/one'), UnknownCollectionError);
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

/** A vault's findings, less the warnings about the collections left empty. */
async function violations(root: string): Promise<Finding[]> {
  return (await (await MarkdownVault.open(root)).validate()).filter(
    (finding) => finding.rule !== 'empty',
  );
}

describe('MarkdownVault.validate', () => {
  it('answers with nothing for a vault that keeps its own rules', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
      'events/zine-paper-chat.md': '---\ndate: 2026-06-02\n---\nWe talked paper.\n',
      'contacts/priya-narayan.jpg': 'bytes',
    });

    assert.deepEqual(await (await MarkdownVault.open(root)).validate(), []);
  });

  it("reports a record whose fields fail its collection's schema", async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\nname: 7\n---\n',
    });

    assert.deepEqual(await violations(root), [
      {
        rule: 'schema',
        severity: 'violation',
        id: 'contacts/priya-narayan',
        collection: 'contacts',
        message: '/name: must be string',
      },
    ]);
  });

  it('checks a record with no fields as having none', async () => {
    const root = await vault({ 'autofile.yml': CHECKED, 'contacts/blank.md': '' });

    const findings = await violations(root);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, 'schema');
    assert.match(findings[0]?.message ?? '', /name/);
  });

  it('checks the formats a schema asserts', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'events/zine-paper-chat.md': '---\ndate: the second of June\n---\n',
    });

    const findings = await violations(root);

    assert.equal(findings[0]?.rule, 'schema');
    assert.match(findings[0]?.message ?? '', /date/);
  });

  it('checks the body among the fields', async () => {
    const root = await vault({
      'autofile.yml': `
collections:
  notes:
    type: record
    schema:
      required: [body]
`,
      'notes/one.md': '---\ntitle: One\n---\n',
      'notes/two.md': '---\ntitle: Two\n---\nSomething.\n',
    });

    const findings = await violations(root);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.id, 'notes/one');
  });

  it('checks nothing against a collection that declares no schema', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/priya-narayan.md': '---\nanything: at all\n---\n',
    });

    assert.deepEqual(await violations(root), []);
  });

  it('reports a record with a body where its collection allows none', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nPrintmaker.\n',
    });

    assert.deepEqual(await violations(root), [
      {
        rule: 'body',
        severity: 'violation',
        id: 'contacts/priya-narayan',
        collection: 'contacts',
        message: 'it has a body where its collection allows none',
      },
    ]);
  });

  it('allows a body where a collection says nothing about one', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'events/zine-paper-chat.md': '---\ndate: 2026-06-02\n---\nWe talked paper.\n',
    });

    assert.deepEqual(await violations(root), []);
  });

  it('reports a record whose header does not parse', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\nname: "unterminated\n---\n',
    });

    const findings = await violations(root);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, 'parse');
    assert.equal(findings[0]?.id, 'contacts/priya-narayan');
    assert.equal(findings[0]?.collection, 'contacts');
  });

  it('reports a record whose header is not a mapping', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\n- Priya Narayan\n---\n',
    });

    assert.deepEqual(
      (await violations(root)).map((finding) => finding.rule),
      ['parse'],
    );
  });

  it('says nothing more about a record it could not read', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      // Unreadable, and would break the schema and the body rule both.
      'contacts/priya-narayan.md': '---\nname: "unterminated\n---\nPrintmaker.\n',
    });

    assert.deepEqual(
      (await violations(root)).map((finding) => finding.rule),
      ['parse'],
    );
  });

  it('does not stop at the first record it cannot read', async () => {
    const root = await vault({
      'autofile.yml': CHECKED,
      'contacts/a.md': '---\nname: "unterminated\n---\n',
      'contacts/b.md': '---\nname: 7\n---\n',
    });

    assert.deepEqual(
      (await violations(root)).map((finding) => finding.id),
      ['contacts/a', 'contacts/b'],
    );
  });

  it('reports a key with a segment no file can have', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/.md': '',
      'contacts/..md': '',
      'contacts/family/.md': '',
    });

    assert.deepEqual(
      (await violations(root)).map((finding) => ({ rule: finding.rule, id: finding.id })),
      [
        { rule: 'key', id: 'contacts/' },
        { rule: 'key', id: 'contacts/.' },
        { rule: 'key', id: 'contacts/family/' },
      ],
    );
  });

  it('reports a key that is not in Unicode NFC', async () => {
    // `e` and a combining acute, which NFC composes into one code point.
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/cafe\u0301.md': '' });

    const findings = await violations(root);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, 'key');
    assert.equal(findings[0]?.id, 'contacts/cafe\u0301');
    assert.match(findings[0]?.message ?? '', /NFC/);
  });

  it('reports a key holding a control character', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'contacts/ab.md': '' });

    const findings = await violations(root);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, 'key');
    assert.match(findings[0]?.message ?? '', /control/);
  });

  it('reports a blob key the same way', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS, 'site/cafe\u0301.html': '' });

    assert.deepEqual(
      (await violations(root)).map((finding) => ({
        rule: finding.rule,
        id: finding.id,
        collection: finding.collection,
      })),
      [{ rule: 'key', id: 'blobs/site/cafe\u0301.html', collection: 'blobs' }],
    );
  });

  it('reports two keys that differ only by case', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'contacts/Priya-Narayan.md': '',
      'contacts/priya-narayan.md': '',
      'contacts/sam-oyelaran.md': '',
    });

    assert.deepEqual(await violations(root), [
      {
        rule: 'collision',
        severity: 'violation',
        id: 'contacts/Priya-Narayan',
        collection: 'contacts',
        message: "its key differs only by case from 'priya-narayan'",
      },
      {
        rule: 'collision',
        severity: 'violation',
        id: 'contacts/priya-narayan',
        collection: 'contacts',
        message: "its key differs only by case from 'Priya-Narayan'",
      },
    ]);
  });

  it('reports colliding blob keys too', async () => {
    const root = await vault({
      'autofile.yml': COLLECTIONS,
      'site/Index.html': '',
      'site/index.html': '',
    });

    assert.deepEqual(
      (await violations(root)).map((finding) => finding.id),
      ['blobs/site/Index.html', 'blobs/site/index.html'],
    );
  });

  it('warns about a collection with nothing in it', async () => {
    const root = await vault({ 'autofile.yml': CHECKED });

    assert.deepEqual(await (await MarkdownVault.open(root)).validate(), [
      {
        rule: 'empty',
        severity: 'warning',
        collection: 'contacts',
        message: 'nothing is filed into it',
      },
      {
        rule: 'empty',
        severity: 'warning',
        collection: 'events',
        message: 'nothing is filed into it',
      },
    ]);
  });

  it('warns about a collection whose folder is not one', async () => {
    const root = await vault({ 'autofile.yml': CHECKED, contacts: 'not a folder' });

    assert.deepEqual(
      (await (await MarkdownVault.open(root)).validate())
        .filter((finding) => finding.rule === 'empty')
        .map((finding) => finding.collection),
      ['contacts', 'events'],
    );
  });

  it('does not warn about a collection holding only what is not a record', async () => {
    const root = await vault({ 'autofile.yml': CHECKED, 'contacts/priya-narayan.jpg': 'bytes' });

    // The image is filed into the blob collection rather than into `contacts`,
    // which therefore holds nothing.
    assert.deepEqual(
      (await (await MarkdownVault.open(root)).validate()).map((finding) => finding.collection),
      ['contacts', 'events'],
    );
  });

  it('puts violations before warnings, in an order a second run repeats', async () => {
    const root = await vault({
      // Declared in an order the answer must not follow, so the config's key
      // order cannot pass for the bytewise one.
      'autofile.yml': `
collections:
  events:
    type: record
    schema: { required: [date] }
  contacts:
    type: record
    schema: { required: [name] }
    body: false
  notes:
    type: record
  archive:
    type: record
  blobs:
    type: blob
`,
      'events/zeta.md': '---\nname: no date\n---\n',
      'events/alpha.md': '---\nname: no date\n---\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nPrintmaker.\n',
    });
    const opened = await MarkdownVault.open(root);

    const findings = await opened.validate();

    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.rule, finding.id ?? finding.collection]),
      [
        ['violation', 'body', 'contacts/priya-narayan'],
        ['violation', 'schema', 'events/alpha'],
        ['violation', 'schema', 'events/zeta'],
        ['warning', 'empty', 'archive'],
        ['warning', 'empty', 'notes'],
      ],
    );
    assert.deepEqual(await opened.validate(), findings);
  });
});

describe('MarkdownVault.put on a record it will not hold', () => {
  it("refuses fields that fail the collection's schema, and writes nothing", async () => {
    const root = await vault({ 'autofile.yml': CHECKED });
    const opened = await MarkdownVault.open(root);

    await assert.rejects(opened.put('contacts/priya-narayan', { name: 7 }), (error: unknown) => {
      assert.ok(error instanceof InvalidContentError);
      assert.deepEqual(error.findings, [
        {
          rule: 'schema',
          severity: 'violation',
          id: 'contacts/priya-narayan',
          collection: 'contacts',
          message: '/name: must be string',
        },
      ]);
      return true;
    });
    assert.equal(await exists(root, 'contacts/priya-narayan.md'), false);
  });

  it('refuses a body where the collection allows none', async () => {
    const root = await vault({ 'autofile.yml': CHECKED });

    await assert.rejects(
      (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
        name: 'Priya Narayan',
        body: 'Printmaker.\n',
      }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidContentError);
        assert.deepEqual(
          error.findings.map((finding) => finding.rule),
          ['body'],
        );
        return true;
      },
    );
  });

  it('refuses exactly what validate would report of the same record', async () => {
    const written = await vault({
      'autofile.yml': CHECKED,
      'contacts/priya-narayan.md': '---\nname: 7\n---\nPrintmaker.\n',
    });
    const root = await vault({ 'autofile.yml': CHECKED });

    const refused = await (await MarkdownVault.open(root))
      .put('contacts/priya-narayan', { name: 7, body: 'Printmaker.\n' })
      .then(() => assert.fail('expected a refusal'))
      .catch((error: unknown) => (error as InvalidContentError).findings);

    assert.deepEqual(refused, await violations(written));
  });

  it('refuses a key that is not in Unicode NFC', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await assert.rejects(
      (await MarkdownVault.open(root)).put('contacts/cafe\u0301', {}),
      InvalidContentError,
    );
    assert.equal(await exists(root, 'contacts'), false);
  });

  it('refuses a key holding a control character', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await assert.rejects(
      (await MarkdownVault.open(root)).put('contacts/a\u0001b', {}),
      InvalidContentError,
    );
  });

  it('refuses a key too long for the filesystem', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const opened = await MarkdownVault.open(root);

    // The name a record's key becomes carries the `.md` too, so the limit is
    // reached three characters before the key itself is that long.
    await opened.put(`contacts/${'a'.repeat(252)}`, {});
    await assert.rejects(opened.put(`contacts/${'a'.repeat(253)}`, {}), InvalidContentError);
  });

  it('counts a key in bytes rather than in characters', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    // 128 of a two-byte character is 256 bytes, over the limit a filesystem
    // counts in even though it is well under 255 characters.
    await assert.rejects(
      (await MarkdownVault.open(root)).put(`blobs/${'é'.repeat(128)}`, new globalThis.Blob(['x'])),
      InvalidContentError,
    );
  });

  it('refuses a blob key the same way, and writes nothing', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    await assert.rejects(
      (await MarkdownVault.open(root)).put('blobs/site/cafe\u0301.html', new globalThis.Blob(['x'])),
      InvalidContentError,
    );
    assert.equal(await exists(root, 'site'), false);
  });

  it('holds a record that keeps the rules', async () => {
    const root = await vault({ 'autofile.yml': CHECKED });

    const answer = record(
      await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
        name: 'Priya Narayan',
      }),
    );

    assert.equal(answer.id, 'contacts/priya-narayan');
    assert.deepEqual(await (await MarkdownVault.open(root)).validate(), [
      {
        rule: 'empty',
        severity: 'warning',
        collection: 'events',
        message: 'nothing is filed into it',
      },
    ]);
  });
});

describe('MarkdownVault.put on a body that is not text', () => {
  it('refuses it rather than writing what it stringifies to', async () => {
    const opened = await MarkdownVault.open(await vault({ 'autofile.yml': COLLECTIONS }));

    for (const body of [42, true, { of: 'sorts' }, ['one']]) {
      await assert.rejects(opened.put('contacts/priya-narayan', { body }), (error: unknown) => {
        assert.ok(error instanceof InvalidContentError);
        assert.deepEqual(
          error.findings.map((finding) => finding.rule),
          ['body'],
        );
        return true;
      });
    }
  });

  it('holds a body that is text, including an empty one', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    // An empty body is nothing below the header, which is what no body is.
    const answer = record(
      await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
        name: 'Priya Narayan',
        body: '',
      }),
    );

    assert.deepEqual(answer.fields, { name: 'Priya Narayan' });
    assert.equal(await source(root, 'contacts/priya-narayan.md'), '---\nname: Priya Narayan\n---\n');
  });
});

describe('a field value that is not plain data', () => {
  it('is written as the YAML writer spells it rather than walked into', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });

    // Only arrays and plain objects can hold a reference inside them, so
    // anything else goes to the writer whole: walking a Date for references
    // would empty it, and a field the header drops is not one it carries.
    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', {
      when: new Date('2026-06-02T09:12:44.000Z'),
    });

    assert.equal(
      await source(root, 'contacts/priya-narayan.md'),
      '---\nwhen: 2026-06-02T09:12:44.000Z\n---\n',
    );
  });

  it('still finds the references inside a plain object made without a prototype', async () => {
    const root = await vault({ 'autofile.yml': COLLECTIONS });
    const bare = Object.assign(Object.create(null), { of: { $ref: 'contacts/sam-oyelaran' } });

    await (await MarkdownVault.open(root)).put('contacts/priya-narayan', { nested: bare });

    assert.equal(
      await source(root, 'contacts/priya-narayan.md'),
      '---\nnested:\n  of: "[[contacts/sam-oyelaran]]"\n---\n',
    );
  });
});
