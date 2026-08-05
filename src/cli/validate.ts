import { CONFIG_FILE } from '../vault/config.ts';
import type { Finding } from '../vault/findings.ts';
import { validateVault } from '../vault/validate.ts';
import { NAME, type Command, type CommandOutput } from './command.ts';

export const validate: Command = {
  summary: 'check the vault in the working directory',

  async run(cwd: string, args: string[]): Promise<CommandOutput> {
    const rejected = rejectArguments(args);
    if (rejected !== undefined) return rejected;

    const validated = await validateVault(cwd);
    if (validated.status === 'missing') {
      // Not a violation: there is no vault here to find wanting, so this is the
      // command failing to run rather than a report that the vault is invalid.
      return { status: 'unusable', out: [], err: [`${NAME}: no ${CONFIG_FILE} in ${cwd}`] };
    }
    if (validated.status === 'unloadable') {
      // No summary line follows: a config that cannot be used means nothing was
      // checked, and a line naming what was checked would be naming nothing.
      return { status: 'failed', out: [render(validated.finding)], err: [] };
    }

    const { findings, records, paths } = validated;
    // What the vault is worth is what its findings are worth: a warning is
    // legal, so only the violations among them decide how the run ends.
    const violations = findings.filter((finding) => finding.severity === 'violation').length;

    return {
      status: violations === 0 ? 'ok' : 'failed',
      out: [...findings.map(render), summarise(cwd, records, paths, violations)],
      err: [],
    };
  },
};

/** `validate` takes the working directory and nothing else. */
function rejectArguments(args: string[]): CommandOutput | undefined {
  const unexpected = args[0];
  if (unexpected === undefined) return undefined;
  const complaint = unexpected.startsWith('-')
    ? `unknown option '${unexpected}'`
    : `unexpected argument '${unexpected}'`;
  return { status: 'unusable', out: [], err: [`${NAME}: ${complaint}`] };
}

/** The gap between a finding and the path entry that governs it. */
const GAP = '   ';

/**
 * A finding on one line: what it is against, what is wrong with it, and the
 * path entry that governs it.
 *
 * A finding names the file it is against. One against no file names its path
 * entry in the position a file would hold, and the label is what keeps that
 * line apart from a violation's. The parenthetical is left off where the path
 * is already what the line names, and where there is no path entry at all: a
 * `config` violation concerns the vault's own file.
 */
function render(finding: Finding): string {
  const label = finding.severity === 'warning' ? 'warning: ' : '';
  const subject = finding.file ?? finding.path;
  const names = subject === undefined ? '' : `${subject} — `;
  const governs =
    finding.path !== undefined && finding.path !== subject ? `${GAP}(${finding.path})` : '';
  return `${label}${names}${oneLine(finding.message)}${governs}`;
}

/**
 * A message flattened to one line. Messages come from the parsers and schema
 * validators beneath, some of which lay theirs out over several lines — the
 * YAML parser quotes the offending source — and a report read line by line
 * cannot have one finding span several.
 */
function oneLine(message: string): string {
  return (
    message
      .replace(/\s+/g, ' ')
      .trim()
      // A parser that underlines the offending column does it on a line of its
      // own, and the underline marks nothing once that layout is gone.
      .replace(/ \^+$/, '')
  );
}

/**
 * What was checked, so a run that found nothing is distinguishable from one
 * that found everything in order. It names the working directory because a run
 * in the wrong one is the mistake this line is there to catch.
 */
function summarise(cwd: string, records: number, paths: number, violations: number): string {
  const verdict = violations === 0 ? 'no violations' : count(violations, 'violation');
  return `${cwd} — ${count(records, 'record')} in ${count(paths, 'path')}, ${verdict}`;
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}
