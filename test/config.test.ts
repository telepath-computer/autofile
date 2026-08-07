import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, parseConfig, starterConfig, type Config } from "@telepath-computer/autofile";

// spec/vault.md example config, verbatim.
const vaultExample = String.raw`global:
  ignore:
    pattern: '^\.'
  filenames:
    pattern: '^[a-z0-9][a-z0-9-]*$'
  assets:
    allowed: false

paths:
  contacts:
    description: |
      People and organizations. One record per person or organization.
      Update the existing record when someone's details change.
    records:
      schema:
        required: [name, type]
        properties:
          name: { type: string }
          type: { enum: [person, organization] }
      body:
        allowed: false

  events:
    description: |
      Dated records of things that happened: meetings, calls, visits.
    records:
      schema:
        required: [title, date]
        properties:
          title: { type: string }
          date: { type: string, format: date }

  assets:
    description: |
      Source material and attached files: scans, photos, downloads.
    assets:
      allowed: true
`;

function mustParse(source: string): Config {
  const result = parseConfig(source);
  assert.ok(result.ok, `expected valid config, got: ${JSON.stringify(!result.ok && result.errors)}`);
  return result.config;
}

function mustFail(source: string): { message: string }[] {
  const result = parseConfig(source);
  assert.ok(!result.ok, "expected config errors");
  assert.ok(result.errors.length > 0, "expected at least one error");
  for (const error of result.errors) assert.equal(typeof error.message, "string");
  return result.errors;
}

// vault.md: the example config is a valid config.
test("vault.md example config parses into the model", () => {
  const config = mustParse(vaultExample);
  assert.deepEqual([...config.paths.keys()], ["contacts", "events", "assets"]);

  assert.equal(config.global?.assets?.allowed, false);
  assert.equal(config.global?.ignore?.pattern?.source, String.raw`^\.`);
  assert.equal(config.global?.filenames?.pattern?.source, "^[a-z0-9][a-z0-9-]*$");

  const contacts = config.paths.get("contacts");
  assert.ok(contacts);
  assert.match(contacts.description, /People and organizations/);
  assert.equal(contacts.records?.body?.allowed, false);
  assert.ok(contacts.records?.schema);
  assert.equal(contacts.records.schema.validate({ name: "Priya Narayan", type: "person" }), true);
  assert.equal(contacts.records.schema.validate({ name: 42, type: "person" }), false);
  assert.equal(contacts.records.schema.validate({}), false);

  const assets = config.paths.get("assets");
  assert.equal(assets?.assets?.allowed, true);
  assert.equal(assets?.records, undefined);
});

// vault.md: "`format` is asserted, so `format: date` must hold a date."
test("schema formats are asserted", () => {
  const config = mustParse(vaultExample);
  const schema = config.paths.get("events")?.records?.schema;
  assert.ok(schema);
  assert.equal(schema.validate({ title: "Studio visit", date: "2026-08-07" }), true);
  assert.equal(schema.validate({ title: "Studio visit", date: "not a date" }), false);
});

// cli.md: the starter config is a valid config.
test("cli.md starter config parses into the model", () => {
  const config = mustParse(starterConfig);
  assert.deepEqual([...config.paths.keys()], ["datasets", "assets", "topics"]);

  const datasets = config.paths.get("datasets");
  assert.ok(datasets?.records?.schema);
  assert.equal(datasets.records.schema.validate({ title: "t", description: "d", data: [1, 2] }), true);
  assert.equal(datasets.records.schema.validate({ title: "t", description: "d" }), false);

  const topics = config.paths.get("topics");
  assert.ok(topics?.records?.schema);
  assert.equal(topics.records.schema.validate({ title: "t", description: "d" }), true);
});

// vault.md: "Both top-level keys are optional — a config that declares
// neither is a valid vault with no rules."
test("empty configs are valid", () => {
  for (const source of ["", "{}", "\n# just a comment\n"]) {
    const config = mustParse(source);
    assert.equal(config.global, undefined);
    assert.equal(config.paths.size, 0);
  }
});

test("config with only global, or only paths, is valid", () => {
  const globalOnly = mustParse("global:\n  assets:\n    allowed: false\n");
  assert.equal(globalOnly.global?.assets?.allowed, false);
  assert.equal(globalOnly.paths.size, 0);

  const pathsOnly = mustParse("paths:\n  notes:\n    description: Notes.\n");
  assert.equal(pathsOnly.global, undefined);
  assert.equal(pathsOnly.paths.get("notes")?.description, "Notes.");
});

// vault.md: "Unknown keys are rejected at every level".
test("unknown key at top level is rejected", () => {
  const errors = mustFail("extra: 1\n");
  assert.match(errors[0]!.message, /extra/);
});

