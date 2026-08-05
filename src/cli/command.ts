/** The binary's name, as it prefixes anything it says about itself. */
export const NAME = 'autofile';

/**
 * How a run ended. The process exit code follows from it, so a caller can tell
 * a vault found wanting from a command that never got to look at one.
 */
export type CommandStatus = 'ok' | 'failed' | 'unusable';

/** What a command produced. */
export interface CommandOutput {
  status: CommandStatus;
  /** Lines for stdout: what the command was asked to report. */
  out: string[];
  /** Lines for stderr: why it could not report it. */
  err: string[];
}

/**
 * One subcommand. Commands take the working directory and their own arguments,
 * and return their output rather than writing it, so what a run says and how it
 * ends can be exercised without a process.
 */
export interface Command {
  /** One line for the usage listing. */
  summary: string;
  run(cwd: string, args: string[]): Promise<CommandOutput>;
}
