import assert from "node:assert/strict";
import { test } from "node:test";
import pc from "picocolors";

import { type CheckResult } from "../dist/check.js";
import { count, renderCheckReport, renderInitReport, Spinner } from "../dist/output.js";

const strip = (text: string) => text.replace(/\x1b\[\d+m/gu, "");
const mixed: CheckResult = {
  findings: [
    { rule: "coverage", severity: "violation", file: "contacts/author-notes.txt", message: "no folder entry accounts for this file" },
    { rule: "schema", severity: "violation", file: "contacts/jules-verne.md", message: "title must be a string" },
    { rule: "link_format", severity: "violation", file: "events/studio-visit.md", message: "[Mira](../contacts/mira-holt) must use wikilink format" },
    { rule: "resolve", severity: "warning", file: "events/studio-visit.md", message: "[[contacts/mira-holt]] does not exist" },
  ],
  filesChecked: 68,
};
const plain = "✗ contacts/author-notes.txt  coverage: no folder entry accounts for this file\n✗ contacts/jules-verne.md    schema: title must be a string\n✗ events/studio-visit.md     link_format: [Mira](../contacts/mira-holt) must use wikilink format\n! events/studio-visit.md     resolve: [[contacts/mira-holt]] does not exist\n\n3 violations · 1 warning · 68 files\n";

test("check renderer aligns the report and uses the new finding names", () => {
  assert.equal(renderCheckReport(mixed, { color: false }), plain);
});

test("file-column alignment uses terminal width for ASCII, CJK, and combining marks", () => {
  const result: CheckResult = {
    findings: [
      { rule: "coverage", severity: "violation", file: "漢字.md", message: "wide" },
      { rule: "coverage", severity: "violation", file: "cafe\u0301.md", message: "combining" },
      { rule: "coverage", severity: "violation", file: "seven.md", message: "ascii" },
    ],
    filesChecked: 3,
  };
  assert.equal(renderCheckReport(result, { color: false }), [
    "✗ 漢字.md   coverage: wide",
    "✗ cafe\u0301.md   coverage: combining",
    "✗ seven.md  coverage: ascii",
    "",
    "3 violations · 3 files",
    "",
  ].join("\n"));
});

test("styled and plain reports have byte-identical content", () => {
  assert.equal(strip(renderCheckReport(mixed, { color: true })), plain);
});

test("palette applies to each semantic role", () => {
  const c = pc.createColors(true);
  const rendered = renderCheckReport(mixed, { color: true });
  assert.ok(rendered.includes(c.red("✗")));
  assert.ok(rendered.includes(c.yellow("!")));
  assert.ok(rendered.includes(c.red("schema:")));
  assert.ok(rendered.includes(c.yellow("resolve:")));
  assert.ok(rendered.includes(c.bold("contacts/jules-verne.md")));
  assert.ok(rendered.includes(c.dim("3 violations · 1 warning · 68 files")));
});

test("config findings name folder entries by path", () => {
  assert.equal(renderCheckReport({
    findings: [{
      rule: "config",
      severity: "violation",
      file: "autofile.yml",
      message: 'folders contacts has an unknown key "shema"',
    }],
    filesChecked: 0,
  }, { color: false }), "✗ autofile.yml  config: folders contacts has an unknown key \"shema\"\n\n1 violation · 0 files\n");
});

test("parse findings render on one line even when an error contains a source excerpt", () => {
  const result: CheckResult = {
    findings: [{
      rule: "parse",
      severity: "violation",
      file: "notes/broken.md",
      message: "frontmatter is not valid YAML: unexpected end (2:1)\n\n 1 | a: [\n 2 |\n-----^",
    }],
    filesChecked: 1,
  };
  assert.equal(
    renderCheckReport(result, { color: false }),
    "✗ notes/broken.md  parse: frontmatter is not valid YAML: unexpected end (2:1)\\n\\n 1 | a: [\\n 2 |\\n-----^\n\n1 violation · 1 file\n",
  );
});

test("paths and messages escape line-breaking and terminal control characters", () => {
  const rendered = renderCheckReport({
    findings: [
      { rule: "coverage", severity: "violation", file: "bad\nname.md", message: "first\rline" },
      { rule: "resolve", severity: "warning", file: "plain.md", message: "\x1b[31mred\ttext" },
    ],
    filesChecked: 2,
  }, { color: false });
  assert.equal(rendered, [
    "✗ bad\\nname.md  coverage: first\\rline",
    "! plain.md      resolve: \\u001b[31mred\\ttext",
    "",
    "1 violation · 1 warning · 2 files",
    "",
  ].join("\n"));
  assert.doesNotMatch(rendered, /[\r\x1b]/u);
});

test("clean, warning-only, and init reports match the specification", () => {
  assert.equal(renderCheckReport({ findings: [], filesChecked: 68 }, { color: false }), "✓ 68 files\n");
  assert.equal(renderCheckReport({
    findings: [{ rule: "missing", severity: "warning", file: "assets", message: "declared path is missing" }],
    filesChecked: 0,
  }, { color: false }), "! assets  missing: declared path is missing\n\n1 warning · 0 files\n");
  assert.equal(renderInitReport("autofile.yml", { color: false }), "Initialized an Autofile vault.\n\n  autofile.yml\n");

  const c = pc.createColors(true);
  assert.equal(renderCheckReport({ findings: [], filesChecked: 68 }, { color: true }), `${c.green("✓")} ${c.dim("68 files")}\n`);
  assert.ok(renderInitReport("autofile.yml", { color: true }).includes(c.green("autofile.yml")));
  assert.equal(strip(renderInitReport("autofile.yml", { color: true })), renderInitReport("autofile.yml", { color: false }));
});

test("file count is singular for spinner and report", () => {
  assert.equal(count(1, "file"), "1 file");
  assert.equal(renderCheckReport({ findings: [], filesChecked: 1 }, { color: false }), "✓ 1 file\n");
});

interface Fake { isTTY?: boolean; writes: string[]; write(chunk: string): boolean }
const fake = (isTTY: boolean): Fake => ({
  isTTY,
  writes: [],
  write(chunk) {
    this.writes.push(chunk);
    return true;
  },
});
const clear = "\r\x1b[2K";

test("spinner waits 200ms, draws frames, and completely erases on stop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fake(true);
  const spinner = new Spinner(stream);
  spinner.start("Checking… 0 files");
  t.mock.timers.tick(199);
  assert.equal(stream.writes.length, 0);
  t.mock.timers.tick(1);
  assert.match(stream.writes[0]!, /^\r\x1b\[2K\x1b\[36m⠋/u);
  t.mock.timers.tick(80);
  assert.equal(stream.writes.length, 2);
  spinner.update("Checking… 42 files");
  t.mock.timers.tick(80);
  assert.ok(stream.writes[2]!.includes("\x1b[2mChecking… 42 files\x1b[22m"));
  spinner.stop();
  assert.equal(stream.writes.at(-1), clear);
  const writes = stream.writes.length;
  t.mock.timers.tick(1000);
  assert.equal(stream.writes.length, writes);
});

test("spinner stopped before threshold writes nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fake(true);
  const spinner = new Spinner(stream);
  spinner.start("Initializing…");
  t.mock.timers.tick(199);
  spinner.stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(stream.writes, []);
});

test("spinner writes zero bytes to a non-TTY", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fake(false);
  const spinner = new Spinner(stream);
  spinner.start("Checking… 0 files");
  t.mock.timers.tick(1000);
  spinner.update("Checking… 42 files");
  spinner.stop();
  assert.deepEqual(stream.writes, []);
});
