#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { check } from "./check.js";
import { count, renderCheckReport, renderInitReport, Spinner } from "./output.js";
import { starterConfig } from "./starter.js";

// The `autofile` binary (spec/cli.md): two commands and two flags, parsed
// by hand. Reports go to stdout; errors that prevent a command from
// running go to stderr. Color and the spinner key off stdout being a
// terminal — the spinner writes to the report stream and erases itself
// before the report prints, so piped output is plain bytes.

const usage = `Usage: autofile <command> [path]

Predictable filing for agents — initialize and check Autofile vaults.

  init         create an empty Autofile configuration
  check        validate the vault and report findings
  path         vault folder (default: current directory)
  --help       show this help
  --version    print the version
`;

const color = process.stdout.isTTY === true;

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
    const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const { version } = JSON.parse(source) as { version: string };
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const [command, path, ...rest] = argv;
  // A lone --help after a known command is a request for help, not a
  // mistake: same usage as `autofile --help`, stdout, exit 0.
  if ((command === "init" || command === "check") && path === "--help" && rest.length === 0) {
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
  // No or unknown arguments show the same usage as --help (spec/cli.md),
  // but on stderr with exit 1: nothing was asked for, or the ask was not
  // understood, and a script should see the difference.
  process.stderr.write(usage);
  return 1;
}

/** `autofile init`: write only the comments-only config; never overwrite. */
async function init(vaultRoot: string): Promise<number> {
  if (await fileExists(join(vaultRoot, "autofile.yml"))) {
    process.stderr.write("autofile.yml already exists; init never overwrites.\n");
    return 1;
  }
  const spinner = new Spinner(process.stdout);
  clearSpinnerOnSigint(spinner);
  spinner.start("Initializing…");
  try {
    // wx: even against a config racing into place, init never overwrites.
    await writeFile(join(vaultRoot, "autofile.yml"), starterConfig, { flag: "wx" });
    spinner.stop();
    process.stdout.write(renderInitReport("autofile.yml", { color }));
    return 0;
  } catch (error) {
    spinner.stop();
    process.stderr.write(`${describe(error)}\n`);
    return 1;
  }
}

/** `autofile check`: exit 0 iff no violations; warnings do not change it. */
async function runCheck(vaultRoot: string): Promise<number> {
  if (!await fileExists(join(vaultRoot, "autofile.yml"))) {
    process.stderr.write("autofile.yml not found; this folder is not an Autofile vault.\n");
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
    process.stderr.write(`${describe(error)}\n`);
    return 1;
  }
  spinner.stop();
  process.stdout.write(renderCheckReport(result, { color }));
  return result.findings.some((finding) => finding.severity === "violation") ? 1 : 0;
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

process.exitCode = await main(process.argv.slice(2));
