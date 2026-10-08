#!/usr/bin/env node

/** Serves Autofile over stdio or dispatches its configuration commands. */

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { getStorage, setStorage, unsetStorage } from "./config.js";
import { buildServer } from "./server.js";
import { openStore } from "./store.js";

const usage = `Usage:
  autofile
  autofile set storage <folder>
  autofile get storage
  autofile unset storage
`;
const args = process.argv.slice(2);

try {
  if (args.length === 0) {
    const store = await openStore();
    serveStdio(() => buildServer(store), {
      legacy: "reject",
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 64 * 1024 * 1024,
      }),
    });
  } else if (
    args.length === 3
    && args[0] === "set"
    && args[1] === "storage"
    && args[2] !== ""
  ) {
    await setStorage(args[2]);
  } else if (args.length === 2 && args[0] === "get" && args[1] === "storage") {
    process.stdout.write(`${await getStorage()}\n`);
  } else if (args.length === 2 && args[0] === "unset" && args[1] === "storage") {
    await unsetStorage();
  } else {
    process.stderr.write(usage);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`autofile: ${message.replace(/[\r\n]+/gu, " ")}\n`);
  process.exitCode = 1;
}
