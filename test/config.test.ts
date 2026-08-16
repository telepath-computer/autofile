import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isIgnored, loadConfig, parseConfig, type Config } from "../dist/config.js";

function valid(source: string): Config {
  const result = parseConfig(source);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  return result.config;
}

function invalid(source: string): string[] {
  const result = parseConfig(source);
  assert.ok(!result.ok, "expected config errors");
  return result.errors.map(({ message }) => message);
}

test("version 1 defaults govern nothing and assert no implicit conventions", () => {
  for (const source of ["version: 1\n", "version: 1\nfolders: []\n"]) {
    const config = valid(source);
    assert.equal(config.version, 1);
    assert.equal(config.strict, false);
    assert.equal(config.linkFormat, "wikilink");
    assert.equal(config.filenamePattern, undefined);
    assert.deepEqual(config.ignore, []);
    assert.deepEqual(config.folders, []);
  }
});

test("missing and unknown versions are a single gate error for every parsed root shape", () => {
  for (const source of ["strict: true\nfolders: []\nwat: true\n", "- old\n- config\n", "42\n", "null\n", ""]) {
    assert.deepEqual(invalid(source), [
      "version is required; migrate this pre-versioned config to version 1",
    ]);
  }
  assert.deepEqual(invalid("version: 2\nstrict: true\n"), ["version 2 is not understood"]);
  assert.deepEqual(invalid("version: 1.5\nwat: true\n"), ["version must be the integer 1"]);
  assert.deepEqual(invalid("version: '1'\nwat: true\n"), ["version must be the integer 1"]);
});

test("parses the complete folders surface and compiles schemas and patterns", () => {
  const config = valid(String.raw`version: 1
strict: true
link_format: markdown
filename_pattern: '[a-z]+'
ignore: ['^tmp', 'cache']
folders:
  - path: contacts
    description: People and organizations.
    schema:
      type: object
      required: [name]
      properties:
        name: { type: string }
        link: { type: string, format: internal-link }
        local: { type: string, format: datetime }
    extensions: [md, jpg]
    filename_pattern: 'person-[a-z]+'
    body: none
    additional_subfolders: false
  - path: contacts/archive
`);
  assert.equal(config.strict, true);
  assert.equal(config.linkFormat, "markdown");
  assert.equal(config.filenamePattern?.source, "[a-z]+");
  assert.equal(config.filenamePattern?.regex.test("abc"), true);
  assert.equal(config.filenamePattern?.regex.test("abc!"), false);
  assert.equal(config.ignore[0]?.regex.test("tmp-files"), true);
  assert.equal(config.ignore[1]?.regex.test("my-cache-folder"), true);
  assert.equal(config.folders.length, 2);

  const contacts = config.folders[0]!;
  assert.deepEqual({
    path: contacts.path,
    description: contacts.description,
    extensions: contacts.extensions,
    body: contacts.body,
    additionalSubfolders: contacts.additionalSubfolders,
  }, {
    path: "contacts",
    description: "People and organizations.",
    extensions: ["md", "jpg"],
    body: "none",
    additionalSubfolders: false,
  });
  assert.equal(contacts.filenamePattern?.regex.test("person-mira"), true);
  assert.equal(contacts.filenamePattern?.regex.test("mira"), false);
  assert.equal(contacts.schema?.validate({
    name: "Mira",
    link: "[Mira](../contacts/mira)",
    local: "2026-08-08T10:00",
  }), true);
  assert.equal(contacts.schema?.validate({ name: 7 }), false);
  assert.deepEqual(config.folders[1], {
    path: "contacts/archive",
    body: "markdown",
    additionalSubfolders: true,
  });
});

test("body defaults to markdown and accepts the three declared modes", () => {
  const folders = valid(`version: 1
folders:
  - path: default
  - path: marked-up
    body: markdown
  - path: uninterpreted
    body: raw
  - path: structured
    body: none
`).folders;
  assert.deepEqual(folders.map(({ body }) => body), ["markdown", "markdown", "raw", "none"]);
});

test("internal-link schema format follows link_format and remains whole-value only", () => {
  const wikilink = valid(`version: 1
folders:
  - path: notes
    schema:
      properties:
        link: { type: string, format: internal-link }
`).folders[0]!.schema!;
  assert.equal(wikilink.validate({ link: "[[contacts/mira|Mira]]" }), true);
  assert.equal(wikilink.validate({ link: "prefix [[contacts/mira]]" }), false);
  assert.equal(wikilink.validate({ link: "[Mira](../contacts/mira)" }), false);

  const markdown = valid(`version: 1
link_format: markdown
folders:
  - path: notes
    schema:
      properties:
        link: { type: string, format: internal-link }
`).folders[0]!.schema!;
  assert.equal(markdown.validate({ link: "[Mira](../contacts/mira)" }), true);
  assert.equal(markdown.validate({ link: "![Scan](../assets/scan.pdf)" }), true);
  assert.equal(markdown.validate({ link: "prefix [Mira](../contacts/mira)" }), false);
  assert.equal(markdown.validate({ link: "[Web](https://example.com)" }), false);
  assert.equal(markdown.validate({ link: "[[contacts/mira]]" }), false);
});

