import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { parseConfig } from "../dist/config.js";
import { starterConfig } from "../dist/starter.js";

const cli = resolve("dist/cli.js");
const fixture = resolve("test/fixtures/vault");
const golden = resolve("test/fixtures/expected-report.txt");
const initSpec = resolve("spec/init.yml");
const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", TZ: "UTC" };

interface Run { stdout: string; stderr: string; code: number }

async function run(args: string[], cwd?: string): Promise<Run> {
  // This managed test environment discards nested child-process pipes, so
  // capture through ordinary files. The CLI still sees non-TTY streams and
  // the byte assertions remain exact.
  const capture = await mkdtemp(join(tmpdir(), "autofile-cli-capture-"));
  roots.push(capture);
  const stdoutPath = join(capture, "stdout");
  const stderrPath = join(capture, "stderr");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const code = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      done(exitCode ?? 1);
    });
  });
  await Promise.all([stdoutFile.close(), stderrFile.close()]);
  const [stdout, stderr] = await Promise.all([readFile(stdoutPath), readFile(stderrPath)]);
  assert.deepEqual(Buffer.from(stdout.toString("utf8")), stdout);
  assert.deepEqual(Buffer.from(stderr.toString("utf8")), stderr);
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code };
}

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-cli-"));
  roots.push(root);
  return root;
}

const usage = "Usage: autofile <command> [path]\n\nPredictable filing for agents — initialize and check Autofile vaults.\n\n  init         create an empty Autofile configuration\n  check        validate the vault and report findings\n  path         vault folder (default: current directory)\n  --help       show this help\n  --version    print the version\n";
const initReport = "Initialized an Autofile vault.\n\n  autofile.yml\n";

test("init writes spec/init.yml byte-for-byte and a fresh vault checks clean", async () => {
  const root = await temp();
  assert.deepEqual(await run(["init"], root), { stdout: initReport, stderr: "", code: 0 });
  const normative = await readFile(initSpec, "utf8");
  assert.equal(starterConfig, normative);
  assert.equal(await readFile(join(root, "autofile.yml"), "utf8"), normative);
  const parsed = parseConfig(starterConfig);
  assert.ok(parsed.ok);
  assert.equal(parsed.config.version, 1);
  assert.equal(parsed.config.strict, false);
  assert.equal(parsed.config.linkFormat, "wikilink");
  assert.equal(parsed.config.filenamePattern, undefined);
  assert.deepEqual(parsed.config.folders, []);
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 0 files\n", stderr: "", code: 0 });
});

test("init among existing files makes no claims and checks clean", async () => {
  const root = await temp();
  await writeFile(join(root, "loose.txt"), "existing\n");
  await mkdir(join(root, ".obsidian"));
  await writeFile(join(root, ".obsidian", "workspace.json"), "{}\n");
  assert.equal((await run(["init"], root)).code, 0);
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 0 files\n", stderr: "", code: 0 });
});

test("init refuses to overwrite and leaves the existing config byte-identical", async () => {
  const root = await temp();
  await writeFile(join(root, "autofile.yml"), "version: 1\n");
  const before = await readFile(join(root, "autofile.yml"));
  assert.deepEqual(await run(["init"], root), {
    stdout: "",
    stderr: "autofile.yml already exists; init never overwrites.\n",
    code: 1,
  });
  assert.deepEqual(await readFile(join(root, "autofile.yml")), before);
});

test("check reports folder rules, counts governed and strict-coverage files, and warnings do not affect exit status", async () => {
  const root = await temp();
  await mkdir(join(root, "contacts"));
  await writeFile(join(root, "autofile.yml"), `version: 1
strict: true
folders:
  - path: contacts
    description: Contacts.
    extensions: [md]
    schema:
      type: object
      required: [title]
      properties:
        title: { type: string }
`);
  await writeFile(join(root, "contacts", "bad.md"), "---\ntitle: 7\nfriend: '[[contacts/missing]]'\n---\n[Missing](missing)\n");
  await writeFile(join(root, "contacts", "attachment.txt"), "wrong extension\n");
  await writeFile(join(root, "outside.txt"), "strict coverage\n");
  assert.deepEqual(await run(["check"], root), {
    stdout: "✗ contacts/attachment.txt  extensions: txt is not among the extensions this folder accepts\n✗ contacts/bad.md          link_format: [Missing](missing) must use wikilink format\n✗ contacts/bad.md          schema: title must be a string\n✗ outside.txt              coverage: no folder entry accounts for this file\n! contacts/bad.md          resolve: [Missing](missing) does not exist\n! contacts/bad.md          resolve: [[contacts/missing]] does not exist\n\n4 violations · 2 warnings · 3 files\n",
    stderr: "",
    code: 1,
  });

  await rm(join(root, "contacts", "attachment.txt"));
  await rm(join(root, "outside.txt"));
  await writeFile(join(root, "contacts", "missing.md"), "---\ntitle: Found\n---\n");
  await writeFile(join(root, "contacts", "bad.md"), "---\ntitle: Repaired\nfriend: '[[contacts/missing]]'\n---\n[[contacts/missing]]\n");
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 2 files\n", stderr: "", code: 0 });
});

test("a config finding names a folder entry by its path", async () => {
  const root = await temp();
  await writeFile(join(root, "autofile.yml"), "version: 1\nfolders:\n  - path: contacts\n    shema: {}\n");
  assert.deepEqual(await run(["check"], root), {
    stdout: "✗ autofile.yml  config: folders contacts has an unknown key \"shema\"\n\n1 violation · 0 files\n",
    stderr: "",
    code: 1,
  });
});

test("the committed golden fixture is exact and deterministic", async () => {
  const expected = await readFile(golden, "utf8");
  const first = await run(["check", fixture]);
  const second = await run(["check", fixture]);
  assert.deepEqual(first, { stdout: expected, stderr: "", code: 1 });
  assert.deepEqual(second, first);
  assert.doesNotMatch(first.stdout, /[\x1b\r]/u);
});

test("help, version, empty argv, and unknown argv use exact streams", async () => {
  assert.deepEqual(await run(["--help"]), { stdout: usage, stderr: "", code: 0 });
  assert.deepEqual(await run([]), { stdout: "", stderr: usage, code: 1 });
  assert.deepEqual(await run(["unknown"]), { stdout: "", stderr: usage, code: 1 });
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  assert.deepEqual(await run(["--version"]), { stdout: `${pkg.version}\n`, stderr: "", code: 0 });
});

test("missing config stops on stderr, and init does not create its path", async () => {
  const root = await temp();
  assert.deepEqual(await run(["check"], root), {
    stdout: "",
    stderr: "autofile.yml not found; this folder is not an Autofile vault.\n",
    code: 1,
  });
  const result = await run(["init", "absent/vault"], root);
  assert.equal(result.stdout, "");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^ENOENT: .+\n$/u);
  await assert.rejects(stat(join(root, "absent")));
});

test("large reports survive an early-closing stdout consumer", async () => {
  const root = await temp();
  await writeFile(join(root, "autofile.yml"), "version: 1\nstrict: true\n");
  await Promise.all(Array.from({ length: 2500 }, (_, index) => writeFile(join(root, `${index}.txt`), "x")));
  const result = await new Promise<{ code: number; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, "check"], { cwd: root, env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("close", (code) => done({ code: code ?? -1, stderr }));
  });
  assert.deepEqual(result, { code: 1, stderr: "" });
});
