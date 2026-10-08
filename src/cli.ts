#!/usr/bin/env node

/** Serves Autofile over stdio or HTTP and dispatches its settings commands. */

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  getSetting,
  getSettings,
  isSettingName,
  parsePort,
  setSetting,
  unsetSetting,
} from "./config.js";
import { startHttpServer } from "./http.js";
import { buildServer } from "./server.js";
import { openStore } from "./store.js";

const usage = `Usage:
  autofile
  autofile serve [--host <host>] [--port <port>]
  autofile set <setting> <value> [<value>...]
  autofile get <setting>
  autofile unset <setting>
`;

class UsageError extends Error {}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(usage);
  } else {
    reportError(error);
  }
  process.exitCode = 1;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    const store = await openStore();
    serveStdio(() => buildServer(store), {
      legacy: "reject",
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 64 * 1024 * 1024,
      }),
    });
    return;
  }

  const [command, setting, ...values] = args;
  if (command === "serve") {
    await serve(args.slice(1));
    return;
  }
  if (command === "set") {
    if (setting === undefined || !isSettingName(setting) || !hasValidSetArity(setting, values)) {
      throw new UsageError();
    }
    await setSetting(setting, values);
    return;
  }
  if (command === "get") {
    if (setting === undefined || values.length !== 0 || !isSettingName(setting)) {
      throw new UsageError();
    }
    const lines = await getSetting(setting);
    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (command === "unset") {
    if (setting === undefined || values.length !== 0 || !isSettingName(setting)) {
      throw new UsageError();
    }
    await unsetSetting(setting);
    return;
  }
  throw new UsageError();
}

async function serve(args: string[]): Promise<void> {
  const overrides = parseServeOptions(args);
  const settings = await getSettings();
  const http = {
    ...settings.http,
    ...(overrides.host === undefined ? {} : { host: overrides.host }),
    ...(overrides.port === undefined ? {} : { port: overrides.port }),
  };
  const store = await openStore({ dataFolder: settings.storage });
  const running = await startHttpServer(store, http);
  process.stderr.write(`autofile: listening on ${running.endpoint.href}\n`);

  const stop = () => {
    void running.close().catch((error: unknown) => {
      reportError(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await running.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function parseServeOptions(args: string[]): { host?: string; port?: number } {
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new UsageError();
    if (option === "--host" && host === undefined) {
      if (value === "") throw new Error("http.host must be a non-empty string");
      host = value;
    } else if (option === "--port" && port === undefined) {
      port = parsePort(value);
    } else {
      throw new UsageError();
    }
  }
  return {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  };
}

function hasValidSetArity(setting: string, values: string[]): boolean {
  if (setting === "http.origins") return values.length > 0;
  return values.length === 1;
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`autofile: ${message.replace(/[\r\n]+/gu, " ")}\n`);
}
