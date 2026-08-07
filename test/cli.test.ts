import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { starterConfig } from "@telepath-computer/autofile";

// Golden end-to-end tests: the built binary, spawned as a subprocess with
// piped output — so every expectation is exact bytes, with no spinner and
// no styling (spec/cli.md "Output"). TTY-only presentation — color, the
// spinner — is unit-tested in output.test.ts.

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const fixtureVault = fileURLToPath(new URL("../../test/fixtures/vault", import.meta.url));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

// Children run without NODE_OPTIONS — an inherited --inspect or loader
// would pollute the golden bytes — and die after 30 s rather than hang.
const env = { ...process.env };
delete env.NODE_OPTIONS;

function run(args: string[], cwd?: string): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      done({ stdout, stderr, code });
    });
  });
}

/**
 * Runs the CLI with the parent's read end of stdout destroyed at once —
 * the shape of `autofile check | head -1` after head exits — so the
 * report write hits EPIPE.
 */
function runWithClosedStdout(args: string[], cwd?: string): Promise<{ stderr: string; code: number }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000 });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => done({ stderr, code: code ?? 1 }));
  });
}

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tmpVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-cli-"));
  roots.push(root);
  return root;
}

// spec/cli.md: usage is the synopsis with a one-line description per
// command; `[path]` defaults to the current directory.
const usage = [
  "Usage:",
  "  autofile init [path]   Create a vault: the starter autofile.yml and its folders",
  "  autofile check [path]  Check the vault and report findings",
  "",
  "[path] defaults to the current directory.",
  "",
].join("\n");

// spec/cli.md "init output", verbatim: what was created, folders with a
// trailing slash.
const initReport = [
  "Initialized an Autofile vault.",
  "",
  "  autofile.yml",
  "  datasets/",
  "  assets/",
  "  topics/",
  "",
].join("\n");

// The fixture vault's full report: a stray root file is both an asset
// violation (global forbids assets) and a root violation; the undeclared
// folder violates root; the reference to the ignored dotfile is not
// dangling, because ignored files exist (spec/cli.md).
const fixtureReport = [
  "✗ contacts/no-name.md         schema: name is required",
  "✗ contacts/photo.jpg          asset: not a record, in a path that forbids assets",
  "✗ drafts                      root: undeclared folder at the vault root; the root holds only autofile.yml and the declared folders",
  "✗ readme.txt                  asset: not a record, in a path that forbids assets",
  "✗ readme.txt                  root: loose file at the vault root; the root holds only autofile.yml and the declared folders",
  "! journal                     empty: declared folder is missing",
  "! notes/projects/nautilus.md  reference: [[contacts/mira-holt]] does not exist",
  "",
  "5 violations · 2 warnings · 8 files",
  "",
].join("\n");

// A fresh starter vault: three declared folders, all empty — three
// warnings, no violations, exit 0 (warnings do not change the exit code).
const freshReport = [
  "! assets    empty: declared folder is empty",
  "! datasets  empty: declared folder is empty",
  "! topics    empty: declared folder is empty",
  "",
  "0 violations · 3 warnings · 0 files",
  "",
].join("\n");

const brokenReport = [
  "✗ stray.txt            asset: not a record, in a path that forbids assets",
  "✗ stray.txt            root: loose file at the vault root; the root holds only autofile.yml and the declared folders",
  "✗ topics/bad-topic.md  schema: description is required",
  "! assets               empty: declared folder is empty",
  "! datasets             empty: declared folder is empty",
  "! topics/linked.md     reference: [[topics/missing-note]] does not exist",
  "",
  "3 violations · 3 warnings · 3 files",
  "",
].join("\n");

const fixedReport = [
  "! assets    empty: declared folder is empty",
  "! datasets  empty: declared folder is empty",
  "",
  "0 violations · 2 warnings · 3 files",
  "",
].join("\n");

test("check over the fixture vault prints the golden report and exits 1", async () => {
  const result = await run(["check", fixtureVault]);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, fixtureReport);
  assert.equal(result.code, 1);
  // Piped output is plain text: no ANSI styling, no spinner residue.
  assert.doesNotMatch(result.stdout, /[\r\x1b]/);
});

test("check output is byte-identical across runs", async () => {
  const first = await run(["check", fixtureVault]);
  const second = await run(["check", fixtureVault]);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.code, 1);
  assert.equal(second.code, 1);
});

