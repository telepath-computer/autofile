import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport from "ajv-formats";
import { CORE_SCHEMA, load, YAMLException } from "js-yaml";

import { isWholeWikilink } from "./references.js";

const addFormats = addFormatsExport as unknown as typeof addFormatsExport.default;

export interface ConfigError {
  message: string;
}

export interface CompiledPattern {
  source: string;
  regex: RegExp;
}

export interface CompiledSchema {
  validate: ValidateFunction;
}

export type InternalLinkFormat = "wikilink" | "markdown-relative" | "markdown-absolute";

/**
 * An entry preserves explicit nulls: undefined means “inherit”, while null
 * means “clear the inherited setting and use its unconstrained default”.
 */
export interface PathEntry {
  description?: string;
  schema?: CompiledSchema | null;
  body?: { allowed?: boolean };
  extensions?: string[] | null;
  filenames?: { pattern?: CompiledPattern | null };
  internal_links?: {
    resolve?: boolean;
    format?: InternalLinkFormat | null;
  };
  ignore?: {
    dotfiles?: boolean;
    pattern?: CompiledPattern | null;
  };
}

export interface Config {
  strict: boolean;
  paths: Map<string, PathEntry>;
}

export interface EffectiveSettings {
  /** True when an entry encloses the path, or strict governs the whole vault. */
  governed: boolean;
  /** True when a declared path entry encloses the path. */
  declared: boolean;
  /** The nearest enclosing entry's filing instruction, if one exists. */
  description: string | undefined;
  schema: CompiledSchema | undefined;
  body: { allowed: boolean };
  extensions: string[] | undefined;
  filenames: { pattern: CompiledPattern | undefined };
  internal_links: { resolve: boolean; format: InternalLinkFormat | undefined };
  ignore: { dotfiles: boolean; pattern: CompiledPattern | undefined };
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; errors: ConfigError[] };

/** Reads and parses a vault's autofile.yml; failures are returned as data. */
export async function loadConfig(filePath: string): Promise<ConfigResult> {
  try {
    return parseConfig(await readFile(filePath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [{ message: `cannot be read: ${describe(error)}` }] };
  }
}

/** Parses source and compiles every schema and pattern before returning it. */
export function parseConfig(source: string): ConfigResult {
  let document: unknown;
  try {
    document = load(source, { schema: CORE_SCHEMA });
  } catch (error) {
    return { ok: false, errors: [{ message: `does not parse: ${describe(error)}` }] };
  }

  if (document === null || document === undefined) return success(false, new Map());
  if (!isMapping(document)) {
    return { ok: false, errors: [{ message: "must be a mapping of strict and paths" }] };
  }

  const errors: ConfigError[] = [];
  rejectUnknownKeys(document, ["strict", "paths"], "", errors);

  let strict = false;
  if ("strict" in document) {
    if (typeof document.strict === "boolean") strict = document.strict;
    else errors.push({ message: "strict must be a boolean" });
  }

  const ajv = createAjv();
  const paths = new Map<string, PathEntry>();
  if ("paths" in document) {
    const rawPaths = requireMapping(document.paths, "paths", errors);
    if (rawPaths !== undefined) {
      const canonicalPaths = new Map<string, string>();
      for (const [path, value] of Object.entries(rawPaths)) {
        validatePath(path, errors);
        const canonical = path.normalize("NFC").toLocaleLowerCase("en-US");
        const clash = canonicalPaths.get(canonical);
        if (clash === undefined) canonicalPaths.set(canonical, path);
        else {
          errors.push({
            message: `${clash} and ${path} differ only by case or Unicode normalization`,
          });
        }

        const rawEntry = requireMapping(value, path, errors);
        if (rawEntry === undefined) continue;
        paths.set(path, parseEntry(rawEntry, path, ajv, errors));
      }
    }
  }

  return errors.length === 0 ? success(strict, paths) : { ok: false, errors };
}

/**
 * Returns the complete effective settings for a vault-relative file or
 * folder path. Each leaf setting is selected independently from the nearest
 * enclosing path entry; explicit null resets that leaf to its default.
 * `governed` lets callers distinguish declared/strict content from content
 * outside Autofile's concern.
 */
export function resolve(config: Config, vaultRelativePath: string): EffectiveSettings {
  const entries = enclosingEntries(config, normalizeRelativePath(vaultRelativePath));
  return {
    governed: config.strict || entries.length > 0,
    declared: entries.length > 0,
    description: inherited(entries, (entry) => entry.description, undefined),
    schema: inherited(entries, (entry) => entry.schema, undefined),
    body: { allowed: inherited(entries, (entry) => entry.body?.allowed, true) },
    extensions: inherited(entries, (entry) => entry.extensions, undefined),
    filenames: { pattern: inherited(entries, (entry) => entry.filenames?.pattern, undefined) },
    internal_links: {
      resolve: inherited(entries, (entry) => entry.internal_links?.resolve, true),
      format: inherited(entries, (entry) => entry.internal_links?.format, undefined),
    },
    ignore: {
      dotfiles: inherited(entries, (entry) => entry.ignore?.dotfiles, true),
      pattern: inherited(entries, (entry) => entry.ignore?.pattern, undefined),
    },
  };
}

/** Tests each segment under the rules that reach that segment. */
export function isIgnored(config: Config, vaultRelativePath: string): boolean {
  const segments = normalizeRelativePath(vaultRelativePath).split("/").filter(Boolean);
  for (let depth = 0; depth < segments.length; depth++) {
    const settings = resolve(config, segments.slice(0, depth + 1).join("/"));
    if (!settings.governed) continue;
    const segment = segments[depth]!;
    if (settings.ignore.dotfiles && segment.startsWith(".")) return true;
    if (settings.ignore.pattern?.regex.test(segment)) return true;
  }
  return false;
}

function success(strict: boolean, paths: Map<string, PathEntry>): ConfigResult {
  return { ok: true, config: { strict, paths } };
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, logger: false, strict: false, strictSchema: true });
  addFormats(ajv);
  ajv.addFormat("internal-link", { type: "string", validate: isWholeWikilink });
  ajv.addFormat("datetime", { type: "string", validate: isLocalDatetime });
  return ajv;
}