test("JSON Schema uses core YAML values and asserts standard, internal-link, and datetime formats", () => {
  const schema = valid(`version: 1
folders:
  - path: notes
    schema:
      type: object
      properties:
        date: { type: string, format: date }
        link: { type: string, format: internal-link }
        local: { type: string, format: datetime }
`).folders[0]!.schema!;
  assert.equal(schema.validate({ date: "2026-08-08", link: "[[a/b|B]]", local: "2026-08-08T10:00:00" }), true);
  assert.equal(schema.validate({ link: "[[a[b]]" }), false);
  assert.equal(schema.validate({ local: "2026-08-08T10:00Z" }), false);
  assert.equal(schema.validate({ local: "2026-02-30T10:00" }), false);
  assert.equal(schema.validate({ date: "not-a-date" }), false);
});

test("boolean JSON Schemas compile, while null is not a schema", () => {
  const schema = valid("version: 1\nfolders:\n  - path: notes\n    schema: false\n").folders[0]!.schema!;
  assert.equal(schema.validate({}), false);
  assert.deepEqual(invalid("version: 1\nfolders:\n  - path: notes\n    schema: null\n"), [
    "folders notes.schema must be a JSON Schema mapping or boolean schema",
  ]);
});

test("rejects unknown keys at the top level and inside folder entries", () => {
  assert.deepEqual(invalid(`version: 1
filenames: x
records: {}
static: []
folders:
  - path: contacts
    shema: {}
    filenames: x
`), [
    'unknown key "filenames"',
    'unknown key "records"',
    'unknown key "static"',
    'folders contacts has an unknown key "shema"',
    'folders contacts has an unknown key "filenames"',
  ]);
});

test("validates every setting type and link_format value", () => {
  const cases: Array<[string, string]> = [
    ["version: 1\nstrict: yes\n", "strict takes true or false"],
    ["version: 1\nlink_format: html\n", "link_format must be wikilink or markdown"],
    ["version: 1\nfilename_pattern: 3\n", "filename_pattern must be a regular expression string"],
    ["version: 1\nignore: x\n", "ignore must be a list of regular expression strings"],
    ["version: 1\nignore: [x, 3]\n", "ignore must be a list of regular expression strings"],
    ["version: 1\nfolders: {}\n", "folders must be a list of entries"],
    ["version: 1\nfolders: [nope]\n", "folders[0] must be a mapping"],
    ["version: 1\nfolders:\n  - description: Missing path\n", "folders[0].path is required"],
    ["version: 1\nfolders:\n  - path: 3\n", "folders[0].path must be text"],
    ["version: 1\nfolders:\n  - path: assets\n    description: 3\n", "folders assets.description must be text"],
    ["version: 1\nfolders:\n  - path: assets\n    extensions: pdf\n", "folders assets.extensions must be a list of lowercase, dot-less extensions"],
    ["version: 1\nfolders:\n  - path: assets\n    extensions: [.pdf]\n", "folders assets.extensions must be a list of lowercase, dot-less extensions"],
    ["version: 1\nfolders:\n  - path: assets\n    extensions: [PDF]\n", "folders assets.extensions must be a list of lowercase, dot-less extensions"],
    ["version: 1\nfolders:\n  - path: assets\n    body: no\n", "folders assets.body must be markdown, raw, or none"],
    ["version: 1\nfolders:\n  - path: assets\n    body: false\n", "folders assets.body must be markdown, raw, or none"],
    ["version: 1\nfolders:\n  - path: assets\n    additional_subfolders: no\n", "folders assets.additional_subfolders takes true or false"],
    ["version: 1\nfolders:\n  - path: assets\n    filename_pattern: 3\n", "folders assets.filename_pattern must be a regular expression string"],
  ];
  for (const [source, message] of cases) assert.deepEqual(invalid(source), [message]);
});

test("the root path is legal while malformed and parent-traversing paths are rejected", () => {
  assert.equal(valid("version: 1\nfolders:\n  - path: .\n").folders[0]?.path, ".");
  for (const path of ["", "/notes", "notes/", "notes//daily", "notes/./daily", "notes/../daily", "../notes"]) {
    const errors = invalid(`version: 1\nfolders:\n  - path: '${path}'\n`);
    assert.ok(errors.some((message) => message.includes("valid vault-relative path")), path);
  }
});

