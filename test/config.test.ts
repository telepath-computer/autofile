import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, parseConfig, type Config } from "../dist/config.js";

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

test("empty and comment-only configs declare nothing and strict defaults false", () => {
  for (const source of ["", "{}", "# only a comment\n"]) {
    const config = valid(source);
    assert.equal(config.strict, false);
    assert.equal(config.paths.size, 0);
  }
});

test("parses every setting at root and arbitrarily deep overlapping paths", () => {
  const config = valid(String.raw`strict: true
paths:
  /:
    description: Everything.
    schema: { type: object }
    body: { allowed: false }
    extensions: [md, pdf]
    filenames: { pattern: '[a-z]+' }
    internal_links: { resolve: false, format: wikilink }
    ignore: { dotfiles: false, pattern: 'tmp' }
  /personal:
    description: Personal.
  /personal/misc/video games:
    description: Games.
`);
  assert.equal(config.strict, true);
  assert.deepEqual([...config.paths.keys()], ["/", "/personal", "/personal/misc/video games"]);
  const root = config.paths.get("/")!;
  assert.equal(root.schema?.validate({}), true);
  assert.equal(root.body?.allowed, false);
  assert.deepEqual(root.extensions, ["md", "pdf"]);
  assert.equal(root.filenames?.pattern?.regex.test("abc"), true);
  assert.equal(root.filenames?.pattern?.regex.test("abc!"), false);
  assert.deepEqual(root.internal_links, { resolve: false, format: "wikilink" });
  assert.equal(root.ignore?.dotfiles, false);
  assert.equal(root.ignore?.pattern?.regex.test("x-tmp-y"), true);
});

test("standard and custom schema formats are asserted", () => {
  const schema = valid(`paths:\n  /notes:\n    description: Notes.\n    schema:\n      type: object\n      properties:\n        date: { type: string, format: date }\n        link: { type: string, format: internal-link }\n        local: { type: string, format: datetime }\n`).paths.get("/notes")!.schema!;
  assert.equal(schema.validate({ date: "2026-08-08", link: "[[a/b|B]]", local: "2026-08-08T10:00" }), true);
  assert.equal(schema.validate({ link: "prefix [[a]]" }), false);
  assert.equal(schema.validate({ link: "![[photo.png#crop]]" }), true);
  assert.equal(schema.validate({ link: "[[a[b]]" }), false);
  assert.equal(schema.validate({ link: "[[a\rb]]" }), false);
  assert.equal(schema.validate({ local: "2026-08-08T10:00:00" }), true);
  assert.equal(schema.validate({ local: "2026-08-08T10:00Z" }), false);
  assert.equal(schema.validate({ local: "2026-08-08" }), false);
  assert.equal(schema.validate({ local: "2026-02-30T10:00" }), false);
  assert.equal(schema.validate({ date: "not-a-date" }), false);
});

test("boolean JSON Schemas compile", () => {
  const schema = valid("paths:\n  /notes:\n    description: Notes.\n    schema: false\n").paths.get("/notes")!.schema!;
  assert.equal(schema.validate({}), false);
});

test("loads the README schema shape without an explicit object type", () => {
  const schema = valid(`paths:
  /contacts:
    description: Contacts.
    schema:
      required: [title, kind]
      properties:
        title: { type: string }
        kind: { enum: [person, organization] }
`).paths.get("/contacts")!.schema!;
  assert.equal(schema.validate({ title: "Priya", kind: "person" }), true);
  assert.equal(schema.validate({ title: "Priya" }), false);
});

test("rejects unknown keys at every config level, including removed old keys", () => {
  const cases: Array<[string, string]> = [
    ["wat: true\n", "wat"],
    ["global: {}\n", "global"],
    ["paths:\n  /x:\n    description: X.\n    records: {}\n", "records"],
    ["paths:\n  /x:\n    description: X.\n    assets: {}\n", "assets"],
    ["paths:\n  /x:\n    description: X.\n    body: { allowed: true, extra: 1 }\n", "extra"],
    ["paths:\n  /x:\n    description: X.\n    filenames: { flags: i }\n", "flags"],
    ["paths:\n  /x:\n    description: X.\n    internal_links: { style: wiki }\n", "style"],
    ["paths:\n  /x:\n    description: X.\n    ignore: { subtree: true }\n", "subtree"],
  ];
  for (const [source, key] of cases) assert.ok(invalid(source).some((message) => message.includes(key)));
  assert.deepEqual(invalid("extra: true\npaths:\n  /contacts:\n    shema: {}\n"), [
    'unknown key "extra"',
    '/contacts has an unknown key "shema"',
  ]);
});

