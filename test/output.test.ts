import assert from "node:assert/strict";
import { test } from "node:test";
import pc from "picocolors";
import { type CheckResult } from "../dist/check.js";
import { count, renderCheckReport, renderInitReport, Spinner } from "../dist/output.js";

const strip = (text: string) => text.replace(/\x1b\[\d+m/gu, "");
const mixed: CheckResult = { findings: [
  { rule: "extensions", severity: "violation", file: "contacts/Author Notes.txt", message: ".txt is not among the extensions this path holds" },
  { rule: "schema", severity: "violation", file: "contacts/jules-verne.md", message: "title must be a string" },
  { rule: "parse", severity: "violation", file: "cafe\u0301.md", message: "frontmatter is not valid YAML" },
  { rule: "internal_links.resolve", severity: "warning", file: "events/2026-08-07-studio-visit.md", message: "[[contacts/mira-holt]] does not exist" },
], filesChecked: 68 };
const plain = "✗ contacts/Author Notes.txt          extensions: .txt is not among the extensions this path holds\n✗ contacts/jules-verne.md            schema: title must be a string\n✗ cafe\u0301.md                            parse: frontmatter is not valid YAML\n! events/2026-08-07-studio-visit.md  internal_links.resolve: [[contacts/mira-holt]] does not exist\n\n3 violations · 1 warning · 68 files\n";

test("check renderer aligns a mixed report including an NFD path", () => assert.equal(renderCheckReport(mixed, { color: false }), plain));
test("styled and plain reports have byte-identical content", () => assert.equal(strip(renderCheckReport(mixed, { color: true })), plain));
test("palette applies to each semantic role", () => {
  const c = pc.createColors(true); const rendered = renderCheckReport(mixed, { color: true });
  assert.ok(rendered.includes(c.red("✗"))); assert.ok(rendered.includes(c.yellow("!")));
  assert.ok(rendered.includes(c.red("schema:"))); assert.ok(rendered.includes(c.bold("contacts/jules-verne.md")));
  assert.ok(rendered.includes(c.dim("3 violations · 1 warning · 68 files")));
});
test("config finding names autofile.yml and omits zero warning count", () => {
  assert.equal(renderCheckReport({ findings: [{ rule: "config", severity: "violation", file: "autofile.yml", message: "/contacts has an unknown key \"shema\"" }], filesChecked: 0 }, { color: false }), "✗ autofile.yml  config: /contacts has an unknown key \"shema\"\n\n1 violation · 0 files\n");
});
test("parse findings render on one line even when an error includes a YAML source snippet", () => {
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
    "✗ notes/broken.md  parse: frontmatter is not valid YAML: unexpected end (2:1) 1 | a: [ 2 | -----^\n\n1 violation · 1 file\n",
  );
});
test("clean report and init report match the specification", () => {
  assert.equal(renderCheckReport({ findings: [], filesChecked: 68 }, { color: false }), "✓ 68 files\n");
  assert.equal(renderInitReport("autofile.yml",{ color: false }), "Initialized an Autofile vault.\n\n  autofile.yml\n");
  const c = pc.createColors(true);
  assert.equal(renderCheckReport({ findings: [], filesChecked: 68 }, { color: true }), `${c.green("✓")} ${c.dim("68 files")}\n`);
  assert.ok(renderInitReport("autofile.yml",{ color: true }).includes(c.green("autofile.yml")));
  assert.equal(strip(renderInitReport("autofile.yml",{ color: true })), renderInitReport("autofile.yml",{ color: false }));
});

test("file count is singular for the spinner and report", () => {
  assert.equal(count(1, "file"), "1 file");
  assert.equal(renderCheckReport({ findings: [], filesChecked: 1 }, { color: false }), "\u2713 1 file\n");
});

interface Fake { isTTY?: boolean; writes: string[]; write(chunk: string): boolean }
const fake = (isTTY: boolean): Fake => ({ isTTY, writes: [] as string[], write(chunk) { this.writes.push(chunk); return true; } });
const clear = "\r\x1b[2K";
test("spinner waits 200ms, draws frames, and completely erases on stop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fake(true); const spinner = new Spinner(stream); spinner.start("Checking… 0 files");
  t.mock.timers.tick(199); assert.equal(stream.writes.length, 0); t.mock.timers.tick(1);
  assert.match(stream.writes[0]!, /^\r\x1b\[2K\x1b\[36m⠋/u); t.mock.timers.tick(80); assert.equal(stream.writes.length, 2);
  assert.ok(stream.writes[0]!.includes("\x1b[2mChecking… 0 files\x1b[22m"));
  spinner.update("Checking… 42 files"); t.mock.timers.tick(80);
  assert.ok(stream.writes[2]!.includes("\x1b[2mChecking… 42 files\x1b[22m"));
  spinner.stop(); assert.equal(stream.writes.at(-1), clear); const count = stream.writes.length;
  t.mock.timers.tick(1000); assert.equal(stream.writes.length, count);
});
test("spinner stopped before threshold writes nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] }); const stream = fake(true);
  const spinner = new Spinner(stream); spinner.start("Initializing…"); t.mock.timers.tick(199); spinner.stop(); t.mock.timers.tick(1000); assert.deepEqual(stream.writes, []);
});
test("spinner writes zero bytes to a non-TTY", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] }); const stream = fake(false);
  const spinner = new Spinner(stream); spinner.start("Checking… 0 files"); t.mock.timers.tick(1000); spinner.update("Checking… 42 files"); spinner.stop(); assert.deepEqual(stream.writes, []);
});
