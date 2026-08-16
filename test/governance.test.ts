import assert from "node:assert/strict";
import { test } from "node:test";

import { folderEntryFor, isIgnored, parseConfig, type Config } from "../dist/config.js";

function valid(source: string): Config {
  const result = parseConfig(source);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  return result.config;
}

const config = valid(`version: 1
folders:
  - path: .
    description: Root.
  - path: archive
    description: Archive.
    extensions: [pdf]
  - path: archive/images
    description: Images.
    extensions: [png]
`);

test("the most specific enclosing folder entry governs a file wholesale", () => {
  assert.equal(folderEntryFor(config, "root.md")?.path, ".");
  assert.equal(folderEntryFor(config, "journal/2026-08-15.md")?.path, ".");
  assert.equal(folderEntryFor(config, "archive/manual.pdf")?.path, "archive");
  assert.equal(folderEntryFor(config, "archive/deep/manual.pdf")?.path, "archive");
  assert.equal(folderEntryFor(config, "archive/images/photo.png")?.path, "archive/images");
  assert.equal(folderEntryFor(config, "archive/images/deep/photo.png")?.path, "archive/images");
});

test("without a root entry, files outside every declaration have no governing entry", () => {
  const scoped = valid("version: 1\nfolders:\n  - path: notes\n");
  assert.equal(folderEntryFor(scoped, "notes/one.md")?.path, "notes");
  assert.equal(folderEntryFor(scoped, "notes/nested/two.md")?.path, "notes");
  assert.equal(folderEntryFor(scoped, "journal/one.md"), undefined);
  assert.equal(folderEntryFor(scoped, "loose.txt"), undefined);
});

test("a regular file standing at a declared path is governed only by an enclosing parent", () => {
  const scoped = valid(`version: 1
folders:
  - path: .
  - path: archive
`);
  assert.equal(folderEntryFor(scoped, "archive")?.path, ".");
  assert.equal(folderEntryFor(scoped, "archive/file.txt")?.path, "archive");

  const noRoot = valid("version: 1\nfolders:\n  - path: archive\n");
  assert.equal(folderEntryFor(noRoot, "archive"), undefined);
});

test("declared-folder comparison normalizes Unicode but remains case-sensitive", () => {
  const unicode = valid(`version: 1
folders:
  - path: café
  - path: notes
`);
  assert.equal(folderEntryFor(unicode, `${"café".normalize("NFD")}/photo.jpg`)?.path, "café");
  assert.equal(folderEntryFor(unicode, "Café/photo.jpg"), undefined);
  assert.equal(folderEntryFor(unicode, "Notes/x.md"), undefined);
});

test("ignore patterns apply globally to individual segments without an implicit dotfile rule", () => {
  const ignored = valid("version: 1\nignore: ['tmp', '^generated$', '^\\.trash$']\n");
  assert.equal(isIgnored(ignored, "any/my-tmp-file.txt"), true);
  assert.equal(isIgnored(ignored, "any/generated/deep/file.txt"), true);
  assert.equal(isIgnored(ignored, "any/.trash/file"), true);
  assert.equal(isIgnored(ignored, "any/kept.txt"), false);
  assert.equal(isIgnored(ignored, ".git/config"), false);
});

test("folder lookup uses its prebuilt index instead of scanning declarations", () => {
  const indexed = valid(`version: 1
folders:
  - path: .
  - path: assets
  - path: assets/images
  - path: notes
`);
  let scans = 0;
  const iterator = indexed.folders[Symbol.iterator].bind(indexed.folders);
  indexed.folders[Symbol.iterator] = () => {
    scans++;
    return iterator();
  };

  for (let iteration = 0; iteration < 1000; iteration++) {
    assert.equal(folderEntryFor(indexed, "notes/deep/one.md")?.path, "notes");
    assert.equal(folderEntryFor(indexed, "assets/images/deep/photo.png")?.path, "assets/images");
    assert.equal(folderEntryFor(indexed, "elsewhere/file.txt")?.path, ".");
  }
  assert.equal(scans, 0);
});
