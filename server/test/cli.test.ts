import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

type CliChild = ChildProcessByStdio<null, Readable, Readable>;

const children: CliChild[] = [];

after(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }));
});

function spawnCli(args: string[]): CliChild {
  const child = spawn(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

describe("autofile-server binary", () => {
  it("serves a vault end to end: list, get, put, and read back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autofile-cli-"));
    await mkdir(path.join(root, "tasks"));
    await writeFile(
      path.join(root, "tasks", "from-disk.md"),
      "---\ntitle: From disk\n---\nSeeded record.\n"
    );
    const port = await getAvailablePort();

    const child = spawnCli(["--vault", `main=${root}`, "--host", "127.0.0.1", "--port", String(port)]);
    const baseUrl = await waitForListening(child);

    const listed = await fetch(`${baseUrl}/vaults/main/records/tasks`);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (await listed.json()).records.map((record: { id: string }) => record.id),
      ["tasks/from-disk"]
    );

    const put = await fetch(`${baseUrl}/vaults/main/records/tasks/via-http`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title: "Via HTTP" }, body: "Written over HTTP.\n" })
    });
    assert.equal(put.status, 201);

    const readBack = await fetch(`${baseUrl}/vaults/main/records/tasks/via-http`);
    assert.equal(readBack.status, 200);
    const record = await readBack.json();
    assert.deepEqual(record.properties, { title: "Via HTTP" });
    assert.equal(record.body, "Written over HTTP.\n");
  });

  it("fails startup when a vault path is not a real directory", async () => {
    const child = spawnCli(["--vault", "main=/no/such/dir"]);
    const { code, stderr } = await waitForExit(child);

    assert.notEqual(code, 0);
    assert.match(stderr, /main/);
  });

  it("fails startup when a vault name is invalid", async () => {
    const child = spawnCli(["--vault", "Bad_Name=/tmp"]);
    const { code, stderr } = await waitForExit(child);

    assert.notEqual(code, 0);
    assert.match(stderr, /\[a-z0-9-\]\+/);
  });
});

function waitForListening(child: CliChild): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      const match = data.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}`));
    });
  });
}

function waitForExit(child: CliChild): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
