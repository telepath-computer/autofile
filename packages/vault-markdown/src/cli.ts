#!/usr/bin/env node
/**
 * `autofile-md`: the command that serves a folder as an Autofile vault, and the
 * one that checks it. The folder is the working directory, so what is served or
 * checked is where it was run.
 */

import type { Finding } from './findings.ts';
import { createServer } from './server.ts';
import { MarkdownVault } from './vault.ts';

const NAME = 'autofile-md';

/**
 * Both are settable and these are the defaults. Binding wide is typed rather
 * than assumed: there is no authentication, so `--host 0.0.0.0` makes the vault
 * readable and writable by everything that can reach the machine.
 */
const DEFAULTS = { host: '127.0.0.1', port: 8787 };

const USAGE = [
  `usage: ${NAME} serve [--host ${DEFAULTS.host}] [--port ${DEFAULTS.port}]`,
  `       ${NAME} validate`,
].join('\n');

/** A run that could not start: the arguments, or the folder. */
function unusable(complaint: string): never {
  process.stderr.write(`${NAME}: ${complaint}\n`);
  process.exit(2);
}

/**
 * One finding on one line: what it is against, what is wrong with it, and the
 * collection that governs it.
 *
 * A violation names the identity. A warning is labelled and names its
 * collection in the identity's place, so the parenthetical would only repeat it
 * and is left off. A `config` violation is about the vault's own file and names
 * neither, so the line is the message alone.
 */
function render(finding: Finding): string {
  const label = finding.severity === 'warning' ? 'warning: ' : '';
  const subject = finding.id ?? finding.collection;
  const names = subject === undefined ? '' : `${subject} — `;
  const governs =
    finding.collection !== undefined && finding.collection !== subject
      ? `   (${finding.collection})`
      : '';
  return `${label}${names}${oneLine(finding.message)}${governs}`;
}

/**
 * A message flattened to one line, since a report read one finding to a line
 * cannot have one of them span several. Messages come from the parsers beneath,
 * and the YAML parser quotes the offending source and underlines the column —
 * an underline that marks nothing once that layout is gone.
 */
function oneLine(message: string): string {
  return message
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ \^+$/, '');
}

/** A total and the noun it counts, pluralised. */
function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);

if (command === 'serve') {
  let host = DEFAULTS.host;
  let port = DEFAULTS.port;

  for (let at = 0; at < rest.length; at += 2) {
    const option = rest[at];
    const value = rest[at + 1];
    if (value === undefined) unusable(`'${option}' takes a value\n${USAGE}`);
    if (option === '--host') {
      host = value;
    } else if (option === '--port') {
      port = Number(value);
      // A port is a number in range, and `Number` is happy with plenty that are
      // not: an unparsable one would otherwise bind an arbitrary port instead.
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        unusable(`'${value}' is not a port`);
      }
    } else {
      unusable(`unknown option '${option}'\n${USAGE}`);
    }
  }

  let vault;
  try {
    vault = await MarkdownVault.open(root);
  } catch (error) {
    unusable(error instanceof Error ? error.message : String(error));
  }

  const server = createServer(vault);
  server.listen(port, host, () => {
    // Said once it is listening, so whatever started it knows it can be asked.
    process.stdout.write(`${NAME}: serving ${root} on http://${host}:${port}\n`);
  });
} else if (command === 'validate') {
  // The working directory and nothing else: there is nothing to settle about a
  // folder beyond which one it is.
  const unexpected = rest[0];
  if (unexpected !== undefined) {
    unusable(`'${unexpected}' is not something validate takes\n${USAGE}`);
  }

  let vault;
  try {
    vault = await MarkdownVault.open(root);
  } catch (error) {
    // This is a command about a folder rather than about a vault, so a folder
    // that will not open is the `config` finding rather than a run that could
    // not start. `validate` the method never answers with one: `open` refuses
    // every case that finding names before there is a vault to ask.
    const why = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${render({ rule: 'config', severity: 'violation', message: why })}\n`);
    // No line naming what was checked follows: a config that cannot be used
    // means nothing was checked, and such a line would be naming nothing.
    process.exit(1);
  }

  const findings = await vault.validate();
  for (const finding of findings) process.stdout.write(`${render(finding)}\n`);

  // What the vault is worth is what its findings are worth, and a warning is
  // legal: only the violations among them decide how the run ends.
  if (findings.some((finding) => finding.severity === 'violation')) process.exit(1);

  // A valid vault still says what was checked, so a run that found nothing is
  // distinguishable from one that found everything in order. It names the
  // folder because a run in the wrong one is the mistake this line catches.
  //
  // The counts come from the vault itself, which a valid one answers for every
  // collection: a record it could not read, or a key it could not hold, would
  // have been a violation and this line would not be printed.
  let records = 0;
  let blobs = 0;
  for (const name of Object.keys(vault.collections)) {
    for (const item of await vault.list(name)) {
      if (item.type === 'record') records += 1;
      else blobs += 1;
    }
  }
  const held = `${count(records, 'record')} and ${count(blobs, 'blob')}`;
  const over = count(Object.keys(vault.collections).length, 'collection');
  process.stdout.write(`${root} — ${held} in ${over}, no violations\n`);
} else {
  const complaint = command === undefined ? 'no command' : `unknown command '${command}'`;
  unusable(`${complaint}\n${USAGE}`);
}
