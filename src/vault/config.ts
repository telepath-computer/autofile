import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ErrorObject, SchemaObject, ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

// The config document's own schema, stating in JSON Schema what the vault spec
// states in TypeScript. It ships so an editor can validate an `autofile.yml`
// against it.
import configSchema from './config.schema.json' with { type: 'json' };
import type { Finding } from './findings.ts';

/** The file a vault's config lives in, at the vault root. */
export const CONFIG_FILE = 'autofile.yml';

/**
 * The rules for records at one path. A path may be listed with no entry at all,
 * which is `null`: the path is Autofile's, with no rules on what is filed there.
 */
export interface PathEntry {
  title?: string;
  description?: string;
  schema?: Record<string, unknown>;
  filename?: Record<string, unknown>;
  body?: boolean;
}

/** A vault's config: what Autofile is authoritative over. */
export interface VaultConfig {
  title?: string;
  description?: string;
  paths?: Record<string, PathEntry | null>;
}

/**
 * A path entry's `schema` and `filename`, compiled. Loading has to compile them
 * to know they are usable, so it hands the results on rather than making record
 * checking compile them a second time.
 */
export interface PathRules {
  schema?: ValidateFunction;
  filename?: ValidateFunction;
}

export type LoadConfigResult =
  | { status: 'loaded'; config: VaultConfig; rules: Record<string, PathRules> }
  | { status: 'missing' }
  | { status: 'violation'; finding: Finding };

/**
 * A `config` finding. It concerns the vault's own file, so unlike other
 * findings it names neither a record nor a path entry.
 */
function violation(message: string): LoadConfigResult {
  return {
    status: 'violation',
    finding: { rule: 'config', severity: 'violation', file: CONFIG_FILE, message },
  };
}

/** Compiles a schema, against an Ajv already set up for what it is for. */
type Compile = (schema: SchemaObject) => ValidateFunction;

interface Validators {
  /** The config document's own schema, compiled. */
  config: ValidateFunction;
  /** A compiler for one vault's path rules. */
  forPathRules: () => Compile;
}

let cached: Promise<Validators> | undefined;

/**
 * Ajv, and the config schema compiled against it — on first use rather than at
 * import. Loading the library and compiling with it cost more than everything
 * else the binary does at startup, and `autofile --help` and an unknown command
 * reach this module through the command that would open a vault without ever
 * opening one, so neither should pay for a validator that never runs.
 *
 * Memoised, so a process that opens several vaults still loads Ajv once.
 */
function validators(): Promise<Validators> {
  cached ??= (async () => {
    const ajvModule = (await import('ajv/dist/2020.js')).default;
    const ajvFormatsModule = (await import('ajv-formats')).default;
    // Both packages are CommonJS with `module.exports` set to the export
    // itself, so Node's ESM interop hands back the class and the function.
    // TypeScript can only see the declared namespace, hence the casts.
    const Ajv2020 = ajvModule as unknown as typeof ajvModule.default;
    const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;

    // `allErrors` reports every problem in one pass, so a run over an unchanged
    // config always produces the same complete report rather than the first
    // fault.
    const config = new Ajv2020({ allErrors: true }).compile(configSchema);

    return {
      config,
      forPathRules: () => {
        // A fresh Ajv per vault: compiled schemas are cached by `$id`, so a
        // shared instance would let one vault's config collide with another's.
        //
        // `strictTypes` and `strictTuples` are Ajv style heuristics that log
        // against schemas that are perfectly legal — the example in the vault
        // rules writes `filename: { pattern: ... }` with no `type` — and a
        // config that conforms to the spec must not make the tool complain.
        // Ajv's other strict checks stay on, so an unknown keyword is an error
        // rather than a rule that does nothing.
        const ajv = addFormats(
          new Ajv2020({ allErrors: true, strictTypes: false, strictTuples: false }),
        );
        return (schema) => ajv.compile(schema);
      },
    };
  })();
  return cached;
}

/** A JSON Pointer into the config document, so a violation can say where. */
function pointer(...tokens: string[]): string {
  return tokens.map((token) => `/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/**
 * Compiles every path entry's `schema` and `filename`, collecting the ones that
 * are not usable as schemas. A rule that cannot compile is reported rather than
 * dropped, because a path whose rules silently never apply looks like a path
 * whose records all pass.
 */
function compilePathRules(
  config: VaultConfig,
  compile: Compile,
): {
  rules: Record<string, PathRules>;
  problems: string[];
} {
  const problems: string[] = [];
  const rules: Record<string, PathRules> = {};

  for (const [path, entry] of Object.entries(config.paths ?? {})) {
    const compiled: PathRules = {};
    for (const field of ['schema', 'filename'] as const) {
      const rule = entry?.[field];
      if (rule === undefined) continue;
      try {
        compiled[field] = compile(rule as SchemaObject);
      } catch (cause) {
        problems.push(`${pointer('paths', path, field)}: ${(cause as Error).message}`);
      }
    }
    rules[path] = compiled;
  }

  return { rules, problems };
}

// Ajv leaves the offending key out of `message` for these two keywords, so it
// is spliced in from `params`: a violation has to say which key is wrong.
function formatError(error: ErrorObject): string {
  const where = error.instancePath || '(root)';
  switch (error.keyword) {
    case 'additionalProperties':
      return `${where}: unknown key '${error.params['additionalProperty']}'`;
    case 'propertyNames':
      return `${where}: invalid key '${error.params['propertyName']}'`;
    default:
      return `${where}: ${error.message}`;
  }
}

/** Reads and validates the config at a vault root. */
export async function loadConfig(root: string): Promise<LoadConfigResult> {
  let source: string;
  try {
    source = await readFile(join(root, CONFIG_FILE), 'utf8');
  } catch (cause) {
    // Only absence means "no vault here". Anything else is a file that exists
    // and cannot be used, which is a violation rather than a third channel the
    // caller would have to handle.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return violation(`cannot be read: ${(cause as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (cause) {
    return violation(`does not parse as YAML: ${(cause as Error).message}`);
  }

  // Not before now: a folder with no config at all is answered without a schema
  // validator ever being loaded.
  const { config: validateConfig, forPathRules } = await validators();
  if (!validateConfig(parsed)) {
    return violation((validateConfig.errors ?? []).map(formatError).join('; '));
  }

  const config = parsed as VaultConfig;
  const { rules, problems } = compilePathRules(config, forPathRules());
  if (problems.length > 0) return violation(problems.join('; '));

  return { status: 'loaded', config, rules };
}