function parseEntry(
  raw: Record<string, unknown>,
  location: string,
  ajv: Ajv2020,
  errors: ConfigError[],
): PathEntry {
  rejectUnknownKeys(
    raw,
    ["description", "schema", "body", "extensions", "filenames", "internal_links", "ignore"],
    location,
    errors,
  );
  const description = raw.description;
  if (description !== undefined && typeof description !== "string") {
    errors.push({ message: `${location}.description must be text` });
  }

  const entry: PathEntry = {};
  if (typeof description === "string") entry.description = description;
  if ("schema" in raw) entry.schema = compileSchema(raw.schema, `${location}.schema`, ajv, errors);
  if ("body" in raw) entry.body = parseBody(raw.body, `${location}.body`, errors);
  if ("extensions" in raw) entry.extensions = parseExtensions(raw.extensions, `${location}.extensions`, errors);
  if ("filenames" in raw) entry.filenames = parseFilenames(raw.filenames, `${location}.filenames`, errors);
  if ("internal_links" in raw) {
    entry.internal_links = parseInternalLinks(raw.internal_links, `${location}.internal_links`, errors);
  }
  if ("ignore" in raw) entry.ignore = parseIgnore(raw.ignore, `${location}.ignore`, errors);
  return entry;
}

function compileSchema(
  value: unknown,
  location: string,
  ajv: Ajv2020,
  errors: ConfigError[],
): CompiledSchema | null | undefined {
  if (value === null) return null;
  if (!isMapping(value) && typeof value !== "boolean") {
    errors.push({ message: `${location} must be a JSON Schema mapping, boolean schema, or null` });
    return undefined;
  }
  try {
    return { validate: ajv.compile(value) };
  } catch (error) {
    const reason = describe(error);
    errors.push({
      message: reason.startsWith("strict mode")
        ? `${location} rejected: ${reason}`
        : `${location} does not compile as JSON Schema: ${reason}`,
    });
    return undefined;
  }
}

function isLocalDatetime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseBody(value: unknown, location: string, errors: ConfigError[]): PathEntry["body"] {
  const raw = requireMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["allowed"], location, errors);
  return { allowed: booleanSetting(raw, "allowed", location, errors) };
}

function parseExtensions(value: unknown, location: string, errors: ConfigError[]): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push({ message: `${location} must be a list of extensions, or null` });
    return undefined;
  }
  return [...value] as string[];
}

function parseFilenames(value: unknown, location: string, errors: ConfigError[]): PathEntry["filenames"] {
  const raw = requireMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["pattern"], location, errors);
  return { pattern: compilePattern(raw, location, true, errors) };
}

