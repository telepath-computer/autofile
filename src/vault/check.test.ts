import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkVault } from './check.ts';
import { type VaultConfig, loadConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { findRecords } from './records.ts';

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a vault root holding the given files, keyed by path from the root. */
async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-check-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

/**
 * Builds a vault from the given files and checks it, through the same path the
 * CLI takes: the rules a check runs are the ones `loadConfig` compiled.
 */
async function check(files: Record<string, string>): Promise<Finding[]> {
  const root = await vault(files);
  const loaded = await loadConfig(root);
  if (loaded.status !== 'loaded') assert.fail(`expected a loaded config, got ${loaded.status}`);
  return checkVault(root, loaded.config, loaded.rules, await findRecords(root, loaded.config));
}

const NOTHING: Finding[] = [];

/** What an `empty` warning says, so a whole warning can be asserted at once. */
const NOTHING_AT = 'nothing at this path';

/** An `empty` warning against the given path, whole. */
function emptyWarning(path: string): Finding {
  return { rule: 'empty', severity: 'warning', path, message: NOTHING_AT };
}

/** The warnings among the findings, and the violations. */
function warnings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === 'warning');
}

function violations(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === 'violation');
}

/** Asserts exactly one finding was reported, that it is a violation, and narrows to it. */
function onlyViolation(findings: Finding[]): Finding {
  assert.equal(findings.length, 1, `expected one finding, got ${rules(findings)}`);
  const finding = findings[0] as Finding;
  assert.equal(finding.severity, 'violation');
  return finding;
}

function rules(findings: Finding[]): string {
  return findings.map((finding) => finding.rule).join(', ');
}

