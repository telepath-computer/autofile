import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport from "ajv-formats";
// ajv-formats ships CJS with an ESM-style default in its types; under
// NodeNext the runtime value of the default import is the plugin itself.
const addFormats = addFormatsExport as unknown as typeof addFormatsExport.default;
import { load } from "js-yaml";

// The config model. Patterns and schemas are stored compiled: an
// uncompilable one is rejected at load, so a Config in hand is enforceable
// as-is. `regex` is ready to match: anchored for filenames, which state a
// shape the whole segment must have, and as written for ignore, which is a
// trigger — "a plain match, not a full one" (spec/vault.md).

export interface ConfigError {
  message: string;
}

export interface CompiledPattern {
  /** The pattern as written in the config. */
  source: string;
  /**
   * The compiled, ready-to-match form: `^(?:source)$` for filenames,
   * `source` as written for ignore.
   */
  regex: RegExp;
}

export interface CompiledSchema {
  /** The schema as written in the config. */
  source: Record<string, unknown>;
  validate: ValidateFunction;
}

export interface RecordsBlock {
  schema?: CompiledSchema;
  body?: { allowed?: boolean };
}

export interface AssetsBlock {
  allowed?: boolean;
}

export interface FilenamesBlock {
  pattern?: CompiledPattern;
}

export interface IgnoreBlock {
  pattern?: CompiledPattern;
}

export interface RuleBlocks {
  records?: RecordsBlock;
  assets?: AssetsBlock;
  filenames?: FilenamesBlock;
  ignore?: IgnoreBlock;
}

export interface PathEntry extends RuleBlocks {
  description: string;
}

export interface Config {
  global?: RuleBlocks;
  paths: Map<string, PathEntry>;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; errors: ConfigError[] };

/** Reads and parses a vault's autofile.yml; an unreadable file is a config error. */
export async function loadConfig(filePath: string): Promise<ConfigResult> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, errors: [{ message: `autofile.yml cannot be read: ${describe(error)}` }] };
  }
  return parseConfig(source);
}