test("init, check, refuse, break, fix: the vault lifecycle", async () => {
  const root = await tmpVault();

  // init into the current directory: the starter config and its folders.
  let result = await run(["init"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, initReport);
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(root, "autofile.yml"), "utf8"), starterConfig);

  // A fresh vault checks clean: warnings only, exit 0.
  result = await run(["check"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, freshReport);
  assert.equal(result.code, 0);

  // Re-init refuses: one line to stderr, non-zero, vault untouched.
  result = await run(["init"], root);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "autofile.yml already exists; init never overwrites.\n");
  assert.equal(result.code, 1);
  assert.equal(await readFile(join(root, "autofile.yml"), "utf8"), starterConfig);
  for (const folder of ["datasets", "assets", "topics"]) {
    assert.ok((await stat(join(root, folder))).isDirectory(), `expected ${folder}/ to remain`);
  }

  // Break the vault three ways: a stray root file, a schema-violating
  // record, a dangling reference.
  await writeFile(join(root, "stray.txt"), "loose\n");
  await writeFile(join(root, "topics/bad-topic.md"), "---\ntitle: Only a title\n---\n");
  await writeFile(
    join(root, "topics/linked.md"),
    "---\ntitle: Linked\ndescription: Points at a missing note.\n---\n\nSee [[topics/missing-note]].\n",
  );
  result = await run(["check"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, brokenReport);
  assert.equal(result.code, 1);

  // Fix all three; the check passes again.
  await unlink(join(root, "stray.txt"));
  await writeFile(
    join(root, "topics/bad-topic.md"),
    "---\ntitle: Bad topic, repaired\ndescription: Now complete.\n---\n",
  );
  await writeFile(
    join(root, "topics/missing-note.md"),
    "---\ntitle: Missing note\ndescription: Now it exists.\n---\n",
  );
  result = await run(["check"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, fixedReport);
  assert.equal(result.code, 0);
});

test("init [path] creates the vault folder itself", async () => {
  const root = await tmpVault();
  const result = await run(["init", "nested/vault"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, initReport);
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(root, "nested/vault/autofile.yml"), "utf8"), starterConfig);
});

test("--help prints usage to stdout and exits 0", async () => {
  const result = await run(["--help"]);
  assert.equal(result.stdout, usage);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

// A lone --help after a known command is still a request for help, not a
// mistake: the same usage, but to stdout with exit 0.
test("check --help prints usage to stdout and exits 0", async () => {
  const result = await run(["check", "--help"]);
  assert.equal(result.stdout, usage);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

test("init --help prints usage to stdout and exits 0", async () => {
  const result = await run(["init", "--help"]);
  assert.equal(result.stdout, usage);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

test("--version prints the package version and exits 0", async () => {
  const packageJson = new URL("../../package.json", import.meta.url);
  const { version } = JSON.parse(await readFile(packageJson, "utf8")) as { version: string };
  const result = await run(["--version"]);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

// No or unknown arguments show the same usage, but on stderr with exit 1:
// an error path, distinguishable from --help in a script.
test("no arguments prints usage to stderr and exits 1", async () => {
  const result = await run([]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, usage);
  assert.equal(result.code, 1);
});

test("an unknown command prints usage to stderr and exits 1", async () => {
  const result = await run(["frobnicate"]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, usage);
  assert.equal(result.code, 1);
});

test("an unknown flag after a command prints usage to stderr and exits 1", async () => {
  const result = await run(["check", "--verbose"]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, usage);
  assert.equal(result.code, 1);
});

// A consumer that stops reading early (`autofile check | head -1`) must
// not crash the run: EPIPE is swallowed and the exit code is the one the
// check earned — no error dump on stderr.
test("check into a closed pipe keeps the earned exit 1 for a violating vault", async () => {
  const result = await runWithClosedStdout(["check", fixtureVault]);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 1);
});

test("check into a closed pipe keeps the earned exit 0 for a clean vault", async () => {
  const root = await tmpVault();
  await run(["init"], root);
  const result = await runWithClosedStdout(["check"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

// A missing config is vault content — a `config` finding on stdout — not
// an environment error (spec/cli.md).
test("a missing autofile.yml is a config finding on stdout", async () => {
  const root = await tmpVault();
  const expected = [
    `✗ config: autofile.yml cannot be read: ENOENT: no such file or directory, open '${join(root, "autofile.yml")}'`,
    "",
    "1 violation · 0 warnings · 0 files",
    "",
  ].join("\n");
  const result = await run(["check"], root);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, expected);
  assert.equal(result.code, 1);
});

// The engine's environment errors — an unreadable directory, thrown from
// the walk — reach stderr, non-zero, with nothing on stdout. Root ignores
// directory permissions, so this can only run unprivileged.
test(
  "an unreadable directory inside the vault is an error on stderr",
  { skip: process.getuid?.() === 0 },
  async () => {
    const root = await tmpVault();
    await run(["init"], root);
    await chmod(join(root, "topics"), 0o000);
    try {
      const result = await run(["check"], root);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^cannot read directory ".+": .+\n$/);
      assert.equal(result.code, 1);
    } finally {
      await chmod(join(root, "topics"), 0o755);
    }
  },
);
