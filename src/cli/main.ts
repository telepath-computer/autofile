#!/usr/bin/env node
import { NAME, type CommandStatus } from './command.ts';
import { run } from './run.ts';

/**
 * What each ending is worth to a caller. A vault that breaks the rules and a
 * command that could not run are both non-zero, and kept apart so a script can
 * act on the difference — an absent vault is not an invalid one.
 */
const EXIT: Record<CommandStatus, number> = { ok: 0, failed: 1, unusable: 2 };

function write(stream: NodeJS.WriteStream, lines: string[]): void {
  if (lines.length > 0) stream.write(`${lines.join('\n')}\n`);
}

try {
  const output = await run(process.argv.slice(2), process.cwd());
  write(process.stdout, output.out);
  write(process.stderr, output.err);
  // Set rather than exited on, so buffered output is flushed before the process
  // ends.
  process.exitCode = EXIT[output.status];
} catch (error) {
  // Anything that escapes is the tool failing rather than the vault, so it is
  // reported as the tool and never as a violation.
  write(process.stderr, [`${NAME}: ${error instanceof Error ? error.message : String(error)}`]);
  process.exitCode = EXIT.unusable;
}