/** Parses autofile.yml source into the config model; invalid input yields errors as data. */
export function parseConfig(source: string): ConfigResult {
  let document: unknown;
  try {
    document = load(source);
  } catch (error) {
    return { ok: false, errors: [{ message: `autofile.yml does not parse: ${describe(error)}` }] };
  }
  if (document === null || document === undefined) {
    return { ok: true, config: { paths: new Map() } };
  }
  if (!isMapping(document)) {
    return { ok: false, errors: [{ message: "autofile.yml: must be a mapping of global and paths" }] };
  }

  const errors: ConfigError[] = [];
  // allErrors so a validator reports every failure: check turns each into
  // its own finding, matching how config errors are all collected.
  const ajv = new Ajv2020({ allErrors: true, logger: false });
  addFormats(ajv);

  rejectUnknownKeys(document, ["global", "paths"], "autofile.yml", errors);

  let global: RuleBlocks | undefined;
  if ("global" in document) {
    const raw = asMapping(document["global"], "global", errors);
    if (raw !== undefined) {
      if ("description" in raw) {
        errors.push({ message: "global.description: global declares rule blocks only, not a description" });
      }
      rejectUnknownKeys(raw, ["description", ...blockKeys], "global", errors);
      global = parseBlocks(raw, "global", ajv, errors);
    }
  }

  const paths = new Map<string, PathEntry>();
  if ("paths" in document) {
    const raw = asMapping(document["paths"], "paths", errors);
    if (raw !== undefined) {
      const byCase = new Map<string, string>();
      for (const [key, value] of Object.entries(raw)) {
        const location = `paths.${key}`;
        // A paths key names a folder, so it must be a name every filesystem
        // can hold (spec/vault.md): no empty, "." or ".." segments, no
        // control characters, Unicode NFC.
        if (key === "") {
          errors.push({ message: "paths: a paths key must not be empty" });
        } else if (key === "." || key === "..") {
          errors.push({ message: `paths."${key}": a paths key may not be "${key}"` });
        }
        if (key.includes("/")) {
          errors.push({ message: `${location}: a paths key is a single path segment, with no "/"` });
        }
        if (/[\u0000-\u001f\u007f]/.test(key)) {
          // JSON.stringify escapes the control characters, keeping the
          // message printable while still naming the key.
          errors.push({ message: `paths.${JSON.stringify(key)}: a paths key may not contain control characters` });
        }
        if (key !== key.normalize("NFC")) {
          errors.push({ message: `paths."${key}": a paths key must be Unicode NFC` });
        }
        const folded = key.toLowerCase();
        const clash = byCase.get(folded);
        if (clash === undefined) {
          byCase.set(folded, key);
        } else {
          errors.push({ message: `paths: "${clash}" and "${key}" differ only by case` });
        }
        const entry = asMapping(value, location, errors);
        if (entry === undefined) continue;
        rejectUnknownKeys(entry, ["description", ...blockKeys], location, errors);
        const description = entry["description"];
        if (description === undefined) {
          errors.push({ message: `${location}.description: required on every path entry` });
        } else if (typeof description !== "string") {
          errors.push({ message: `${location}.description: must be a string` });
        }
        paths.set(key, {
          description: typeof description === "string" ? description : "",
          ...parseBlocks(entry, location, ajv, errors),
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { global, paths } };
}

/**
 * The effective rule blocks for a file at a vault-relative path. A path
 * entry's block, where declared, replaces global's entirely; omission
 * leaves global's in force (spec/vault.md). Only files below a declared
 * top-level folder are governed by its entry; a file at the vault root
 * falls to global.
 */
export function resolve(config: Config, vaultRelativePath: string): RuleBlocks {
  const segments = vaultRelativePath.split("/");
  const entry = segments.length > 1 ? config.paths.get(segments[0]!) : undefined;
  const global = config.global;
  return {
    records: entry?.records ?? global?.records,
    assets: entry?.assets ?? global?.assets,
    filenames: entry?.filenames ?? global?.filenames,
    ignore: entry?.ignore ?? global?.ignore,
  };
}

/**
 * Whether a vault-relative path is ignored: the ignore pattern in force at
 * some segment's location matches that segment's name — a plain match, not
 * a full one — which ignores the whole subtree beneath it (spec/vault.md).
 */
export function isIgnored(config: Config, vaultRelativePath: string): boolean {
  const segments = vaultRelativePath.split("/");
  for (let depth = 0; depth < segments.length; depth++) {
    const location = segments.slice(0, depth + 1).join("/");
    const pattern = resolve(config, location).ignore?.pattern;
    if (pattern !== undefined && pattern.regex.test(segments[depth]!)) return true;
  }
  return false;
}

const blockKeys = ["records", "assets", "filenames", "ignore"] as const;

function parseBlocks(
  raw: Record<string, unknown>,
  location: string,
  ajv: Ajv2020,
  errors: ConfigError[],
): RuleBlocks {
  const blocks: RuleBlocks = {};
  if ("records" in raw) blocks.records = parseRecords(raw["records"], `${location}.records`, ajv, errors);
  if ("assets" in raw) blocks.assets = parseAssets(raw["assets"], `${location}.assets`, errors);
  if ("filenames" in raw) {
    blocks.filenames = parsePatterned(raw["filenames"], `${location}.filenames`, "anchored", errors);
  }
  if ("ignore" in raw) blocks.ignore = parsePatterned(raw["ignore"], `${location}.ignore`, "plain", errors);
  return blocks;
}

function parseRecords(
  value: unknown,
  location: string,
  ajv: Ajv2020,
  errors: ConfigError[],
): RecordsBlock {
  const raw = asMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["schema", "body"], location, errors);
  const block: RecordsBlock = {};
  if ("schema" in raw) {
    const schema = raw["schema"];
    if (!isMapping(schema)) {
      errors.push({ message: `${location}.schema: must be a mapping holding a JSON Schema` });
    } else {
      try {
        block.schema = { source: schema, validate: ajv.compile(schema) };
      } catch (error) {
        // Distinguish a strict-mode rejection (a legal schema ajv refuses
        // on strictness grounds; its message starts "strict mode: ...")
        // from a schema that is not valid JSON Schema at all.
        const reason = describe(error);
        errors.push({
          message: reason.startsWith("strict mode")
            ? `${location}.schema: rejected: ${reason}`
            : `${location}.schema: does not compile as JSON Schema: ${reason}`,
        });
      }
    }
  }
  if ("body" in raw) {
    const body = asMapping(raw["body"], `${location}.body`, errors);
    if (body !== undefined) {
      rejectUnknownKeys(body, ["allowed"], `${location}.body`, errors);
      block.body = { allowed: asAllowed(body, `${location}.body`, errors) };
    }
  }
  return block;
}

function parseAssets(value: unknown, location: string, errors: ConfigError[]): AssetsBlock {
  const raw = asMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["allowed"], location, errors);
  return { allowed: asAllowed(raw, location, errors) };
}

function parsePatterned(
  value: unknown,
  location: string,
  match: "anchored" | "plain",
  errors: ConfigError[],
): { pattern?: CompiledPattern } {
  const raw = asMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["pattern"], location, errors);
  const pattern = raw["pattern"];
  if (pattern === undefined) return {};
  if (typeof pattern !== "string") {
    errors.push({ message: `${location}.pattern: must be a string` });
    return {};
  }
  try {
    const regex = match === "anchored" ? new RegExp(`^(?:${pattern})$`) : new RegExp(pattern);
    return { pattern: { source: pattern, regex } };
  } catch (error) {
    errors.push({ message: `${location}.pattern: does not compile as a regular expression: ${describe(error)}` });
    return {};
  }
}

function asAllowed(
  raw: Record<string, unknown>,
  location: string,
  errors: ConfigError[],
): boolean | undefined {
  const allowed = raw["allowed"];
  if (allowed === undefined || typeof allowed === "boolean") return allowed;
  errors.push({ message: `${location}.allowed: must be a boolean` });
  return undefined;
}

/** Accepts a YAML mapping, treating a bare key (null) as an empty one. */
function asMapping(
  value: unknown,
  location: string,
  errors: ConfigError[],
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return {};
  if (isMapping(value)) return value;
  errors.push({ message: `${location}: must be a mapping` });
  return undefined;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  mapping: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
  errors: ConfigError[],
): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) errors.push({ message: `${location}: unknown key "${key}"` });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