test("unknown key in global is rejected", () => {
  const errors = mustFail("global:\n  colour: red\n");
  assert.match(errors[0]!.message, /colour/);
});

test("unknown key in a path entry is rejected", () => {
  const errors = mustFail("paths:\n  notes:\n    description: Notes.\n    recordz: {}\n");
  assert.match(errors[0]!.message, /recordz/);
});

test("unknown key in a records block is rejected", () => {
  const errors = mustFail("paths:\n  notes:\n    description: Notes.\n    records:\n      strict: true\n");
  assert.match(errors[0]!.message, /strict/);
});

test("unknown key in a body block is rejected", () => {
  const errors = mustFail(
    "paths:\n  notes:\n    description: Notes.\n    records:\n      body:\n        allowed: false\n        max: 3\n",
  );
  assert.match(errors[0]!.message, /max/);
});

test("unknown key in an assets block is rejected", () => {
  const errors = mustFail("global:\n  assets:\n    allowed: true\n    kinds: [pdf]\n");
  assert.match(errors[0]!.message, /kinds/);
});

test("unknown key in a filenames block is rejected", () => {
  const errors = mustFail("global:\n  filenames:\n    pattern: abc\n    flags: i\n");
  assert.match(errors[0]!.message, /flags/);
});

test("unknown key in an ignore block is rejected", () => {
  const errors = mustFail("global:\n  ignore:\n    pattern: abc\n    subtree: false\n");
  assert.match(errors[0]!.message, /subtree/);
});

// vault.md: "`description` — ... Path entries only, and required on each."
test("path entry without a description is rejected", () => {
  const errors = mustFail("paths:\n  notes:\n    records: {}\n");
  assert.match(errors[0]!.message, /notes/);
  assert.match(errors[0]!.message, /description/);
});

test("description on global is rejected", () => {
  const errors = mustFail("global:\n  description: The vault.\n");
  assert.match(errors[0]!.message, /global/);
  assert.match(errors[0]!.message, /description/);
});

// vault.md: paths are "keyed by folder name — a single path segment, no `/`".
test("a paths key containing a slash is rejected", () => {
  const errors = mustFail("paths:\n  notes/daily:\n    description: Daily notes.\n");
  assert.match(errors[0]!.message, /notes\/daily/);
});

// vault.md: a paths key names a folder, so it must be a name every
// filesystem can hold: "no empty path segments, no `.` or `..` segments,
// no control characters, Unicode NFC".
test("an empty paths key is rejected", () => {
  const errors = mustFail("paths:\n  '':\n    description: Nameless.\n");
  assert.match(errors[0]!.message, /paths/);
  assert.match(errors[0]!.message, /empty/);
});

test("a paths key of . or .. is rejected", () => {
  const dot = mustFail("paths:\n  '.':\n    description: Here.\n");
  assert.match(dot[0]!.message, /paths\."\."/);

  const dotdot = mustFail("paths:\n  '..':\n    description: Up.\n");
  assert.match(dotdot[0]!.message, /paths\."\.\."/);
});

test("a paths key containing a control character is rejected", () => {
  const errors = mustFail('paths:\n  "a\\tb":\n    description: Tabbed.\n');
  assert.match(errors[0]!.message, /control character/);
});

test("a paths key that is not Unicode NFC is rejected", () => {
  // "café" with a combining acute accent — the decomposed (NFD) form.
  const errors = mustFail('paths:\n  "cafe\\u0301":\n    description: Coffee.\n');
  assert.match(errors[0]!.message, /NFC/);
});

// vault.md: "Two paths that differ only by case are rejected".
test("two paths keys differing only by case are rejected", () => {
  const errors = mustFail(
    "paths:\n  Notes:\n    description: Notes.\n  notes:\n    description: Also notes.\n",
  );
  assert.match(errors[0]!.message, /[Nn]otes/);
});

// vault.md: "A schema that does not compile as JSON Schema ... is rejected".
test("an uncompilable schema is rejected, naming the location", () => {
  const errors = mustFail(
    "paths:\n  notes:\n    description: Notes.\n    records:\n      schema:\n        type: 42\n",
  );
  assert.match(errors[0]!.message, /paths\.notes\.records\.schema/);
});

// vault.md: "Schemas compile strictly, so an unknown schema keyword is
// rejected like any other misspelled key."
test("a schema with an unknown keyword is rejected, naming the strict rejection", () => {
  const errors = mustFail(
    "paths:\n  notes:\n    description: Notes.\n    records:\n      schema:\n        requird: [name]\n",
  );
  assert.match(errors[0]!.message, /paths\.notes\.records\.schema/);
  assert.match(errors[0]!.message, /strict mode/);
  assert.match(errors[0]!.message, /requird/);
});

