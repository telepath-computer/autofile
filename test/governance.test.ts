import assert from "node:assert/strict";
import { test } from "node:test";

import { isIgnored, parseConfig, resolve, type Config } from "@telepath-computer/autofile";

function load(source: string): Config {
  const result = parseConfig(source);
  assert.ok(result.ok, `expected valid config, got: ${JSON.stringify(!result.ok && result.errors)}`);
  return result.config;
}

// vault.md: "For each rule block, a path entry's block, where declared,
// replaces `global`'s entirely; an entry that omits a block leaves
// `global`'s in force".
test("a declared block replaces global's entirely; an omitted block leaves global's in force", () => {
  const config = load(
    [
      "global:",
      "  filenames:",
      "    pattern: '^g$'",
      "  assets:",
      "    allowed: false",
      "  records:",
      "    body:",
      "      allowed: false",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    filenames:",
      "      pattern: '^n$'",
    ].join("\n"),
  );

  const effective = resolve(config, "notes/anything.md");
  // Declared: the entry's filenames block, not global's.
  assert.equal(effective.filenames?.pattern?.source, "^n$");
  // Omitted: global's blocks stay in force.
  assert.equal(effective.assets?.allowed, false);
  assert.equal(effective.records?.body?.allowed, false);
});

test("replacement is entire, not merged", () => {
  const config = load(
    [
      "global:",
      "  records:",
      "    schema:",
      "      required: [name]",
      "    body:",
      "      allowed: false",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    records:",
      "      schema:",
      "        required: [title]",
    ].join("\n"),
  );

  const records = resolve(config, "notes/x.md").records;
  assert.ok(records?.schema);
  assert.equal(records.schema.validate({ title: "t" }), true);
  assert.equal(records.schema.validate({ name: "n" }), false);
  // global's body rule does not survive into the replacing block.
  assert.equal(records.body, undefined);
});

// vault.md: "an empty block (`records: {}`) is therefore how a folder
// relaxes a global rule".
test("records: {} relaxes a global records rule", () => {
  const config = load(
    [
      "global:",
      "  records:",
      "    schema:",
      "      required: [name]",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    records: {}",
    ].join("\n"),
  );

  const records = resolve(config, "notes/x.md").records;
  assert.ok(records, "the empty block is still declared");
  assert.equal(records.schema, undefined);
  assert.equal(records.body, undefined);
});

// YAML leaves a bare key null; a bare `records:` declares an empty block,
// so it relaxes a global rule exactly like `records: {}`.
test("a bare records: key relaxes a global records rule", () => {
  const config = load(
    [
      "global:",
      "  records:",
      "    schema:",
      "      required: [name]",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    records:",
    ].join("\n"),
  );

  const records = resolve(config, "notes/x.md").records;
  assert.ok(records, "the bare key still declares the block");
  assert.equal(records.schema, undefined);
});

// vault.md: "`global` governs the whole vault" — a path no entry governs
// gets global's blocks.
test("global governs paths without an entry, and files at the root", () => {
  const config = load(
    [
      "global:",
      "  filenames:",
      "    pattern: '^g$'",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    filenames:",
      "      pattern: '^n$'",
    ].join("\n"),
  );

  assert.equal(resolve(config, "misc/x.md").filenames?.pattern?.source, "^g$");
  assert.equal(resolve(config, "loose.md").filenames?.pattern?.source, "^g$");
});

test("resolve on a rule-free config yields no blocks", () => {
  const config = load("paths:\n  notes:\n    description: Notes.\n");
  const effective = resolve(config, "notes/x.md");
  assert.equal(effective.records, undefined);
  assert.equal(effective.assets, undefined);
  assert.equal(effective.filenames, undefined);
  assert.equal(effective.ignore, undefined);
});

// vault.md: "a file or folder whose name it matches is ignored, subtree
// included".
test("an ignored segment ignores itself and its whole subtree", () => {
  const config = load("global:\n  ignore:\n    pattern: '^\\.'\n");
  assert.equal(isIgnored(config, ".git"), true);
  assert.equal(isIgnored(config, ".git/config"), true);
  assert.equal(isIgnored(config, ".sync/deep/nested/file.md"), true);
  assert.equal(isIgnored(config, "notes/x.md"), false);
});

// vault.md: the canonical example pattern, against the artifacts it exists
// to ignore.
test("the canonical '^\\.' ignores .git and .DS_Store", () => {
  const config = load("global:\n  ignore:\n    pattern: '^\\.'\n");
  assert.equal(isIgnored(config, ".git"), true);
  assert.equal(isIgnored(config, ".DS_Store"), true);
  assert.equal(isIgnored(config, "notes/.DS_Store"), true);
  assert.equal(isIgnored(config, "notes"), false);
});

// vault.md: "A plain match, not a full one — an ignore rule is a trigger,
// unlike `filenames.pattern`".
test("ignore matching is a plain match, not a full one", () => {
  const config = load("global:\n  ignore:\n    pattern: tmp\n");
  assert.equal(isIgnored(config, "tmp"), true);
  assert.equal(isIgnored(config, "tmp2"), true);
  assert.equal(isIgnored(config, "xtmp"), true);
  assert.equal(isIgnored(config, "my-tmp-file"), true);
  assert.equal(isIgnored(config, "notes/tmp/draft.md"), true);
  assert.equal(isIgnored(config, "notes/x.md"), false);
});

// vault.md: "A folder's rules apply to its children, not to the folder
// itself."
test("an entry's ignore block replaces global's for segments below its folder", () => {
  const config = load(
    [
      "global:",
      "  ignore:",
      "    pattern: '^\\.'",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    ignore:",
      "      pattern: tmp",
    ].join("\n"),
  );

  assert.equal(isIgnored(config, "notes/tmp"), true);
  assert.equal(isIgnored(config, "notes/tmp/draft.md"), true);
  // global's dotfile pattern was replaced below notes/.
  assert.equal(isIgnored(config, "notes/.hidden"), false);
  // but still governs the root, other folders, and the folder name itself.
  assert.equal(isIgnored(config, ".hidden"), true);
  assert.equal(isIgnored(config, "misc/.hidden"), true);
});

// vault.md: "a top-level folder's name answers to `global`'s `ignore`" —
// even when the folder's own entry declares an ignore block of its own.
test("a top-level folder's own name answers to global's ignore, not its entry's", () => {
  const config = load(
    [
      "global:",
      "  ignore:",
      "    pattern: tmp",
      "paths:",
      "  tmp-cache:",
      "    description: Cache.",
      "    ignore: {}",
    ].join("\n"),
  );

  // The folder name plain-matches global's pattern, so the folder and its
  // whole subtree are ignored; its entry's ignore: {} governs only below
  // it and cannot exempt the folder itself.
  assert.equal(isIgnored(config, "tmp-cache"), true);
  assert.equal(isIgnored(config, "tmp-cache/x.md"), true);
});

test("ignore: {} relaxes a global ignore rule below the folder", () => {
  const config = load(
    [
      "global:",
      "  ignore:",
      "    pattern: '^\\.'",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    ignore: {}",
    ].join("\n"),
  );

  assert.equal(isIgnored(config, "notes/.hidden"), false);
  assert.equal(isIgnored(config, ".hidden"), true);
});

test("nothing is ignored without an ignore pattern", () => {
  const config = load("{}");
  assert.equal(isIgnored(config, ".git"), false);
  assert.equal(isIgnored(config, "notes/.trash/x.md"), false);
});
