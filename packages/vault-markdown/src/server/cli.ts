#!/usr/bin/env node
/**
 * `autofile-md`: the command that serves a folder as an Autofile vault. The
 * folder is the working directory, so what is served is where it was run.
 */

import { MarkdownVault } from '../vault.ts';
import { createServer } from './server.ts';

const NAME = 'autofile-md';

/**
 * Both are settable and these are the defaults. Binding wide is typed rather
 * than assumed: there is no authentication, so `--host 0.0.0.0` makes the vault
 * readable and writable by everything that can reach the machine.
 */
const DEFAULTS = { host: '127.0.0.1', port: 8787 };

const USAGE = `usage: ${NAME} serve [--host ${DEFAULTS.host}] [--port ${DEFAULTS.port}]`;

/** A run that could not start: the arguments, or the folder. */
function unusable(complaint: string): never {
  process.stderr.write(`${NAME}: ${complaint}\n`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
if (command !== 'serve') {
  const complaint = command === undefined ? 'no command' : `unknown command '${command}'`;
  unusable(`${complaint}\n${USAGE}`);
}

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

const root = process.cwd();

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
