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
  autofile
  autofile serve [--host <host>] [--port <port>]
  autofile set <setting> <value> [<value>...]
  autofile get <setting>
  autofile unset <setting>
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
    await run(["set", "storage", "~/Documents/Autofile"], { autofileHome, home }),
    { stdout: "", stderr: "", code: 0 },
  );
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{\n  "storage": ${JSON.stringify(join(home, "Documents", "Autofile"))}\n}\n`,
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

test("HTTP settings print their defaults", async () => {
  const root = await temp();
  const options = { autofileHome: join(root, "autofile-home"), home: root };

  assert.deepEqual(await run(["get", "http.host"], options), {
    stdout: "127.0.0.1\n",
    stderr: "",
    code: 0,
  });
  assert.deepEqual(await run(["get", "http.port"], options), {
    stdout: "7319\n",
    stderr: "",
    code: 0,
  });
  assert.deepEqual(await run(["get", "http.origins"], options), {
    stdout: "",
    stderr: "",
    code: 0,
  });
});

test("every setting completes a set, get, unset, and default lifecycle", async () => {
  const root = await temp();
  const cases = [
    {
      setting: "storage",
      values: [join(root, "records")],
      configured: `${join(root, "records")}\n`,
      defaultValue: (autofileHome: string) => `${join(autofileHome, "data")}\n`,
    },
    {
      setting: "http.host",
      values: ["0.0.0.0"],
      configured: "0.0.0.0\n",
      defaultValue: () => "127.0.0.1\n",
    },
    {
      setting: "http.port",
      values: ["8080"],
      configured: "8080\n",
      defaultValue: () => "7319\n",
    },
    {
      setting: "http.origins",
      values: ["https://app.example", "http://app.example.com:8080"],
      configured: "https://app.example\nhttp://app.example.com:8080\n",
      defaultValue: () => "",
    },
  ];

  await Promise.all(cases.map(async ({
    setting,
    values,
    configured,
    defaultValue,
  }, index) => {
    const autofileHome = join(root, `autofile-home-${String(index)}`);
    const options = { autofileHome, home: root };
    assert.deepEqual(await run(["set", setting, ...values], options), {
      stdout: "",
      stderr: "",
      code: 0,
    });
    assert.deepEqual(await run(["get", setting], options), {
      stdout: configured,
      stderr: "",
      code: 0,
    });
    assert.deepEqual(await run(["unset", setting], options), {
      stdout: "",
      stderr: "",
      code: 0,
    });
    assert.deepEqual(await run(["get", setting], options), {
      stdout: defaultValue(autofileHome),
      stderr: "",
      code: 0,
    });
    assert.deepEqual(await run(["unset", setting], options), {
      stdout: "",
      stderr: "",
      code: 0,
    });
  }));
});

test("set preserves sibling settings and writes the nested HTTP settings", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const options = { autofileHome, home: root };
  const storage = join(root, "records");

  for (const args of [
    ["set", "http.host", "0.0.0.0"],
    ["set", "http.port", "8080"],
    ["set", "http.origins", "https://example.com", "http://app.example.com:8080"],
    ["set", "storage", storage],
  ]) {
    assert.deepEqual(await run(args, options), { stdout: "", stderr: "", code: 0 });
  }

  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `${JSON.stringify({
      storage,
      http: {
        host: "0.0.0.0",
        port: 8080,
        origins: ["https://example.com", "http://app.example.com:8080"],
      },
    }, null, 2)}\n`,
  );
  assert.deepEqual(await run(["get", "http.origins"], options), {
    stdout: "https://example.com\nhttp://app.example.com:8080\n",
    stderr: "",
    code: 0,
  });
});

test("set and get normalize HTTP origins", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const options = { autofileHome, home: root };

  assert.deepEqual(
    await run([
      "set",
      "http.origins",
      "HTTPS://Example.COM:443",
      "http://[0:0:0:0:0:0:0:1]:80",
    ], options),
    { stdout: "", stderr: "", code: 0 },
  );
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{
  "http": {
    "origins": [
      "https://example.com",
      "http://[::1]"
    ]
  }
}\n`,
  );
  assert.deepEqual(await run(["get", "http.origins"], options), {
    stdout: "https://example.com\nhttp://[::1]\n",
    stderr: "",
    code: 0,
  });
});

test("get normalizes HTTP origins read from config", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  await mkdir(autofileHome);
  await writeFile(
    join(autofileHome, "config.json"),
    `{ "http": { "origins": ["HTTP://LOCALHOST:80"] } }\n`,
  );

  assert.deepEqual(await run(["get", "http.origins"], { autofileHome, home: root }), {
    stdout: "http://localhost\n",
    stderr: "",
    code: 0,
  });
});

