import assert from "node:assert/strict";
import { test } from "node:test";

import { isIgnored, parseConfig, resolve, type Config } from "../dist/config.js";

function valid(source: string): Config {
  const result = parseConfig(source);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  return result.config;
}

const source = String.raw`paths:
  /:
    description: Root.
    schema: { type: object, required: [root], properties: { root: {} } }
    body: { allowed: false }
    extensions: [md]
    filenames: { pattern: root }
    internal_links: { resolve: false, format: wikilink }
    ignore: { dotfiles: false, pattern: root-ignore }
  /personal:
    description: Personal.
    schema: { type: object, required: [personal], properties: { personal: {} } }
    internal_links: { format: markdown-relative }
    ignore: { dotfiles: true }
  /personal/misc:
    extensions: [md]
  /personal/misc/video games:
    description: Games.
    extensions: null
    filenames: { pattern: null }
    ignore: { pattern: null }
`;

test("resolve uses the nearest enclosing entry independently for every setting", () => {
  const settings = resolve(valid(source), "personal/misc/video games/zelda.md");
  assert.equal(settings.governed, true);
  assert.equal(settings.description, "Games.");
  assert.equal(settings.schema?.validate({ personal: true }), true);
  assert.equal(settings.schema?.validate({ root: true }), false);
  assert.equal(settings.body.allowed, false);
  assert.equal(settings.extensions, undefined);
  assert.equal(settings.filenames.pattern, undefined);
  assert.equal(settings.internal_links.resolve, false);
  assert.equal(settings.internal_links.format, "markdown-relative");
  assert.equal(settings.ignore.dotfiles, true);
  assert.equal(settings.ignore.pattern, undefined);
});

test("a rules-only entry inherits the nearest description", () => {
  assert.equal(resolve(valid(source), "personal/misc/x.md").description, "Personal.");
});

test("a nearer schema replaces rather than merges an inherited schema", () => {
  const schema = resolve(valid(source), "personal/x.md").schema!;
  assert.equal(schema.validate({ personal: true }), true);
  assert.equal(schema.validate({ root: true }), false);
});

test("omission inherits while null clears nullable settings to their defaults", () => {
  const settings = resolve(valid(source), "personal/misc/video games/x.md");
  assert.equal(settings.body.allowed, false);
  assert.equal(settings.extensions, undefined);
  assert.equal(settings.filenames.pattern, undefined);
  assert.equal(settings.internal_links.resolve, false);
  assert.equal(settings.internal_links.format, "markdown-relative");
  assert.equal(settings.ignore.dotfiles, true);
  assert.equal(settings.ignore.pattern, undefined);
});

test("defaults are effective in a declared path", () => {
  const settings = resolve(valid("paths:\n  /notes:\n    description: Notes.\n"), "notes/x.md");
  assert.equal(settings.governed, true);
  assert.equal(settings.schema, undefined);
  assert.deepEqual(settings.body, { allowed: true });
  assert.equal(settings.extensions, undefined);
  assert.deepEqual(settings.filenames, { pattern: undefined });
  assert.deepEqual(settings.internal_links, { resolve: true, format: undefined });
  assert.deepEqual(settings.ignore, { dotfiles: true, pattern: undefined });
});

test("governance comes from an enclosing entry, or strict for undeclared files", () => {
  const partial = valid("paths:\n  /notes:\n    description: Notes.\n");
  assert.equal(resolve(partial, "notes/x.md").governed, true);
  assert.equal(resolve(partial, "misc/x.md").governed, false);
  assert.equal(resolve(valid("strict: true\n"), "misc/x.md").governed, true);
  assert.equal(resolve(valid("strict: true\n"), "misc/x.md").description, undefined);
});

test("path-entry matching normalizes Unicode without changing case sensitivity", () => {
  const config = valid("paths:\n  /café:\n    description: Café.\n");
  assert.equal(resolve(config, `${"café".normalize("NFD")}/x.md`).governed, true);
  assert.equal(resolve(config, "Café/x.md").governed, false);
});

test("a folder's entry applies to children, not the folder itself", () => {
  const config = valid("paths:\n  /tmp:\n    description: Temporary files.\n    ignore: { pattern: tmp }\n");
  assert.equal(isIgnored(config, "tmp"), false);
  assert.equal(isIgnored(config, "tmp/tmp/x.md"), true);
});

test("ignore dotfiles defaults true, pattern is a plain segment match, and folders ignore subtrees", () => {
  const defaults = valid("paths:\n  /:\n    description: Root.\n");
  assert.equal(isIgnored(defaults, ".obsidian/workspace.json"), true);
  assert.equal(isIgnored(defaults, "notes/.trash/x.md"), true);
  const pattern = valid("paths:\n  /:\n    description: Root.\n    ignore: { dotfiles: false, pattern: tmp }\n");
  assert.equal(isIgnored(pattern, "notes/my-tmp-folder/x.md"), true);
  assert.equal(isIgnored(pattern, "notes/ordinary.md"), false);
});

test("undeclared paths are not ignored merely by defaults", () => {
  assert.equal(isIgnored(valid("{}"), ".git/config"), false);
});
