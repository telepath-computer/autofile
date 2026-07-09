import { homedir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCliArgs } from "../src/cliArgs.js";

describe("CLI argument parsing", () => {
  it("parses repeated vaults plus host and port flags", () => {
    const config = parseCliArgs([
      "--vault",
      "main=/tmp/vault",
      "--vault",
      "work-2=/tmp/work",
      "--host",
      "127.0.0.2",
      "--port",
      "9999"
    ]);

    assert.deepEqual(config, {
      host: "127.0.0.2",
      port: 9999,
      vaults: [
        { name: "main", root: "/tmp/vault" },
        { name: "work-2", root: "/tmp/work" }
      ]
    });
  });

  it("defaults to host 127.0.0.1 and port 8766", () => {
    const config = parseCliArgs(["--vault", "main=/tmp/vault"]);

    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8766);
  });

  it("requires at least one --vault", () => {
    assert.throws(() => parseCliArgs([]), /vault/i);
  });

  it("rejects vault values without name=path syntax", () => {
    assert.throws(() => parseCliArgs(["--vault", "missing-equals"]), /name=path/i);
    assert.throws(() => parseCliArgs(["--vault", "=/tmp/vault"]), /name=path/i);
    assert.throws(() => parseCliArgs(["--vault", "main="]), /name=path/i);
  });

  it("rejects vault names not matching [a-z0-9-]+", () => {
    assert.throws(() => parseCliArgs(["--vault", "Main=/tmp/vault"]), /\[a-z0-9-\]\+/);
    assert.throws(() => parseCliArgs(["--vault", "my vault=/tmp/vault"]), /\[a-z0-9-\]\+/);
    assert.throws(() => parseCliArgs(["--vault", "my_vault=/tmp/vault"]), /\[a-z0-9-\]\+/);
    assert.throws(() => parseCliArgs(["--vault", "a/b=/tmp/vault"]), /\[a-z0-9-\]\+/);
  });

  it("rejects invalid ports and unknown flags", () => {
    assert.throws(() => parseCliArgs(["--vault", "m=/tmp", "--port", "0"]), /port/i);
    assert.throws(() => parseCliArgs(["--vault", "m=/tmp", "--port", "notanumber"]), /port/i);
    assert.throws(() => parseCliArgs(["--vault", "m=/tmp", "--port", "70000"]), /port/i);
    assert.throws(() => parseCliArgs(["--vault", "m=/tmp", "--bad"]), /unknown/i);
    assert.throws(() => parseCliArgs(["--vault"]), /requires a value/i);
    assert.throws(() => parseCliArgs(["--vault", "m=/tmp", "--host", ""]), /host/i);
  });

  it("rejects duplicate vault names", () => {
    assert.throws(
      () => parseCliArgs(["--vault", "main=/tmp/a", "--vault", "main=/tmp/b"]),
      /duplicate/i
    );
  });

  it("expands a leading bare ~ in vault paths to the user's home directory", () => {
    const config = parseCliArgs(["--vault", "home=~"]);
    assert.deepEqual(config.vaults, [{ name: "home", root: homedir() }]);
  });

  it("expands a leading ~/ in vault paths to the user's home directory", () => {
    const config = parseCliArgs(["--vault", "docs=~/Documents/vault"]);
    assert.deepEqual(config.vaults, [
      { name: "docs", root: path.join(homedir(), "Documents/vault") }
    ]);
  });

  it("leaves ~user forms and non-leading tildes untouched", () => {
    const config = parseCliArgs([
      "--vault",
      "a=~someone/files",
      "--vault",
      "b=/tmp/~foo"
    ]);
    assert.deepEqual(config.vaults, [
      { name: "a", root: "~someone/files" },
      { name: "b", root: "/tmp/~foo" }
    ]);
  });
});