test("unset removes one setting, preserves its siblings, and prunes an empty HTTP object", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const options = { autofileHome, home: root };
  await mkdir(autofileHome);
  await writeFile(
    join(autofileHome, "config.json"),
    `${JSON.stringify({ http: { host: "0.0.0.0", port: 8080 } }, null, 2)}\n`,
  );

  assert.deepEqual(await run(["unset", "http.host"], options), {
    stdout: "",
    stderr: "",
    code: 0,
  });
  assert.equal(
    await readFile(join(autofileHome, "config.json"), "utf8"),
    `{
  "http": {
    "port": 8080
  }
}\n`,
  );
  assert.deepEqual(await run(["unset", "http.port"], options), {
    stdout: "",
    stderr: "",
    code: 0,
  });
  assert.equal(await readFile(join(autofileHome, "config.json"), "utf8"), "{}\n");
});

for (const port of ["0", "65536", "1.5", "12x", "+12"]) {
  test(`set http.port refuses ${JSON.stringify(port)}`, async () => {
    const root = await temp();
    assert.deepEqual(
      await run(["set", "http.port", port], {
        autofileHome: join(root, "autofile-home"),
        home: root,
      }),
      {
        stdout: "",
        stderr: "autofile: http.port must be an integer from 1 to 65535\n",
        code: 1,
      },
    );
  });
}

for (const origin of [
  "example.com",
  "ftp://example.com",
  "https://example.com/path",
  "https://example.com?query",
  "https://user@example.com",
  "https://example.com/",
  "https://example.com\\path",
  "https://example.com:",
]) {
  test(`set http.origins refuses ${JSON.stringify(origin)}`, async () => {
    const root = await temp();
    assert.deepEqual(
      await run(["set", "http.origins", origin], {
        autofileHome: join(root, "autofile-home"),
        home: root,
      }),
      {
        stdout: "",
        stderr: "autofile: http.origins must contain only http or https origins without paths\n",
        code: 1,
      },
    );
  });
}

for (const [setting, message] of [
  ["storage", "storage must be a non-empty folder"],
  ["http.host", "http.host must be a non-empty string"],
  ["http.port", "http.port must be an integer from 1 to 65535"],
] as const) {
  test(`set ${setting} delegates an empty value to setting validation`, async () => {
    const root = await temp();
    assert.deepEqual(
      await run(["set", setting, ""], {
        autofileHome: join(root, "autofile-home"),
        home: root,
      }),
      { stdout: "", stderr: `autofile: ${message}\n`, code: 1 },
    );
  });
}

test("invalid stored HTTP settings report the config path", async () => {
  const root = await temp();
  const autofileHome = join(root, "autofile-home");
  const configPath = join(autofileHome, "config.json");
  await mkdir(autofileHome);
  await writeFile(configPath, `{ "http": { "port": 0 } }\n`);

  assert.deepEqual(await run(["get", "http.port"], { autofileHome, home: root }), {
    stdout: "",
    stderr: `autofile: ${configPath}: http.port must be an integer from 1 to 65535\n`,
    code: 1,
  });
});

test("all invalid stored config shapes are refused through the command", async () => {
  const root = await temp();
  const cases: Array<[unknown, string]> = [
    [[], "must contain a JSON object"],
    [{ http: [] }, "http must be a JSON object"],
    [{ http: { host: "" } }, "http.host must be a non-empty string"],
    [
      { http: { origins: ["ftp://example.com"] } },
      "http.origins must contain only http or https origins without paths",
    ],
  ];

  await Promise.all(cases.map(async ([config, message], index) => {
    const autofileHome = join(root, `invalid-config-${String(index)}`);
    const configPath = join(autofileHome, "config.json");
    await mkdir(autofileHome);
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    assert.deepEqual(await run(["get", "storage"], { autofileHome, home: root }), {
      stdout: "",
      stderr: `autofile: ${configPath}: ${message}\n`,
      code: 1,
    });
  }));
});

test("serve refuses an invalid port override with one line", async () => {
  const root = await temp();
  assert.deepEqual(
    await run(["serve", "--port", "0"], {
      autofileHome: join(root, "autofile-home"),
      home: root,
    }),
    {
      stdout: "",
      stderr: "autofile: http.port must be an integer from 1 to 65535\n",
      code: 1,
    },
  );
});

const invalidCommands: Array<[string, string[]]> = [
  ["an unknown command", ["unknown"]],
  ["serve with a missing option value", ["serve", "--host"]],
  ["serve with an unknown option", ["serve", "--other", "value"]],
  ["serve with a repeated option", ["serve", "--port", "7319", "--port", "7320"]],
  ["set without a setting", ["set"]],
  ["set without a folder", ["set", "storage"]],
  ["set with another setting", ["set", "other", "folder"]],
  ["set with an extra argument", ["set", "storage", "folder", "extra"]],
  ["set origins without a value", ["set", "http.origins"]],
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