describe('checkVault', () => {
  it('reports nothing for a record that satisfies its path schema', async () => {
    const findings = await check({
      'autofile.yml': `
paths:
  /contacts:
    schema:
      required: [name, type]
      properties:
        name: { type: string }
        type: { enum: [person, organization] }
`,
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\ntype: person\n---\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('reports a header that fails its path schema, naming the offending property', async () => {
    const findings = await check({
      'autofile.yml': `
paths:
  /contacts:
    schema:
      properties:
        name: { type: string }
`,
      'contacts/priya-narayan.md': '---\nname: 12\n---\n',
    });

    const violation = onlyViolation(findings);
    assert.equal(violation.rule, 'schema');
    assert.equal(violation.file, 'contacts/priya-narayan.md');
    assert.equal(violation.path, '/contacts');
    assert.match(violation.message, /name/);
    assert.match(violation.message, /string/);
  });

  it('checks nothing against a path that sets no schema', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n    description: People.\n',
      'contacts/priya-narayan.md': '---\nanything: at all\n---\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('checks a record with no header as a header with no properties', async () => {
    // A record without a header carries no structured data, so a schema that
    // requires a property is not satisfied by its absence.
    const findings = await check({
      'autofile.yml': `
paths:
  /contacts:
    schema:
      required: [name]
      properties:
        name: { type: string }
`,
      'contacts/priya-narayan.md': 'Met at the studio.\n',
    });

    const violation = onlyViolation(findings);
    assert.equal(violation.rule, 'schema');
    assert.equal(violation.file, 'contacts/priya-narayan.md');
    assert.match(violation.message, /name/);
  });

  it('asserts formats, so a property declared format: date must hold a date', async () => {
    const findings = await check({
      'autofile.yml': `
paths:
  /events:
    schema:
      properties:
        date: { type: string, format: date }
`,
      'events/standup.md': '---\ndate: last tuesday\n---\n',
    });

    const violation = onlyViolation(findings);
    assert.equal(violation.rule, 'schema');
    assert.match(violation.message, /date/);
  });

  it('checks a filename against the slug, not the identity or the full filename', async () => {
    // At a nested path the three differ: the identity carries the folders and
    // the filename carries the extension, and neither would match this pattern.
    const findings = await check({
      'autofile.yml': `
paths:
  /contacts/archive:
    filename: { pattern: "^[a-z0-9-]+$" }
`,
      'contacts/archive/old-friend.md': '',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('reports a filename that fails its path filename', async () => {
    const findings = await check({
      'autofile.yml': `
paths:
  /contacts/archive:
    filename: { pattern: "^[a-z0-9-]+$" }
`,
      'contacts/archive/Old Friend.md': '',
    });

    const violation = onlyViolation(findings);
    assert.equal(violation.rule, 'filename');
    assert.equal(violation.file, 'contacts/archive/Old Friend.md');
    assert.equal(violation.path, '/contacts/archive');
    assert.match(violation.message, /\^\[a-z0-9-\]\+\$/);
  });

  it('reports a body where its path sets body: false', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n    body: false\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nMet at the studio.\n',
    });

    const violation = onlyViolation(findings);
    assert.equal(violation.rule, 'body');
    assert.equal(violation.file, 'contacts/priya-narayan.md');
    assert.equal(violation.path, '/contacts');
    assert.match(violation.message, /body/);
  });

  it('reports nothing for a record with no body where its path sets body: false', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n    body: false\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('reports nothing for a whitespace-only body where its path sets body: false', async () => {
    // Whitespace alone is not a body.
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n    body: false\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\n\n  \n\t\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('allows a body at a path that sets no body rule', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n    description: People.\n',
      'contacts/priya-narayan.md': '---\nname: Priya Narayan\n---\nMet at the studio.\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('checks nothing against a path listed with no entry at all', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts:\n',
      'contacts/Priya Narayan.md': '---\nanything: at all\n---\nMet at the studio.\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('warns about a path listed with no entry at all and nothing at it', async () => {
    const findings = await check({ 'autofile.yml': 'paths:\n  /contacts:\n' });

    assert.deepEqual(findings, [emptyWarning('/contacts')]);
  });

  it('warns about a listed path with nothing at it', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /events:\n    description: Things that happened.\n',
    });

    assert.deepEqual(violations(findings), []);
    assert.equal(findings.length, 1);
    const warning = findings[0];
    assert.equal(warning?.rule, 'empty');
    assert.equal(warning?.severity, 'warning');
    assert.equal(warning?.path, '/events');
    assert.match(warning?.message ?? '', /nothing/);
  });

  it('warns about a listed path that is a folder holding nothing', async () => {
    const root = await vault({ 'autofile.yml': 'paths:\n  /events: {}\n' });
    await mkdir(join(root, 'events'));
    const loaded = await loadConfig(root);
    if (loaded.status !== 'loaded') assert.fail(`expected a loaded config, got ${loaded.status}`);

    const findings = await checkVault(root, loaded.config, loaded.rules, []);

    assert.deepEqual(warnings(findings), [emptyWarning('/events')]);
  });

  it('does not warn about a listed path holding records', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts: {}\n',
      'contacts/priya-narayan.md': '',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('does not warn about a listed path holding only static files', async () => {
    // A path of static files has something at it and is referenced by identity
    // like any other, so it is filed into even though it holds no records.
    const findings = await check({
      'autofile.yml': 'paths:\n  /assets: {}\n',
      'assets/risograph-guide.html': '<p>How to.</p>\n',
    });

    assert.deepEqual(findings, NOTHING);
  });

  it('warns about a listed path holding only files that are ignored', async () => {
    const findings = await check({
      'autofile.yml': 'paths:\n  /contacts: {}\n',
      'contacts/.DS_Store': '',
    });

    assert.deepEqual(warnings(findings), [emptyWarning('/contacts')]);
  });

  it('warns about a path key that could never name anything, rather than reading it', async () => {
    // The config schema rejects these keys, so a loaded config never holds one;
    // checkVault does not assume its config came through loadConfig, and the
    // folder above the vault root is not somewhere it looks for records.
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    const findings = await checkVault(root, { paths: { '/..': {} } }, {}, []);

    assert.deepEqual(warnings(findings), [emptyWarning('/..')]);
  });

  it('passes a parse violation through without checking the record again', async () => {
    // The record breaks this path's schema, filename and body rules too, so one
    // finding is only possible if a record that cannot be read is checked no
    // further. Asserting the finding whole keeps its diagnostic message intact
    // rather than letting the check rebuild it.
    const root = await vault({
      'autofile.yml': `
paths:
  /events:
    schema:
      required: [date]
    filename: { pattern: "^[a-z0-9-]+$" }
    body: false
`,
      'events/Broken Record.md': '---\ndate: [unclosed\n---\nNotes.\n',
    });
    const loaded = await loadConfig(root);
    if (loaded.status !== 'loaded') assert.fail(`expected a loaded config, got ${loaded.status}`);
    const records = await findRecords(root, loaded.config);
    const found = records[0];
    if (found?.status !== 'violation') assert.fail(`expected a violation, got ${found?.status}`);

    const findings = await checkVault(root, loaded.config, loaded.rules, records);

    assert.deepEqual(violations(findings), [found.finding]);
    assert.equal(found.finding.rule, 'parse');
    assert.equal(found.finding.severity, 'violation');
    assert.equal(found.finding.file, 'events/Broken Record.md');
    assert.equal(found.finding.path, '/events');
    assert.ok(found.finding.message.length > 0);
  });

  it('reports violations, then warnings, in an order the config listing cannot move', async () => {
    const findings = await check({
      'autofile.yml': `
paths:
  /notes: {}
  /events:
    schema:
      required: [date]
      properties:
        date: { type: string, format: date }
    filename: { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$" }
    body: false
  /contacts:
    filename: { pattern: "^[a-z0-9-]+$" }
  /assets: {}
`,
      'contacts/Priya Narayan.md': '',
      'events/broken.md': '---\ndate: [unclosed\n---\n',
      'events/standup.md': '---\ndate: last tuesday\n---\nWe shipped it.\n',
    });

    // One list, so the grouping is asserted alongside the order within each
    // group: a warning read before the violations it sits among would be a
    // report the exit code no longer explains.
    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.rule, finding.file ?? finding.path]),
      [
        ['violation', 'filename', 'contacts/Priya Narayan.md'],
        ['violation', 'parse', 'events/broken.md'],
        ['violation', 'schema', 'events/standup.md'],
        ['violation', 'filename', 'events/standup.md'],
        ['violation', 'body', 'events/standup.md'],
        ['warning', 'empty', '/assets'],
        ['warning', 'empty', '/notes'],
      ],
    );
  });
});

/**
 * Reading a path key is a vault rule, and both walkers read one: `findRecords`
 * to know where records are, `checkVault` to know whether anything is there. A
 * key they read differently is a path with invisible records, or contents
 * nothing reports. The keys here are ones the config schema rejects, so a
 * loaded config never holds them and only a hand-built config can ask.
 */
describe('a path key', () => {
  /** What each walker makes of the same config: the records, and the paths warned about. */
  async function walk(
    root: string,
    config: VaultConfig,
  ): Promise<{ identities: string[]; warned: (string | undefined)[] }> {
    const records = await findRecords(root, config);
    const findings = await checkVault(root, config, {}, records);
    return {
      identities: records.map((record) => record.identity),
      warned: warnings(findings).map((warning) => warning.path),
    };
  }

  it('naming a hidden folder yields no records and warns that nothing is at it', async () => {
    const root = await vault({ '.private/note.md': '' });

    assert.deepEqual(await walk(root, { paths: { '/.private': {} } }), {
      identities: [],
      warned: ['/.private'],
    });
  });

  it('naming a hidden folder deeper in the tree does the same', async () => {
    const root = await vault({ 'contacts/.archive/note.md': '' });

    assert.deepEqual(await walk(root, { paths: { '/contacts/.archive': {} } }), {
      identities: [],
      warned: ['/contacts/.archive'],
    });
  });

  it('with a trailing slash names the same folder to both', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    assert.deepEqual(await walk(root, { paths: { '/contacts/': {} } }), {
      identities: ['contacts/priya-narayan'],
      warned: [],
    });
  });

  it('with a trailing slash and nothing at it warns, rather than only one of them', async () => {
    const root = await vault({ 'contacts/priya-narayan.md': '' });

    assert.deepEqual(await walk(root, { paths: { '/events/': {} } }), {
      identities: [],
      warned: ['/events/'],
    });
  });
});
