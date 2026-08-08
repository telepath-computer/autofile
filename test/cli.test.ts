import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { starterConfig } from "../dist/starter.js";

const cli = resolve("dist/cli.js");
const fixture = resolve("test/fixtures/vault");
const golden = resolve("test/fixtures/expected-report.txt");
// Nothing ambient (loaders, color controls, locale, or inspect flags) may
// influence subprocess bytes.
const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", TZ: "UTC" };
interface Run { stdout: string; stderr: string; code: number }
function run(args: string[], cwd?: string): Promise<Run> {
  return new Promise((done) => execFile(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000, encoding: "buffer" }, (error, stdout, stderr) => {
    // Capture bytes first. The lossless round-trip makes the exact string
    // expectations below exact UTF-8 byte expectations, not decoded samples.
    assert.deepEqual(Buffer.from(stdout.toString("utf8")), stdout);
    assert.deepEqual(Buffer.from(stderr.toString("utf8")), stderr);
    done({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code: error === null ? 0 : typeof error.code === "number" ? error.code : 1 });
  }));
}
const roots: string[] = []; after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "autofile-cli-")); roots.push(root); return root; }
const usage = "Usage: autofile <command> [path]\n\nPredictable filing for agents — initialize and check Autofile vaults.\n\n  init         create an empty Autofile configuration\n  check        validate the vault and report findings\n  path         vault folder (default: current directory)\n  --help       show this help\n  --version    print the version\n";
const initReport = "Initialized an Autofile vault.\n\n  autofile.yml\n";

test("headline: init then check a realistic ungoverned Obsidian vault", async () => {
  const root = await temp();
  await mkdir(join(root, ".obsidian")); await mkdir(join(root, "Templates")); await mkdir(join(root, "People and Places"));
  await writeFile(join(root, ".obsidian", "workspace.json"), "{}\n");
  await writeFile(join(root, "Templates", "Meeting.md"), "# {{title}}\n[[Missing bare slug]]\n");
  await writeFile(join(root, "People and Places", `Cafe\u0301.md`), "[[Meeting]]\n");
  let result = await run(["init"], root); assert.deepEqual(result, { stdout: initReport, stderr: "", code: 0 });
  result = await run(["check"], root); assert.deepEqual(result, { stdout: "✓ 0 files\n", stderr: "", code: 0 });
});

test("headline: strict adoption ignores Obsidian metadata while checking declared content", async () => {
  const root = await temp();
  await mkdir(join(root, ".obsidian")); await mkdir(join(root, "notes"));
  await writeFile(join(root, ".obsidian", "workspace.json"), "{}\n");
  await writeFile(join(root, "notes", "kept.md"), "# Kept\n");
  await writeFile(join(root, "autofile.yml"), "strict: true\npaths:\n  /notes:\n    description: Notes.\n");
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 1 file\n", stderr: "", code: 0 });
});

test("full init, refusal, break, repair lifecycle", async () => {
  const root = await temp(); let result = await run(["init"], root);
  assert.deepEqual(result, { stdout: initReport, stderr: "", code: 0 });
  assert.equal(await readFile(join(root, "autofile.yml"), "utf8"), starterConfig);
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 0 files\n", stderr: "", code: 0 });
  const untouched = await readFile(join(root, "autofile.yml")); result = await run(["init"], root);
  assert.deepEqual(result, { stdout: "", stderr: "autofile.yml already exists; init never overwrites.\n", code: 1 });
  assert.deepEqual(await readFile(join(root, "autofile.yml")), untouched);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "autofile.yml"), "paths:\n  /notes:\n    description: Notes.\n    extensions: [md]\n    schema:\n      type: object\n      required: [title]\n      properties:\n        title: { type: string }\n");
  await writeFile(join(root, "notes", "bad.md"), "---\ntitle: 7\n---\n\nSee [[missing]].\n");
  await writeFile(join(root, "notes", "attachment.txt"), "wrong extension\n");
  const broken = "✗ notes/attachment.txt  extensions: .txt is not among the extensions this path holds\n✗ notes/bad.md          schema: title must be a string\n! notes/bad.md          internal_links.resolve: [[missing]] does not exist\n\n2 violations · 1 warning · 2 files\n";
  assert.deepEqual(await run(["check"], root), { stdout: broken, stderr: "", code: 1 });
  await rm(join(root, "notes", "attachment.txt")); await writeFile(join(root, "notes", "bad.md"), "---\ntitle: Repaired\n---\n\nSee [[missing]].\n"); await writeFile(join(root, "notes", "missing.md"), "---\ntitle: Found\n---\n");
  assert.deepEqual(await run(["check"], root), { stdout: "✓ 2 files\n", stderr: "", code: 0 });
});

test("committed golden fixture is exact and deterministic", async () => {
  const expected = await readFile(golden, "utf8"); const first = await run(["check", fixture]); const second = await run(["check", fixture]);
  assert.deepEqual(first, { stdout: expected, stderr: "", code: 1 }); assert.deepEqual(second, first); assert.doesNotMatch(first.stdout, /[\x1b\r]/u);
});

test("help, version, empty argv, and unknown argv have exact streams", async () => {
  assert.deepEqual(await run(["--help"]), { stdout: usage, stderr: "", code: 0 });
  assert.deepEqual(await run([]), { stdout: "", stderr: usage, code: 1 }); assert.deepEqual(await run(["unknown"]), { stdout: "", stderr: usage, code: 1 });
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  assert.deepEqual(await run(["--version"]), { stdout: `${pkg.version}\n`, stderr: "", code: 0 });
});

test("missing config stops on stderr, and init does not create its path", async () => {
  const root = await temp(); assert.deepEqual(await run(["check"], root), { stdout: "", stderr: "autofile.yml not found; this folder is not an Autofile vault.\n", code: 1 });
  const result = await run(["init", "absent/vault"], root); assert.equal(result.stdout, ""); assert.equal(result.code, 1); assert.match(result.stderr, /^ENOENT: .+\n$/u);
  await assert.rejects(stat(join(root, "absent")));
});

test("large report survives an early-closing stdout consumer with earned exit", async () => {
  const root = await temp(); await mkdir(join(root, "notes")); await writeFile(join(root, "autofile.yml"), "paths:\n  /notes:\n    description: Notes.\n    extensions: [md]\n");
  await Promise.all(Array.from({ length: 2500 }, (_, i) => writeFile(join(root, "notes", `${i}.txt`), "x")));
  const result = await new Promise<{ code: number; stderr: string }>((done) => { const child = spawn(process.execPath, [cli, "check"], { cwd: root, env }); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (x: string) => stderr += x); child.stdout.once("data", () => child.stdout.destroy()); child.on("close", (code) => done({ code: code ?? -1, stderr })); });
  assert.deepEqual(result, { code: 1, stderr: "" });
});
