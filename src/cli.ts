#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { check } from "./check.js";
import { parseConfig } from "./config.js";
import { renderCheckReport, renderInitReport, Spinner } from "./output.js";
import { starterConfig } from "./starter.js";

// The `autofile` binary (spec/cli.md): two commands and two flags, parsed
// by hand. Reports go to stdout; errors that prevent a command from
// running go to stderr. Color and the spinner key off stdout being a
// terminal — the spinner writes to the report stream and erases itself
// before the report prints, so piped output is plain bytes.

const usage = `Usage:
  autofile init [path]   Create a vault: the starter autofile.yml and its folders
  autofile check [path]  Check the vault and report findings

[path] defaults to the current directory.
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

/** `autofile init`: the starter config and its folders; never overwrites. */
async function init(vaultRoot: string): Promise<number> {
  if (await fileExists(join(vaultRoot, "autofile.yml"))) {
    process.stderr.write("autofile.yml already exists; init never overwrites.\n");
    return 1;
  }
  const spinner = new Spinner(process.stdout);
  clearSpinnerOnSigint(spinner);
  spinner.start("Initializing…");
  try {
    await mkdir(vaultRoot, { recursive: true });
    // wx: even against a config racing into place, init never overwrites.
    await writeFile(join(vaultRoot, "autofile.yml"), starterConfig, { flag: "wx" });
    const folders = starterFolders();
    for (const folder of folders) await mkdir(join(vaultRoot, folder), { recursive: true });
    spinner.stop();
    process.stdout.write(renderInitReport({ config: "autofile.yml", folders }, { color }));
    return 0;
  } catch (error) {
    spinner.stop();
    process.stderr.write(`${describe(error)}\n`);
    return 1;
  }
}

/** The folder for each path the starter describes, in declaration order. */
function starterFolders(): string[] {
  const parsed = parseConfig(starterConfig);
  if (!parsed.ok) throw new Error("the starter config does not parse");
  return [...parsed.config.paths.keys()];
}

/** `autofile check`: exit 0 iff no violations; warnings do not change it. */
async function runCheck(vaultRoot: string): Promise<number> {
  const spinner = new Spinner(process.stdout);
  clearSpinnerOnSigint(spinner);
  spinner.start("Checking… 0 files");
  let result;
  try {
    result = await check(vaultRoot, {
      onFile: (count) => spinner.update(`Checking… ${count} file${count === 1 ? "" : "s"}`),
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