// A schema that is legal JSON Schema but rejected by strict mode: the
// error must say what happened — a strict rejection, not a compile failure.
test("a legal schema rejected by strict mode names the strict rejection", () => {
  const errors = mustFail(
    "paths:\n  notes:\n    description: Notes.\n    records:\n      schema:\n        if:\n          required: [name]\n",
  );
  assert.match(errors[0]!.message, /paths\.notes\.records\.schema/);
  assert.match(errors[0]!.message, /strict mode/);
  assert.doesNotMatch(errors[0]!.message, /does not compile/);
});

// vault.md: "a pattern that does not compile as a regular expression, is
// rejected".
test("an uncompilable pattern is rejected, naming the location", () => {
  const globalErrors = mustFail("global:\n  filenames:\n    pattern: '('\n");
  assert.match(globalErrors[0]!.message, /global\.filenames\.pattern/);

  const pathErrors = mustFail("paths:\n  notes:\n    description: Notes.\n    ignore:\n      pattern: '['\n");
  assert.match(pathErrors[0]!.message, /paths\.notes\.ignore\.pattern/);
});

test("a non-string pattern and a non-boolean allowed are rejected", () => {
  const patternErrors = mustFail("global:\n  ignore:\n    pattern: 3\n");
  assert.match(patternErrors[0]!.message, /global\.ignore\.pattern/);

  const allowedErrors = mustFail("global:\n  assets:\n    allowed: sometimes\n");
  assert.match(allowedErrors[0]!.message, /global\.assets\.allowed/);
});

// vault.md: an autofile.yml that "does not parse, or does not match the
// above makes the vault invalid" — reported as data, not thrown.
test("unparseable YAML is a config error, not an exception", () => {
  const errors = mustFail("global: [unclosed\n");
  assert.equal(typeof errors[0]!.message, "string");
});

test("a non-mapping document is a config error", () => {
  mustFail("- a\n- b\n");
  mustFail("just a string\n");
});

// vault.md: "An `autofile.yml` that cannot be read ... makes the vault
// invalid" — reported as a config error, not thrown.
test("a missing config file is a config error, not an exception", async () => {
  const result = await loadConfig("/nonexistent/autofile.yml");
  assert.ok(!result.ok, "expected config errors");
  assert.match(result.errors[0]!.message, /cannot be read/);
});

// The on-disk success path: the spec/cli.md starter config, written to a
// file and loaded, yields the full compiled model.
test("loadConfig loads the starter config from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autofile-config-"));
  try {
    const filePath = join(dir, "autofile.yml");
    await writeFile(filePath, starterConfig);
    const result = await loadConfig(filePath);
    assert.ok(result.ok, "expected the starter config to load");
    const config = result.config;
    assert.deepEqual([...config.paths.keys()], ["datasets", "assets", "topics"]);
    assert.equal(config.global?.assets?.allowed, false);
    assert.equal(config.global?.filenames?.pattern?.source, "^[a-z0-9][a-z0-9-]*$");
    const schema = config.paths.get("datasets")?.records?.schema;
    assert.ok(schema !== undefined, "expected the datasets schema compiled");
    assert.equal(schema.validate({ title: "T", description: "D", data: 1 }), true);
    assert.equal(schema.validate({}), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// YAML leaves a bare key null; a bare rule-block key declares an empty
// block, same as an explicit `records: {}`.
test("a bare rule-block key behaves as an empty block", () => {
  const config = mustParse(
    "global:\n  ignore:\npaths:\n  notes:\n    description: Notes.\n    records:\n",
  );
  assert.deepEqual(config.global?.ignore, {});
  assert.deepEqual(config.paths.get("notes")?.records, {});
});

test("duplicate YAML keys are a parse error", () => {
  const errors = mustFail("global:\n  ignore: {}\n  ignore: {}\n");
  assert.match(errors[0]!.message, /does not parse/);
});

test("global as a scalar or an array is a config error", () => {
  const scalarErrors = mustFail("global: strict\n");
  assert.match(scalarErrors[0]!.message, /global.*must be a mapping/);

  const arrayErrors = mustFail("global:\n  - ignore\n");
  assert.match(arrayErrors[0]!.message, /global.*must be a mapping/);
});

test("paths as a scalar or an array is a config error", () => {
  const scalarErrors = mustFail("paths: notes\n");
  assert.match(scalarErrors[0]!.message, /paths.*must be a mapping/);

  const arrayErrors = mustFail("paths:\n  - notes\n");
  assert.match(arrayErrors[0]!.message, /paths.*must be a mapping/);
});

test("all errors are collected, not just the first", () => {
  const errors = mustFail(
    "global:\n  filenames:\n    pattern: '('\n  ignore:\n    pattern: '['\npaths:\n  notes:\n    records: {}\n",
  );
  assert.ok(errors.length >= 3, `expected 3 errors, got ${errors.length}`);
});