test("the vault filename_pattern fully matches every non-root declared segment", () => {
  assert.deepEqual(invalid(`version: 1
filename_pattern: '[a-z]+'
folders:
  - path: assets/Raw
  - path: .
`), [
    'Raw in folders assets/Raw does not match filename_pattern "[a-z]+"',
  ]);
});

test("schemas compile strictly and every regexp compiles eagerly", () => {
  assert.ok(invalid("version: 1\nfolders:\n  - path: notes\n    schema: { requird: [x] }\n")
    .some((message) => /schema.*strict mode.*requird/u.test(message)));
  assert.ok(invalid("version: 1\nfolders:\n  - path: notes\n    schema: { type: 42 }\n")
    .some((message) => /schema.*compile/u.test(message)));
  const errors = invalid(`version: 1
filename_pattern: '('
ignore: ['[']
folders:
  - path: notes
    filename_pattern: '*'
`);
  assert.equal(errors.filter((message) => message.includes("regular expression")).length, 3);
  assert.equal(valid("version: 1\nfilename_pattern: '\\_'\n").filenamePattern?.regex.test("_"), true);
});

test("extension wildcards stand alone and normalize to the omitted unconstrained form", () => {
  assert.equal(valid("version: 1\nfolders:\n  - path: assets\n    extensions: ['*']\n").folders[0]?.extensions, undefined);
  assert.deepEqual(valid("version: 1\nfolders:\n  - path: assets\n    extensions: []\n").folders[0]?.extensions, []);
  assert.deepEqual(invalid("version: 1\nfolders:\n  - path: assets\n    extensions: ['*', pdf]\n"), [
    "folders assets.extensions wildcard must be its only entry",
  ]);
});

test("duplicate and case or Unicode-normalization-colliding paths are invalid", () => {
  assert.deepEqual(invalid(`version: 1
folders:
  - path: notes
  - path: notes
`), ["folders notes is declared more than once"]);
  assert.deepEqual(invalid(`version: 1
folders:
  - path: Notes
  - path: notes
`), ["folders Notes and folders notes differ only by case or Unicode normalization"]);
  const unicode = invalid(`version: 1
folders:
  - path: "café"
  - path: "café"
`);
  assert.equal(unicode.length, 1);
  assert.match(unicode[0]!, /differ only by case or Unicode normalization/u);
  assert.deepEqual(invalid(`version: 1
folders:
  - path: ΟΣ
  - path: οσ
`), ["folders ΟΣ and folders οσ differ only by case or Unicode normalization"]);
});

test("declared paths cannot be hidden by ignore, and dot names are ordinary unless configured", () => {
  assert.deepEqual(invalid(`version: 1
ignore: [tmp, '^cache$']
folders:
  - path: assets/tmp-files
  - path: work/cache
`), [
    'folders assets/tmp-files is hidden by ignore pattern "tmp"',
    'folders work/cache is hidden by ignore pattern "^cache$"',
  ]);
  assert.equal(valid("version: 1\nfolders:\n  - path: .private/notes\n").folders[0]?.path, ".private/notes");
});

test("ignore patterns are plain segment matches with no implicit dotfile rule", () => {
  const config = valid("version: 1\nignore: [tmp]\n");
  assert.equal(isIgnored(config, "notes/my-tmp-folder/x.md"), true);
  assert.equal(isIgnored(config, "notes/ordinary.md"), false);
  assert.equal(isIgnored(config, ".obsidian/workspace.json"), false);
  assert.equal(isIgnored(config, "notes/.trash/x.md"), false);
  const dotIgnored = valid("version: 1\nignore: ['^\\.']\n");
  assert.equal(isIgnored(dotIgnored, ".obsidian/workspace.json"), true);
  assert.equal(isIgnored(dotIgnored, "notes/.trash/x.md"), true);
});

test("parse and read failures are returned as data", async () => {
  assert.ok(invalid("version: 1\nfolders: [unclosed\n")[0]!.includes("does not parse"));
  assert.ok(invalid("version: 1\nversion: 1\n")[0]!.includes("does not parse"));

  const missing = await loadConfig("/definitely/missing/autofile.yml");
  assert.ok(!missing.ok && /cannot be read/u.test(missing.errors[0]!.message));

  const dir = await mkdtemp(join(tmpdir(), "autofile-config-"));
  try {
    const path = join(dir, "autofile.yml");
    await writeFile(path, "version: 1\nfolders:\n  - path: notes\n");
    const loaded = await loadConfig(path);
    assert.ok(loaded.ok);
    assert.equal(loaded.config.folders[0]?.path, "notes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
