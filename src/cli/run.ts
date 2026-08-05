import { NAME, type Command, type CommandOutput } from './command.ts';
import { validate } from './validate.ts';

/** The commands, in the order usage lists them. */
const COMMANDS: Record<string, Command> = { validate };

/** The argument that asks what the binary does rather than asking it to do it. */
const HELP = '--help';

/** Runs the command named by the arguments, against the working directory. */
export async function run(args: string[], cwd: string): Promise<CommandOutput> {
  // Asking for help is not an error, wherever it is asked: the usage text is
  // what was wanted, so it goes to standard output and the run succeeds. It is
  // answered before dispatch, so it needs neither a command nor a vault.
  if (args.includes(HELP)) return { status: 'ok', out: usage(), err: [] };

  const [name, ...rest] = args;
  const command = find(name);
  if (command === undefined) {
    const complaint = name === undefined ? [] : [`${NAME}: unknown command '${name}'`];
    return { status: 'unusable', out: [], err: [...complaint, ...usage()] };
  }
  return command.run(cwd, rest);
}

function find(name: string | undefined): Command | undefined {
  // Own keys only: `autofile toString` names something on Object's prototype,
  // and nothing this can run.
  return name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}

/** What the binary can be asked to do, listed from the commands themselves. */
function usage(): string[] {
  return [
    `usage: ${NAME} <command>`,
    '',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name}   ${command.summary}`),
  ];
}
