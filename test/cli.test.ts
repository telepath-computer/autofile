/** Exercises the built command through its process, filesystem, and stream boundaries. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const cli = resolve("dist/cli.js");
const roots: string[] = [];
const usage = `Usage:
  autofile set storage <folder>
  autofile get storage
  autofile unset storage
`;

interface RunOptions {
  autofileHome?: string;
  cwd?: string;
  home: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[], options: RunOptions): Promise<RunResult> {
  // This managed test environment discards nested child-process pipes, so
  // capture through ordinary files. The CLI still sees non-TTY streams and
  // the byte assertions remain exact.
  const capture = await mkdtemp(join(tmpdir(), "autofile-cli-capture-"));
  roots.push(capture);
  const stdoutPath = join(capture, "stdout");
  const stderrPath = join(capture, "stderr");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const env: NodeJS.ProcessEnv = {
    HOME: options.home,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  if (options.autofileHome !== undefined) env.AUTOFILE_HOME = options.autofileHome;

  const code = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
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

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-cli-"));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("get storage prints the default data folder", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");

  assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
    stdout: `${join(autofileHome, "data")}\n`,
    stderr: "",
    code: 0,
  });
});

test("the default Autofile folder is ~/.autofile", async () => {
  const home = await temp();

  assert.deepEqual(await run(["get", "storage"], { home }), {
    stdout: `${join(home, ".autofile", "data")}\n`,
    stderr: "",
    code: 0,
  });
});

test("invalid config JSON reports its path without a stack trace", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const configPath = join(autofileHome, "config.json");
  await mkdir(autofileHome);
  await writeFile(configPath, "{\n");

  assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
    stdout: "",
    stderr: `autofile: ${configPath}: invalid JSON\n`,
    code: 1,
  });
});

test("a non-string storage setting reports its config path without a stack trace", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const configPath = join(autofileHome, "config.json");
  await mkdir(autofileHome);
  await writeFile(configPath, "{\n  \"storage\": 42\n}\n");

  assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
    stdout: "",
    stderr: `autofile: ${configPath}: storage must be a string\n`,
    code: 1,
  });
});

test("set storage creates the Autofile folder and writes an absolute path exactly", async () => {
  const root = await temp();
  const autofileHome = join(root, "missing", "autofile-home");
  const storage = join(root, "missing", "records");

  assert.deepEqual(await run(["set", "storage", storage], { autofileHome, home: root }), {
    stdout: "",
    stderr: "",
    code: 0,
  });
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{\n  "storage": ${JSON.stringify(storage)}\n}\n`,
  );
  await assert.rejects(stat(storage));
  assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
    stdout: `${storage}\n`,
    stderr: "",
    code: 0,
  });
});

test("set storage resolves a relative folder against the current directory", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const workingDirectory = join(root, "working");
  await mkdir(workingDirectory);

  assert.deepEqual(
    await run(["set", "storage", "records"], {
      autofileHome,
      cwd: workingDirectory,
      home: root,
    }),
    { stdout: "", stderr: "", code: 0 },
  );
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{\n  "storage": ${JSON.stringify(join(workingDirectory, "records"))}\n}\n`,
  );
});

test("set storage expands a leading tilde to the home directory", async () => {
  const root = await temp();
  const home = join(root, "person");
  const autofileHome = join(root, "autofile-home");

  assert.deepEqual(
    await run(["set", "storage", "~/Dropbox/Autofile"], { autofileHome, home }),
    { stdout: "", stderr: "", code: 0 },
  );
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{\n  "storage": ${JSON.stringify(join(home, "Dropbox", "Autofile"))}\n}\n`,
  );
});

test("set storage moves no files", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const defaultData = join(autofileHome, "data");
  const storage = join(root, "new-data");
  await mkdir(defaultData, { recursive: true });
  await writeFile(join(defaultData, "kept.txt"), "kept\n");

  assert.equal((await run(["set", "storage", storage], { autofileHome, home: root })).code, 0);
  assert.equal(await readFile(join(defaultData, "kept.txt"), "utf8"), "kept\n");
  await assert.rejects(stat(storage));
});

test("unset storage removes the setting and restores the default", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const storage = join(root, "records");
  assert.equal((await run(["set", "storage", storage], { autofileHome, home: root })).code, 0);

  assert.deepEqual(await run(["unset", "storage"], { autofileHome, home: root }), {
    stdout: "",
    stderr: "",
    code: 0,
  });
  assert.equal(await readFile(join(autofileHome, "config.json"), "utf8"), "{}\n");
  assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
    stdout: `${join(autofileHome, "data")}\n`,
    stderr: "",
    code: 0,
  });
});

const invalidCommands: Array<[string, string[]]> = [
  ["no arguments", []],
  ["an unknown command", ["unknown"]],
  ["set without a setting", ["set"]],
  ["set without a folder", ["set", "storage"]],
  ["set with an empty folder", ["set", "storage", ""]],
  ["set with another setting", ["set", "other", "folder"]],
  ["set with an extra argument", ["set", "storage", "folder", "extra"]],
  ["get without a setting", ["get"]],
  ["get with another setting", ["get", "other"]],
  ["get with an extra argument", ["get", "storage", "extra"]],
  ["unset without a setting", ["unset"]],
  ["unset with another setting", ["unset", "other"]],
  ["unset with an extra argument", ["unset", "storage", "extra"]],
];

for (const [name, args] of invalidCommands) {
  test(`${name} prints usage to stderr and fails`, async () => {
    const root = await temp();
    assert.deepEqual(await run(args, { autofileHome: join(root, "autofile-home"), home: root }), {
      stdout: "",
      stderr: usage,
      code: 1,
    });
  });
}
