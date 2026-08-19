#!/usr/bin/env node
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { check } from "./check.js";
import { loadConfig } from "./config.js";
import {
  count,
  renderCheckReport,
  renderError,
  renderInitReport,
  renderServeReport,
  Spinner,
} from "./output.js";
import { createVaultServer, watchVaultConfig } from "./serve.js";
import { starterConfig } from "./starter.js";

// The `autofile` binary (spec/cli.md): three commands, parsed
// by hand. Reports go to stdout; errors that prevent a command from
// running go to stderr. Each stream decides its own styling. The spinner
// writes to stdout and erases itself before a report, so pipes are plain.

const usage = `Usage: autofile <command> [path]

Predictable filing for agents — initialize, check, and serve Autofile vaults.

  init         create an empty Autofile configuration
  check        validate the vault and report findings
  serve        serve the vault over HTTP
  path         vault folder (default: current directory)
  --host HOST  host to bind (serve only)
  --port PORT  port to bind (serve only)
  --help       show this help
  --version    print the version
`;

const stdoutColor = process.stdout.isTTY === true;
const stderrColor = process.stderr.isTTY === true;

// A consumer that stops reading early (`autofile check | head -1`) closes
// the pipe and later writes fail with EPIPE. Swallow it — the run exits
// with the code it earned, as CLIs conventionally do — and rethrow
// anything else so real stream errors still crash loudly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

/**
 * While `spinner` may have drawn, Ctrl-C first erases its line, then
 * re-raises SIGINT for the default death (exit-130 semantics). Installed
 * next to each spinner; never removed, because the process exits with the
 * command and a bare re-raise is exactly the default behavior.
 */
function clearSpinnerOnSigint(spinner: Spinner): void {
  process.once("SIGINT", () => {
    spinner.stop();
    process.kill(process.pid, "SIGINT");
  });
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(usage);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  const [command, path, ...rest] = argv;
  // A lone --help after a known command is a request for help, not a
  // mistake: same usage as `autofile --help`, stdout, exit 0.
  if ((command === "init" || command === "check" || command === "serve") && path === "--help" && rest.length === 0) {
    process.stdout.write(usage);
    return 0;
  }
  if (
    (command === "init" || command === "check") &&
    rest.length === 0 &&
    (path === undefined || !path.startsWith("-"))
  ) {
    const vaultRoot = resolve(path ?? ".");
    return command === "init" ? init(vaultRoot) : runCheck(vaultRoot);
  }
  if (command === "serve") {
    const parsed = parseServeArguments(argv.slice(1));
    if (parsed !== undefined) return runServe(resolve(parsed.path ?? "."), parsed.listen);
  }
  // No or unknown arguments show the same usage as --help (spec/cli.md),
  // but on stderr with exit 1: nothing was asked for, or the ask was not
  // understood, and a script should see the difference.
  process.stderr.write(usage);
  return 1;
}

/** `autofile init`: write only the seeded version 1 config; never overwrite. */
async function init(vaultRoot: string): Promise<number> {
  if (await fileExists(join(vaultRoot, "autofile.yml"))) {
    printError("autofile.yml already exists; init never overwrites.");
    return 1;
  }
  const spinner = new Spinner(process.stdout);
  clearSpinnerOnSigint(spinner);
  spinner.start("Initializing…");
  try {
    // wx: even against a config racing into place, init never overwrites.
    await writeFile(join(vaultRoot, "autofile.yml"), starterConfig, { flag: "wx" });
    spinner.stop();
    process.stdout.write(renderInitReport("autofile.yml", { color: stdoutColor }));
    return 0;
  } catch (error) {
    spinner.stop();
    printError(isErrorCode(error, "EEXIST")
      ? "autofile.yml already exists; init never overwrites."
      : describe(error));
    return 1;
  }
}

/** `autofile check`: exit 0 iff no violations; warnings do not change it. */
async function runCheck(vaultRoot: string): Promise<number> {
  if (!await fileExists(join(vaultRoot, "autofile.yml"))) {
    printError("autofile.yml not found; this folder is not an Autofile vault.");
    return 1;
  }
  const spinner = new Spinner(process.stdout);
  clearSpinnerOnSigint(spinner);
  spinner.start(`Checking… ${count(0, "file")}`);
  let result;
  try {
    result = await check(vaultRoot, {
      onFile: (files) => spinner.update(`Checking… ${count(files, "file")}`),
    });
  } catch (error) {
    // An environment error — e.g. an unreadable directory — not findings.
    spinner.stop();
    printError(describe(error));
    return 1;
  }
  spinner.stop();
  process.stdout.write(renderCheckReport(result, { color: stdoutColor }));
  return result.findings.some((finding) => finding.severity === "violation") ? 1 : 0;
}

interface ListenOptions {
  host?: string;
  port?: number;
}

function parseServeArguments(args: string[]): { path?: string; listen: ListenOptions } | undefined {
  let path: string | undefined;
  const listen: ListenOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--host") {
      const value = args[++index];
      if (value === undefined || value.startsWith("-") || listen.host !== undefined) return undefined;
      listen.host = value;
      continue;
    }
    if (argument === "--port") {
      const value = args[++index];
      if (
        value === undefined
        || !/^\d+$/u.test(value)
        || Number(value) > 65_535
        || listen.port !== undefined
      ) return undefined;
      listen.port = Number(value);
      continue;
    }
    if (argument.startsWith("-") || path !== undefined) return undefined;
    path = argument;
  }
  return { ...(path === undefined ? {} : { path }), listen };
}

/** `autofile serve`: bind vault-server with live Autofile configuration. */
async function runServe(vaultRoot: string, listen: ListenOptions): Promise<number> {
  const configPath = join(vaultRoot, "autofile.yml");
  if (!await fileExists(configPath)) {
    printError("autofile.yml not found; this folder is not an Autofile vault.");
    return 1;
  }
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    printError(`autofile.yml: ${loaded.errors.map(({ message }) => message).join("; ")}`);
    return 1;
  }

  let server: ReturnType<typeof createVaultServer> | undefined;
  let configWatcher: ReturnType<typeof watchVaultConfig> | undefined;
  try {
    const root = await realpath(vaultRoot);
    server = createVaultServer(root, loaded.config);
    await server.listen(listen);
    configWatcher = watchVaultConfig(root, server, {
      onError: (message) => printError(`autofile.yml was not reloaded: ${message}`),
    });
    const url = server.url;
    if (url === undefined) throw new Error("vault server did not report its bound URL");
    const notes = [...server.paths].filter((path) => path.endsWith(".md")).length;
    process.stdout.write(renderServeReport({
      version: await packageVersion(),
      root,
      notes,
      url,
    }, { color: stdoutColor }));
    return await waitForShutdown(server, configWatcher);
  } catch (error) {
    configWatcher?.close();
    if (server !== undefined) await server.close().catch(() => undefined);
    printError(describe(error));
    return 1;
  }
}

async function waitForShutdown(
  server: ReturnType<typeof createVaultServer>,
  configWatcher: ReturnType<typeof watchVaultConfig>,
): Promise<number> {
  return new Promise((resolveExit) => {
    let closing = false;
    const close = (code: number): void => {
      if (closing) return;
      closing = true;
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      configWatcher.close();
      void server.close().then(() => resolveExit(code), () => resolveExit(code));
    };
    const onSigint = (): void => close(130);
    const onSigterm = (): void => close(143);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

async function packageVersion(): Promise<string> {
  const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(source) as { version: string }).version;
}

function printError(message: string): void {
  process.stderr.write(renderError(message, { color: stderrColor }));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

process.exitCode = await main(process.argv.slice(2));
