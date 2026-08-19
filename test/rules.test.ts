import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { check, type Finding, type Rule } from "@telepath-computer/autofile";

import { parseConfig, type Config } from "../dist/config.js";
import { writeFindings } from "../dist/rules.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function config(source: string): Config {
  const parsed = parseConfig(source);
  if (!parsed.ok) assert.fail(parsed.errors.map(({ message }) => message).join("; "));
  return parsed.config;
}

function rules(findings: Finding[]): Rule[] {
  return findings.map(({ rule }) => rule);
}

test("write record rules produce the exact findings check produces for the same faults", async () => {
  const source = `version: 1
link_format: wikilink
folders:
  - path: contacts
    description: Contacts.
    extensions: [txt]
    filename_pattern: '[a-z]+'
    schema:
      type: object
      properties:
        title: { type: string }
    body: none
`;
  const root = await mkdtemp(join(tmpdir(), "autofile-rules-"));
  roots.push(root);
  await mkdir(join(root, "contacts"));
  await writeFile(join(root, "autofile.yml"), source);
  await writeFile(
    join(root, "contacts", "Bad Name.md"),
    "---\ntitle: 7\nfriend: '[Missing](missing)'\n---\n[Body](missing)",
  );

  const write = writeFindings(config(source), {
    path: "contacts/Bad Name",
    fields: { title: 7, friend: "[Missing](missing)" },
    body: "[Body](missing)",
  }, []);
  const sharedRules = new Set<Rule>(["schema", "body", "filename_pattern", "extensions", "link_format"]);
  const checked = (await check(root)).findings.filter(({ rule }) => sharedRules.has(rule));

  assert.deepEqual(write, checked);
  assert.deepEqual(rules(write), ["body", "extensions", "filename_pattern", "link_format", "link_format", "schema"]);
});

test("a folder whose extensions omit md refuses every prospective write", () => {
  const restricted = config(`version: 1
folders:
  - path: records
    description: Non-markdown records.
    extensions: [txt]
`);

  for (const path of ["records/one", "records/nested/two"]) {
    assert.deepEqual(writeFindings(restricted, { path, fields: {} }, []).filter(({ rule }) => rule === "extensions"), [{
      rule: "extensions",
      severity: "violation",
      file: `${path}.md`,
      message: "md is not among the extensions this folder accepts",
    }]);
  }
});

test("additional_subfolders applies to a write, while a declared carve-out governs wholesale", () => {
  const configured = config(`version: 1
folders:
  - path: closed
    description: Closed.
    additional_subfolders: false
  - path: closed/allowed
    description: Allowed carve-out.
`);

  assert.deepEqual(writeFindings(configured, {
    path: "closed/extra/note",
    fields: {},
  }, []), [{
    rule: "additional_subfolders",
    severity: "violation",
    file: "closed/extra",
    message: "subfolder is not allowed by folders closed",
  }]);
  assert.deepEqual(writeFindings(configured, {
    path: "closed/allowed/deep/note",
    fields: {},
  }, []), []);
});

test("coverage applies only under strict and ignore accounts for an otherwise uncovered write", () => {
  const loose = config("version: 1\n");
  const strict = config("version: 1\nstrict: true\nignore: ['^ignored$']\n");
  const record = { path: "outside/note", fields: {} };

  assert.deepEqual(writeFindings(loose, record, []), []);
  assert.deepEqual(writeFindings(strict, record, []), [{
    rule: "coverage",
    severity: "violation",
    file: "outside/note.md",
    message: "no folder entry accounts for this file",
  }]);
  assert.deepEqual(writeFindings(strict, { path: "ignored/note", fields: {} }, []), []);
});

test("collision compares prospective and governed paths by case and Unicode normalization", () => {
  const configured = config(`version: 1
folders:
  - path: .
    description: Everything.
`);

  assert.deepEqual(writeFindings(configured, {
    path: "people/jane",
    fields: {},
  }, ["people/jane.md", "people/Jane.md"]), [{
    rule: "collision",
    severity: "violation",
    file: "people/jane.md",
    message: "collides with \"people/Jane.md\"",
  }]);

  const nfd = "cafe\u0301/note";
  assert.deepEqual(writeFindings(configured, { path: nfd, fields: {} }, ["café/note.md"]), [
    {
      rule: "collision",
      severity: "violation",
      file: "cafe\u0301",
      message: "collides with \"café\"",
    },
    {
      rule: "collision",
      severity: "violation",
      file: `${nfd}.md`,
      message: "collides with \"café/note.md\"",
    },
  ]);
});

test("collision includes ancestor paths just as check does", () => {
  const configured = config(`version: 1
folders:
  - path: files
    description: Files.
`);

  assert.deepEqual(writeFindings(configured, {
    path: "files/a/new",
    fields: {},
  }, ["files/A/old.md"]), [{
    rule: "collision",
    severity: "violation",
    file: "files/a",
    message: "collides with \"files/A\"",
  }]);
});

test("parse, resolve, missing, config, and description are not evaluated on writes", () => {
  const configured = config(`version: 1
link_format: wikilink
folders:
  - path: absent
`);

  const findings = writeFindings(configured, {
    path: "absent/note",
    fields: { friend: "[[does-not-exist]]" },
    body: "[[also-missing]]",
  }, []);
  assert.deepEqual(findings, []);
  assert.deepEqual(rules(findings), []);
});