test("validates top-level, path entry, and setting value types", () => {
  const cases: Array<[string, string]> = [
    ["strict: yes\n", "strict must be a boolean"],
    ["paths: []\n", "paths must be a mapping"],
    ["paths:\n  /x: nope\n", "/x must be a mapping"],
    ["paths:\n  /x:\n    description: 3\n", "/x.description must be text"],
    ["paths:\n  /x:\n    description: X.\n    body: { allowed: no }\n", "/x.body.allowed takes true or false"],
    ["paths:\n  /x:\n    description: X.\n    extensions: md\n", "/x.extensions must be a list of extensions, or null"],
    ["paths:\n  /x:\n    description: X.\n    extensions: [md, 3]\n", "/x.extensions must be a list of extensions, or null"],
    ["paths:\n  /x:\n    description: X.\n    internal_links: { format: html }\n", "/x.internal_links.format must be wikilink, markdown-relative, markdown-absolute, or null"],
    ["paths:\n  /x:\n    description: X.\n    ignore: { dotfiles: no }\n", "/x.ignore.dotfiles takes true or false"],
  ];
  for (const [source, message] of cases) assert.deepEqual(invalid(source), [message]);
});

test("internal link format must be a valid string", () => {
  assert.deepEqual(
    invalid("paths:\n  /x:\n    description: X.\n    internal_links: { format: [wikilink] }\n"),
    ["/x.internal_links.format must be wikilink, markdown-relative, markdown-absolute, or null"],
  );
  assert.equal(
    valid("paths:\n  /x:\n    description: X.\n    internal_links: { format: wikilink }\n").paths.get("/x")!.internal_links?.format,
    "wikilink",
  );
});

test("description is optional, and non-text is rejected", () => {
  const ok = parseConfig("paths:\n  /notes:\n    extensions: [md]\n");
  assert.ok(ok.ok, "an entry may scope rules without inviting filing");
  assert.equal(ok.ok && ok.config.paths.get("/notes")?.description, undefined);
  assert.ok(invalid("paths:\n  /notes:\n    description: 3\n").some((m) => /description must be text/.test(m)));
});

test("path keys start with slash, have no trailing slash, and contain valid segments", () => {
  for (const key of ["notes", "/notes/", "//notes", "/a//b", "/a/./b", "/a/../b"]) {
    assert.ok(invalid(`paths:\n  '${key}':\n    description: X.\n`).some((m) => m.includes(key)));
  }
});

test("rejects path keys differing only by case or Unicode normalization", () => {
  const caseErrors = invalid("paths:\n  /Notes:\n    description: A.\n  /notes:\n    description: B.\n");
  assert.deepEqual(caseErrors, ["/Notes and /notes differ only by case or Unicode normalization"]);
  const unicodeErrors = invalid('paths:\n  "/caf\\u00e9":\n    description: A.\n  "/cafe\\u0301":\n    description: B.\n');
  assert.ok(unicodeErrors.some((m) => /normalization/.test(m) && /caf/.test(m)));
});

test("schemas compile strictly and patterns compile as JavaScript regexps", () => {
  assert.ok(invalid("paths:\n  /x:\n    description: X.\n    schema: { requird: [x] }\n").some((m) => /schema.*strict mode.*requird/.test(m)));
  assert.ok(invalid("paths:\n  /x:\n    description: X.\n    schema: { type: 42 }\n").some((m) => /schema.*compile/.test(m)));
  assert.ok(invalid("paths:\n  /x:\n    description: X.\n    filenames: { pattern: '(' }\n    ignore: { pattern: '[' }\n").filter((m) => /pattern.*regular expression/.test(m)).length === 2);
});

test("null clears nullable settings but boolean settings take true or false", () => {
  valid("paths:\n  /:\n    description: Root.\n    schema: null\n    extensions: null\n    filenames: { pattern: null }\n    internal_links: { format: null }\n    ignore: { pattern: null }\n");
  assert.deepEqual(invalid("paths:\n  /x:\n    body: { allowed: null }\n    internal_links: { resolve: null }\n    ignore: { dotfiles: null }\n"), [
    "/x.body.allowed takes true or false",
    "/x.internal_links.resolve takes true or false",
    "/x.ignore.dotfiles takes true or false",
  ]);
  assert.deepEqual(invalid("paths:\n  /x:\n    description: X.\n    body: null\n"), ["/x.body must be a mapping"]);
});

test("parse and read failures are returned as data and errors are collected", async () => {
  assert.ok(invalid("paths: [unclosed\n")[0]!.includes("does not parse"));
  assert.ok(invalid("- not\n- a mapping\n")[0]!.includes("mapping"));
  const many = invalid("strict: nope\nextra: 1\npaths:\n  /x:\n    filenames: { pattern: '(' }\n");
  assert.deepEqual(many, [
    'unknown key "extra"',
    "strict must be a boolean",
    "/x.filenames.pattern does not compile as a regular expression: Invalid regular expression: /^(?:()$/: Unterminated group",
  ]);
  const missing = await loadConfig("/definitely/missing/autofile.yml");
  assert.ok(!missing.ok && /cannot be read/.test(missing.errors[0]!.message));
});

test("loadConfig loads a valid config from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autofile-config-"));
  try {
    const path = join(dir, "autofile.yml");
    await writeFile(path, "paths:\n  /notes:\n    description: Notes.\n");
    const result = await loadConfig(path);
    assert.ok(result.ok);
    assert.equal(result.config.paths.get("/notes")?.description, "Notes.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate YAML keys are parse errors", () => {
  assert.ok(invalid("strict: true\nstrict: false\n")[0]!.includes("does not parse"));
});