function parseInternalLinks(
  value: unknown,
  location: string,
  errors: ConfigError[],
): PathEntry["internal_links"] {
  const raw = requireMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["resolve", "format"], location, errors);
  let format: InternalLinkFormat | null | undefined;
  if ("format" in raw) {
    if (
      raw.format === null ||
      (typeof raw.format === "string" && ["wikilink", "markdown-relative", "markdown-absolute"].includes(raw.format))
    ) {
      format = raw.format as InternalLinkFormat | null;
    } else errors.push({ message: `${location}.format must be wikilink, markdown-relative, markdown-absolute, or null` });
  }
  return { resolve: booleanSetting(raw, "resolve", location, errors), format };
}

function parseIgnore(value: unknown, location: string, errors: ConfigError[]): PathEntry["ignore"] {
  const raw = requireMapping(value, location, errors);
  if (raw === undefined) return {};
  rejectUnknownKeys(raw, ["dotfiles", "pattern"], location, errors);
  return {
    dotfiles: booleanSetting(raw, "dotfiles", location, errors),
    pattern: compilePattern(raw, location, false, errors),
  };
}

function booleanSetting(
  raw: Record<string, unknown>,
  key: string,
  location: string,
  errors: ConfigError[],
): boolean | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value === "boolean") return value;
  errors.push({ message: `${location}.${key} takes true or false` });
  return undefined;
}

/**
 * Compiles an entry's `pattern`. `filenames.pattern` must match a segment in
 * full and `ignore.pattern` matches anywhere in one (spec/vault.md), so the
 * anchors are added here while `source` keeps what the user wrote for the
 * finding message.
 */
function compilePattern(
  raw: Record<string, unknown>,
  location: string,
  fullMatch: boolean,
  errors: ConfigError[],
): CompiledPattern | null | undefined {
  if (!("pattern" in raw)) return undefined;
  const value = raw["pattern"];
  if (value === null) return null;
  if (typeof value !== "string") {
    errors.push({ message: `${location}.pattern must be a string or null` });
    return undefined;
  }
  try {
    return { source: value, regex: new RegExp(fullMatch ? `^(?:${value})$` : value) };
  } catch (error) {
    errors.push({ message: `${location}.pattern does not compile as a regular expression: ${describe(error)}` });
    return undefined;
  }
}

function validatePath(path: string, errors: ConfigError[]): void {
  if (!path.startsWith("/")) errors.push({ message: `${path} must start with "/"` });
  if (path !== "/" && path.endsWith("/")) errors.push({ message: `${path} must carry no trailing slash` });
  const segments = path.slice(1).split("/");
  if (path !== "/" && segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push({ message: `${path} contains an empty, ".", or ".." segment` });
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) errors.push({ message: `${path} may not contain control characters` });
}

function enclosingEntries(config: Config, relativePath: string): PathEntry[] {
  const matches: Array<[number, PathEntry]> = [];
  const comparablePath = relativePath.normalize("NFC");
  for (const [configuredPath, entry] of config.paths) {
    const root = configuredPath === "/";
    const folder = configuredPath.slice(1).normalize("NFC");
    const encloses = root ? comparablePath.length > 0 : comparablePath.startsWith(`${folder}/`);
    // NFC never changes a path's separator count, so the depth is the
    // normalized folder's — no need to re-split the raw key.
    if (encloses) matches.push([root ? 0 : folder.split("/").length, entry]);
  }
  matches.sort(([left], [right]) => right - left);
  return matches.map(([, entry]) => entry);
}

function inherited<T>(
  entries: PathEntry[],
  select: (entry: PathEntry) => T | null | undefined,
  defaultValue: T,
): T {
  for (const entry of entries) {
    const value = select(entry);
    if (value !== undefined) return value === null ? defaultValue : value;
  }
  return defaultValue;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/^\/+|\/+$/gu, "");
}

function requireMapping(
  value: unknown,
  location: string,
  errors: ConfigError[],
): Record<string, unknown> | undefined {
  if (isMapping(value)) return value;
  errors.push({ message: `${location} must be a mapping` });
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
    if (!allowed.includes(key)) {
      errors.push({ message: `${location === "" ? "" : `${location} has an `}unknown key "${key}"` });
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof YAMLException ? error.reason : error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}
