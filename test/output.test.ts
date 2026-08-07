import assert from "node:assert/strict";
import { test } from "node:test";

import pc from "picocolors";

import {
  renderCheckReport,
  renderInitReport,
  Spinner,
  type CheckResult,
} from "@telepath-computer/autofile";

const c = pc.createColors(true);

/** Strips picocolors' ANSI styling codes. */
function strip(text: string): string {
  return text.replace(/\x1b\[\d+m/g, "");
}

// The spec's own example: 2 violations, 1 warning, 68 files (spec/cli.md).
const mixed: CheckResult = {
  findings: [
    {
      rule: "schema",
      severity: "violation",
      file: "contacts/jules-verne.md",
      message: "name must be a string",
    },
    {
      rule: "asset",
      severity: "violation",
      file: "contacts/Author Notes.txt",
      message: "not a record, in a path that forbids assets",
    },
    {
      rule: "reference",
      severity: "warning",
      file: "events/2026-08-07-studio-visit.md",
      message: "[[contacts/mira-holt]] does not exist",
    },
  ],
  filesChecked: 68,
};

const mixedPlain = [
  "✗ contacts/jules-verne.md            schema: name must be a string",
  "✗ contacts/Author Notes.txt          asset: not a record, in a path that forbids assets",
  "! events/2026-08-07-studio-visit.md  reference: [[contacts/mira-holt]] does not exist",
  "",
  "2 violations · 1 warning · 68 files",
  "",
].join("\n");

test("check report renders the spec example exactly, plain", () => {
  assert.equal(renderCheckReport(mixed, { color: false }), mixedPlain);
});

test("check report colors markers, rule prefixes, files, and summary", () => {
  const gap12 = " ".repeat(12);
  const gap10 = " ".repeat(10);
  const expected = [
    `${c.red("✗")} ${c.bold("contacts/jules-verne.md")}${gap12}${c.red("schema:")} name must be a string`,
    `${c.red("✗")} ${c.bold("contacts/Author Notes.txt")}${gap10}${c.red("asset:")} not a record, in a path that forbids assets`,
    `${c.yellow("!")} ${c.bold("events/2026-08-07-studio-visit.md")}  ${c.yellow("reference:")} [[contacts/mira-holt]] does not exist`,
    "",
    c.dim("2 violations · 1 warning · 68 files"),
    "",
  ].join("\n");
  assert.equal(renderCheckReport(mixed, { color: true }), expected);
});

test("stripping ANSI from the colored check report equals the plain report", () => {
  assert.equal(strip(renderCheckReport(mixed, { color: true })), mixedPlain);
});

test("check report is byte-deterministic", () => {
  assert.equal(
    renderCheckReport(mixed, { color: false }),
    renderCheckReport(mixed, { color: false }),
  );
  assert.equal(
    renderCheckReport(mixed, { color: true }),
    renderCheckReport(mixed, { color: true }),
  );
});

test("clean run prints only the ✓ summary", () => {
  const result: CheckResult = { findings: [], filesChecked: 68 };
  assert.equal(renderCheckReport(result, { color: false }), "✓ 68 files\n");
});

test("clean run colors: green ✓, dim count", () => {
  const result: CheckResult = { findings: [], filesChecked: 68 };
  assert.equal(
    renderCheckReport(result, { color: true }),
    "\x1b[32m✓\x1b[39m \x1b[2m68 files\x1b[22m\n",
  );
});

test("clean run singularizes one file", () => {
  const result: CheckResult = { findings: [], filesChecked: 1 };
  assert.equal(renderCheckReport(result, { color: false }), "✓ 1 file\n");
});

test("config findings render without a file cell", () => {
  const result: CheckResult = {
    findings: [
      {
        rule: "config",
        severity: "violation",
        message: "autofile.yml is not valid YAML",
      },
    ],
    filesChecked: 0,
  };
  assert.equal(
    renderCheckReport(result, { color: false }),
    ["✗ config: autofile.yml is not valid YAML", "", "1 violation · 0 warnings · 0 files", ""].join(
      "\n",
    ),
  );
});

test("summary singularizes counts of one", () => {
  const result: CheckResult = {
    findings: [
      { rule: "root", severity: "violation", file: "stray.txt", message: "loose file" },
      { rule: "empty", severity: "warning", file: "topics", message: "folder is empty" },
    ],
    filesChecked: 1,
  };
  assert.equal(
    renderCheckReport(result, { color: false }),
    [
      "✗ stray.txt  root: loose file",
      "! topics     empty: folder is empty",
      "",
      "1 violation · 1 warning · 1 file",
      "",
    ].join("\n"),
  );
});

test("warnings-only report renders findings and the full summary", () => {
  const result: CheckResult = {
    findings: [
      { rule: "empty", severity: "warning", file: "topics", message: "folder is empty" },
      {
        rule: "reference",
        severity: "warning",
        file: "notes/today.md",
        message: "[[contacts/mira-holt]] does not exist",
      },
    ],
    filesChecked: 12,
  };
  assert.equal(
    renderCheckReport(result, { color: false }),
    [
      "! topics          empty: folder is empty",
      "! notes/today.md  reference: [[contacts/mira-holt]] does not exist",
      "",
      "0 violations · 2 warnings · 12 files",
      "",
    ].join("\n"),
  );
});

test("config findings color the marker and rule prefix red, no file cell", () => {
  const result: CheckResult = {
    findings: [
      {
        rule: "config",
        severity: "violation",
        message: "autofile.yml is not valid YAML",
      },
    ],
    filesChecked: 0,
  };
  assert.equal(
    renderCheckReport(result, { color: true }),
    [
      `${c.red("✗")} ${c.red("config:")} autofile.yml is not valid YAML`,
      "",
      c.dim("1 violation · 0 warnings · 0 files"),
      "",
    ].join("\n"),
  );
});

test("file column is padded to the longest file in the report", () => {
  const result: CheckResult = {
    findings: [
      { rule: "parse", severity: "violation", file: "a.md", message: "unreadable" },
      {
        rule: "schema",
        severity: "violation",
        file: "some/deeply/nested/record.md",
        message: "bad",
      },
    ],
    filesChecked: 2,
  };
  assert.equal(
    renderCheckReport(result, { color: false }),
    [
      "✗ a.md                          parse: unreadable",
      "✗ some/deeply/nested/record.md  schema: bad",
      "",
      "2 violations · 0 warnings · 2 files",
      "",
    ].join("\n"),
  );
});

const starterCreated = {
  config: "autofile.yml",
  folders: ["datasets", "assets", "topics"],
};

const initPlain = [
  "Initialized an Autofile vault.",
  "",
  "  autofile.yml",
  "  datasets/",
  "  assets/",
  "  topics/",
  "",
].join("\n");

test("init report renders the spec block exactly, plain", () => {
  assert.equal(renderInitReport(starterCreated, { color: false }), initPlain);
});

test("init report colors created entries green", () => {
  const expected = [
    "Initialized an Autofile vault.",
    "",
    `  ${c.green("autofile.yml")}`,
    `  ${c.green("datasets/")}`,
    `  ${c.green("assets/")}`,
    `  ${c.green("topics/")}`,
    "",
  ].join("\n");
  assert.equal(renderInitReport(starterCreated, { color: true }), expected);
});

test("stripping ANSI from the colored init report equals the plain report", () => {
  assert.equal(strip(renderInitReport(starterCreated, { color: true })), initPlain);
});

// -- Spinner ---------------------------------------------------------------

interface FakeStream {
  isTTY?: boolean;
  writes: string[];
  write(chunk: string): boolean;
}

function fakeStream(isTTY: boolean): FakeStream {
  return {
    isTTY,
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
  };
}

const CLEAR = "\r\x1b[2K";
const frame = (glyph: string, message: string) =>
  `${CLEAR}\x1b[36m${glyph}\x1b[39m \x1b[2m${message}\x1b[22m`;

test("spinner writes nothing before 200 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream);
  spinner.start("Checking…");
  t.mock.timers.tick(199);
  assert.deepEqual(stream.writes, []);
});

