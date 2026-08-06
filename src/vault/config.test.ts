import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type LoadConfigResult, loadConfig } from './config.ts';
import type { Finding } from './findings.ts';

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a vault root holding the given `autofile.yml`, or none at all. */
async function vault(yml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-config-'));
  roots.push(root);
  if (yml !== undefined) await writeFile(join(root, 'autofile.yml'), yml);
  return root;
}

/** Asserts the load succeeded and narrows to the config and rules it produced. */
function loaded(result: LoadConfigResult): Extract<LoadConfigResult, { status: 'loaded' }> {
  if (result.status !== 'loaded') assert.fail(`expected a loaded config, got ${result.status}`);
  return result;
}

/** Asserts the load produced a `config` violation and narrows to it. */
function violation(result: LoadConfigResult): Finding {
  if (result.status !== 'violation') assert.fail(`expected a violation, got ${result.status}`);
  assert.equal(result.finding.rule, 'config');
  assert.equal(result.finding.severity, 'violation');
  assert.equal(result.finding.file, 'autofile.yml');
  // A `config` finding concerns the vault's own file, so it names no path entry.
  assert.equal(result.finding.path, undefined);
  return result.finding;
}

describe('loadConfig', () => {
  it('loads a minimal config with no paths', async () => {
    const root = await vault('description: Everything worth keeping.\n');

    assert.deepEqual(loaded(await loadConfig(root)).config, {
      description: 'Everything worth keeping.',
    });
  });

  it('reports a vault with no autofile.yml as missing', async () => {
    const root = await vault();

    assert.deepEqual(await loadConfig(root), { status: 'missing' });
  });

  it('reports an unreadable autofile.yml as a config violation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autofile-config-'));
    roots.push(root);
    await mkdir(join(root, 'autofile.yml'));

    violation(await loadConfig(root));
  });

  it('reports unparseable YAML as a config violation', async () => {
    const root = await vault('title: "unterminated\npaths: [\n');

    assert.match(violation(await loadConfig(root)).message, /parse/i);
  });

  it('loads a full config using every field', async () => {
    const root = await vault(`
title: Personal
description: |
  Personal vault: people, places, events, and sources worth keeping.

paths:
  /contacts:
    title: Contacts
    description: |
      People and organizations. One record per person or organization.
    schema:
      required: [name, type]
      properties:
        name: { type: string }
        type: { enum: [person, organization] }
    filename: { pattern: "^[a-z0-9-]+$" }
    body: false
`);

    assert.deepEqual(loaded(await loadConfig(root)).config, {
      title: 'Personal',
      description: 'Personal vault: people, places, events, and sources worth keeping.\n',
      paths: {
        '/contacts': {
          title: 'Contacts',
          description: 'People and organizations. One record per person or organization.\n',
          schema: {
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { enum: ['person', 'organization'] },
            },
          },
          filename: { pattern: '^[a-z0-9-]+$' },
          body: false,
        },
      },
    });
  });

  it('loads a path listed with no entry at all', async () => {
    const root = await vault('paths:\n  /contacts:\n');

    assert.deepEqual(loaded(await loadConfig(root)).config.paths, { '/contacts': null });
  });

  it('keeps a path listed with no entry distinct from one listed with an empty entry', async () => {
    const root = await vault('paths:\n  /contacts:\n  /events: {}\n');

    assert.deepEqual(loaded(await loadConfig(root)).config.paths, {
      '/contacts': null,
      '/events': {},
    });
  });

  it('compiles no rules for a path listed with no entry', async () => {
    const root = await vault('paths:\n  /contacts:\n');

    assert.deepEqual(loaded(await loadConfig(root)).rules, { '/contacts': {} });
  });

  it('rejects an unknown key at the top level', async () => {
    const root = await vault('description: A vault.\nvualt: oops\n');

    assert.match(violation(await loadConfig(root)).message, /vualt/);
  });

  it('rejects an unknown key inside a path entry', async () => {
    const root = await vault('paths:\n  /contacts:\n    bdy: false\n');

    assert.match(violation(await loadConfig(root)).message, /bdy/);
  });

  it('rejects a path key that does not start with a slash', async () => {
    const root = await vault('paths:\n  contacts:\n    description: People.\n');

    assert.match(violation(await loadConfig(root)).message, /contacts/);
  });

  it('rejects a path key that could never name anything in the vault', async () => {
    // A key with an empty segment, or one beginning with a dot, names nothing a
    // record could ever have: the identity could not spell it, or the folder is
    // ignored. Either way it is a rule that would never fire.
    const keys = ['/', '//contacts', '/contacts/', '/./contacts', '/../contacts', '/a/../b'];
    for (const key of [...keys, '/.private', '/contacts/.archive']) {
      const root = await vault(`paths:\n  "${key}":\n    description: People.\n`);

      assert.match(violation(await loadConfig(root)).message, /invalid key/, key);
    }
  });

  it('accepts a nested path key, and dots within a segment', async () => {
    for (const key of ['/contacts', '/events/2026/06', '/a.b', '/2026..2027', '/_drafts']) {
      const root = await vault(`paths:\n  "${key}":\n    description: People.\n`);

      assert.deepEqual(Object.keys(loaded(await loadConfig(root)).config.paths ?? {}), [key]);
    }
  });

  it('rejects body given as a string', async () => {
    const root = await vault('paths:\n  /contacts:\n    body: "false"\n');

    assert.match(violation(await loadConfig(root)).message, /\/paths\/~1contacts\/body/);
  });

  it('rejects title given as a number', async () => {
    const root = await vault('title: 42\n');

    assert.match(violation(await loadConfig(root)).message, /\/title/);
  });

  it('rejects a config that parses to a list', async () => {
    const root = await vault('- /contacts\n- /events\n');

    assert.match(violation(await loadConfig(root)).message, /\(root\)/);
  });

  it('rejects a config that parses to a bare string', async () => {
    const root = await vault('just a note to self\n');

    assert.match(violation(await loadConfig(root)).message, /\(root\)/);
  });

  it('rejects an empty config file', async () => {
    const root = await vault('');

    assert.match(violation(await loadConfig(root)).message, /\(root\)/);
  });

  it('leaves dates and yes/no as strings', async () => {
    const root = await vault(`
title: yes
description: 2026-08-05
paths:
  /events:
    schema:
      properties:
        date: { const: 2026-08-05 }
        rsvp: { const: no }
`);

    const config = loaded(await loadConfig(root)).config;
    const properties = (config.paths?.['/events']?.schema?.['properties'] ?? {}) as Record<
      string,
      { const: unknown }
    >;

    assert.equal(config.title, 'yes');
    assert.equal(config.description, '2026-08-05');
    assert.equal(properties['date']?.const, '2026-08-05');
    assert.equal(properties['rsvp']?.const, 'no');
  });

  it('rejects a path schema that is not usable as a schema', async () => {
    const root = await vault('paths:\n  /events:\n    schema: { type: nonsense }\n');

    assert.match(violation(await loadConfig(root)).message, /\/paths\/~1events\/schema/);
  });

  it('rejects a path filename that is not usable as a schema', async () => {
    const root = await vault('paths:\n  /events:\n    filename: { pattern: "[" }\n');

    assert.match(violation(await loadConfig(root)).message, /\/paths\/~1events\/filename/);
  });

  it('rejects a path schema with a misspelled keyword', async () => {
    const root = await vault('paths:\n  /events:\n    schema: { requird: [title] }\n');

    assert.match(violation(await loadConfig(root)).message, /\/paths\/~1events\/schema/);
  });

  it('compiles a usable path schema and filename into rules', async () => {
    const root = await vault(`
paths:
  /events:
    schema:
      required: [title]
      properties:
        title: { type: string }
    filename: { type: string, pattern: "^[a-z-]+$" }
`);

    const rules = loaded(await loadConfig(root)).rules['/events'];

    assert.equal(rules?.schema?.({ title: 'Standup' }), true);
    assert.equal(rules?.schema?.({}), false);
    assert.equal(rules?.filename?.('a-meeting'), true);
    assert.equal(rules?.filename?.('A Meeting'), false);
  });

  it('compiles path schemas with format assertion', async () => {
    const root = await vault(`
paths:
  /events:
    schema:
      properties:
        date: { type: string, format: date }
`);

    const schema = loaded(await loadConfig(root)).rules['/events']?.schema;

    assert.equal(schema?.({ date: '2026-06-03' }), true);
    assert.equal(schema?.({ date: 'not-a-date' }), false);
  });

  it('compiles path schemas with 2020-12 semantics', async () => {
    // `prefixItems` is 2020-12; an earlier draft either ignores it as an
    // unknown keyword or reads `items: false` as forbidding every item, so
    // both assertions below distinguish the dialect.
    const root = await vault(`
paths:
  /events:
    schema:
      properties:
        attendance:
          type: array
          prefixItems:
            - { type: string }
            - { type: integer }
          items: false
`);

    const schema = loaded(await loadConfig(root)).rules['/events']?.schema;

    assert.equal(schema?.({ attendance: ['standup', 4] }), true);
    assert.equal(schema?.({ attendance: ['standup', 'four'] }), false);
    assert.equal(schema?.({ attendance: ['standup', 4, 'extra'] }), false);
  });
});