test("spinner draws frames in place after the delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream, { delayMs: 200, intervalMs: 80 });
  spinner.start("Checking…");
  t.mock.timers.tick(200);
  assert.deepEqual(stream.writes, [frame("⠋", "Checking…")]);
  t.mock.timers.tick(80);
  t.mock.timers.tick(80);
  assert.deepEqual(stream.writes, [
    frame("⠋", "Checking…"),
    frame("⠙", "Checking…"),
    frame("⠹", "Checking…"),
  ]);
});

test("spinner update shows the new message on the next frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream, { delayMs: 200, intervalMs: 80 });
  spinner.start("Checking… 0 files");
  t.mock.timers.tick(200);
  spinner.update("Checking… 42 files");
  t.mock.timers.tick(80);
  assert.equal(stream.writes.at(-1), frame("⠙", "Checking… 42 files"));
});

test("spinner stop erases the line completely", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream);
  spinner.start("Checking…");
  t.mock.timers.tick(300);
  spinner.stop();
  assert.equal(stream.writes.at(-1), CLEAR);
  const count = stream.writes.length;
  t.mock.timers.tick(1000);
  assert.equal(stream.writes.length, count, "no writes after stop");
});

test("spinner stopped before the delay never writes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream);
  spinner.start("Checking…");
  t.mock.timers.tick(100);
  spinner.stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(stream.writes, []);
});

test("spinner started twice then stopped leaves no timers running", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream, { delayMs: 200, intervalMs: 80 });
  spinner.start("Checking…");
  t.mock.timers.tick(250);
  spinner.start("Checking again…");
  t.mock.timers.tick(250);
  spinner.stop();
  const count = stream.writes.length;
  t.mock.timers.tick(1000);
  assert.equal(stream.writes.length, count, "no writes after stop");
});

test("spinner restart begins a fresh delay with the first frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream, { delayMs: 200, intervalMs: 80 });
  spinner.start("Checking…");
  t.mock.timers.tick(360); // first frame + two ticks, mid-sequence
  spinner.start("Rechecking…");
  assert.equal(stream.writes.at(-1), CLEAR, "restart erases the live line");
  const count = stream.writes.length;
  t.mock.timers.tick(199);
  assert.equal(stream.writes.length, count, "nothing before the fresh delay");
  t.mock.timers.tick(1);
  assert.equal(stream.writes.at(-1), frame("⠋", "Rechecking…"));
});

test("spinner stop without start is a safe no-op", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream);
  spinner.stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(stream.writes, []);
});

test("spinner update before the delay applies to the first frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(true);
  const spinner = new Spinner(stream, { delayMs: 200, intervalMs: 80 });
  spinner.start("Checking…");
  spinner.update("Checking… 42 files");
  t.mock.timers.tick(200);
  assert.deepEqual(stream.writes, [frame("⠋", "Checking… 42 files")]);
});

test("spinner writes nothing at all on a non-TTY stream", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stream = fakeStream(false);
  const spinner = new Spinner(stream);
  spinner.start("Checking…");
  t.mock.timers.tick(1000);
  spinner.update("Checking… 42 files");
  t.mock.timers.tick(1000);
  spinner.stop();
  assert.deepEqual(stream.writes, []);
});
