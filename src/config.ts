import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport from "ajv-formats";
import { CORE_SCHEMA, load, YAMLException } from "js-yaml";

import { isWholeMarkdownLink, isWholeWikilink } from "./references.js";

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

export type LinkFormat = "wikilink" | "markdown";
export type BodyMode = "markdown" | "raw" | "none";

export interface FolderEntry {
  path: string;
  description?: string;
  schema?: CompiledSchema;
  /** Undefined accepts every extension, including no extension. */
  extensions?: string[];
  filenamePattern?: CompiledPattern;
  body: BodyMode;
  additionalSubfolders: boolean;
}

export interface Config {
  version: 1;
  strict: boolean;
  linkFormat: LinkFormat;
  filenamePattern?: CompiledPattern;
  ignore: CompiledPattern[];
  folders: FolderEntry[];
}

interface GovernanceIndex {
  foldersByPath: Map<string, FolderEntry>;
}

const governanceIndexes = new WeakMap<Config, GovernanceIndex>();

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

/** Parses version 1 and compiles every schema and regexp before returning it. */
export function parseConfig(source: string): ConfigResult {
  let document: unknown;
  try {
    document = load(source, { schema: CORE_SCHEMA });
  } catch (error) {
    return { ok: false, errors: [{ message: `does not parse: ${describe(error)}` }] };
  }

  // The format gate wins over root-shape and all version-specific errors.
  if (!isMapping(document) || !("version" in document)) return migrationError();
  if (!Number.isInteger(document.version)) {
    return { ok: false, errors: [{ message: "version must be the integer 1" }] };
  }
  if (document.version !== 1) {
    return { ok: false, errors: [{ message: `version ${String(document.version)} is not understood` }] };
  }

  const errors: ConfigError[] = [];
  rejectUnknownKeys(
    document,
    ["version", "strict", "link_format", "filename_pattern", "ignore", "folders"],
    "",
    errors,
  );

  const strict = parseBoolean(document, "strict", false, "strict", errors);
  const linkFormat = parseLinkFormat(document.link_format, errors);
  const filenamePattern = "filename_pattern" in document
    ? compilePattern(document.filename_pattern, "filename_pattern", true, errors)
    : undefined;
  const ignore = "ignore" in document ? parseIgnore(document.ignore, errors) : [];
  const ajv = createAjv(linkFormat);
  const folders = "folders" in document ? parseFolders(document.folders, ajv, errors) : [];

  validateFolderPaths(folders, errors);
  validateDeclaredSegments(folders, filenamePattern, errors);
  validateDeclaredPathsAreVisible(folders, ignore, errors);

  if (errors.length > 0) return { ok: false, errors };
  const config: Config = {
    version: 1,
    strict,
    linkFormat,
    filenamePattern,
    ignore,
    folders,
  };
  governanceIndexes.set(config, buildGovernanceIndex(config));
  return { ok: true, config };
}

/** Ignore patterns are tested as plain matches against each path segment. */
export function isIgnored(config: Config, vaultRelativePath: string): boolean {
  return vaultRelativePath
    .split("/")
    .filter(Boolean)
    .some((segment) => config.ignore.some((pattern) => matches(pattern.regex, segment)));
}

/** Returns the most specific folder entry enclosing a file. */
export function folderEntryFor(config: Config, vaultRelativeFile: string): FolderEntry | undefined {
  const foldersByPath = governanceIndexFor(config).foldersByPath;
  let folder = posix.dirname(vaultRelativeFile.normalize("NFC"));
  while (true) {
    const entry = foldersByPath.get(folder);
    if (entry !== undefined) return entry;
    if (folder === ".") return undefined;
    const separator = folder.lastIndexOf("/");
    folder = separator < 0 ? "." : folder.slice(0, separator);
  }
}

export function declaredPaths(config: Config): string[] {
  return config.folders.map(({ path }) => path);
}

/** NFC-normalized Unicode case fold used for filesystem comparisons. */
export function caseFold(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
}

function governanceIndexFor(config: Config): GovernanceIndex {
  const existing = governanceIndexes.get(config);
  if (existing !== undefined) return existing;
  const built = buildGovernanceIndex(config);
  governanceIndexes.set(config, built);
  return built;
}

function buildGovernanceIndex(config: Config): GovernanceIndex {
  return {
    foldersByPath: new Map(config.folders.map((entry) => [entry.path.normalize("NFC"), entry])),
  };
}

function migrationError(): ConfigResult {
  return {
    ok: false,
    errors: [{ message: "version is required; migrate this pre-versioned config to version 1" }],
  };
}

function parseBoolean(
  mapping: Record<string, unknown>,
  key: string,
  fallback: boolean,
  location: string,
  errors: ConfigError[],
): boolean {
  if (!(key in mapping)) return fallback;
  if (typeof mapping[key] === "boolean") return mapping[key];
  errors.push({ message: `${location} takes true or false` });
  return fallback;
}

function parseLinkFormat(value: unknown, errors: ConfigError[]): LinkFormat {
  if (value === undefined) return "wikilink";
  if (value === "wikilink" || value === "markdown") return value;
  errors.push({ message: "link_format must be wikilink or markdown" });
  return "wikilink";
}

function createAjv(linkFormat: LinkFormat): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, logger: false, strict: false, strictSchema: true });
  addFormats(ajv);
  ajv.addFormat("internal-link", {
    type: "string",
    validate: linkFormat === "wikilink" ? isWholeWikilink : isWholeMarkdownLink,
  });
  ajv.addFormat("datetime", { type: "string", validate: isLocalDatetime });
  return ajv;
}

function parseIgnore(value: unknown, errors: ConfigError[]): CompiledPattern[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push({ message: "ignore must be a list of regular expression strings" });
    return [];
  }
  return value.flatMap((pattern, index) => {
    const compiled = compilePattern(pattern, `ignore[${index}]`, false, errors);
    return compiled === undefined ? [] : [compiled];
  });
}

function parseFolders(value: unknown, ajv: Ajv2020, errors: ConfigError[]): FolderEntry[] {
  if (!Array.isArray(value)) {
    errors.push({ message: "folders must be a list of entries" });
    return [];
  }

  const entries: FolderEntry[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!isMapping(raw)) {
      errors.push({ message: `folders[${index}] must be a mapping` });
      continue;
    }

    const rawPath = raw.path;
    const fallback = `folders[${index}]`;
    const location = typeof rawPath === "string" ? `folders ${rawPath}` : fallback;
    rejectUnknownKeys(
      raw,
      ["path", "description", "schema", "extensions", "filename_pattern", "body", "additional_subfolders"],
      location,
      errors,
    );
    if (!("path" in raw)) {
      errors.push({ message: `${fallback}.path is required` });
      continue;
    }
    if (typeof rawPath !== "string") {
      errors.push({ message: `${fallback}.path must be text` });
      continue;
    }

    validateDeclaredPath(rawPath, location, errors);
    const entry: FolderEntry = {
      path: rawPath,
      body: parseBody(raw.body, "body" in raw, `${location}.body`, errors),
      additionalSubfolders: parseBoolean(
        raw,
        "additional_subfolders",
        true,
        `${location}.additional_subfolders`,
        errors,
      ),
    };

    if ("description" in raw) {
      if (typeof raw.description === "string") entry.description = raw.description;
      else errors.push({ message: `${location}.description must be text` });
    }
    if ("schema" in raw) entry.schema = compileSchema(raw.schema, `${location}.schema`, ajv, errors);
    if ("extensions" in raw) entry.extensions = parseExtensions(raw.extensions, location, errors);
    if ("filename_pattern" in raw) {
      entry.filenamePattern = compilePattern(raw.filename_pattern, `${location}.filename_pattern`, true, errors);
    }
    entries.push(entry);
  }
  return entries;
}

function parseBody(value: unknown, present: boolean, location: string, errors: ConfigError[]): BodyMode {
  if (!present) return "markdown";
  if (value === "markdown" || value === "raw" || value === "none") return value;
  errors.push({ message: `${location} must be markdown, raw, or none` });
  return "markdown";
}

function parseExtensions(value: unknown, location: string, errors: ConfigError[]): string[] | undefined {
  if (
    !Array.isArray(value)
    || value.some((extension) =>
      typeof extension !== "string"
      || extension.length === 0
      || (extension !== "*" && (
        extension.includes(".")
        || extension !== extension.toLocaleLowerCase("en-US")
      )))
  ) {
    errors.push({ message: `${location}.extensions must be a list of lowercase, dot-less extensions` });
    return undefined;
  }
  if (value.includes("*") && value.length !== 1) {
    errors.push({ message: `${location}.extensions wildcard must be its only entry` });
    return undefined;
  }
  return value[0] === "*" ? undefined : (value as string[]).map(caseFold);
}

function compileSchema(
  value: unknown,
  location: string,
  ajv: Ajv2020,
  errors: ConfigError[],
): CompiledSchema | undefined {
  if (!isMapping(value) && typeof value !== "boolean") {
    errors.push({ message: `${location} must be a JSON Schema mapping or boolean schema` });
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

function compilePattern(
  value: unknown,
  location: string,
  fullMatch: boolean,
  errors: ConfigError[],
): CompiledPattern | undefined {
  if (typeof value !== "string") {
    errors.push({ message: `${location} must be a regular expression string` });
    return undefined;
  }
  try {
    return {
      source: value,
      regex: new RegExp(fullMatch ? `^(?:${value})$(?![\\s\\S])` : value),
    };
  } catch (error) {
    errors.push({ message: `${location} does not compile as a regular expression: ${describe(error)}` });
    return undefined;
  }
}

function validateDeclaredPath(path: string, location: string, errors: ConfigError[]): void {
  const segments = path.split("/");
  if (
    path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || (path !== "." && segments.some((segment) => segment === "" || segment === "." || segment === ".."))
  ) {
    errors.push({ message: `${location} must be a valid vault-relative path` });
  }
}

function validateFolderPaths(entries: readonly FolderEntry[], errors: ConfigError[]): void {
  const seen = new Map<string, FolderEntry>();
  for (const entry of entries) {
    const key = canonical(entry.path);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, entry);
      continue;
    }
    if (prior.path === entry.path) {
      errors.push({ message: `folders ${entry.path} is declared more than once` });
    } else {
      errors.push({
        message: `folders ${prior.path} and folders ${entry.path} differ only by case or Unicode normalization`,
      });
    }
  }
}

function validateDeclaredSegments(
  entries: readonly FolderEntry[],
  filenamePattern: CompiledPattern | undefined,
  errors: ConfigError[],
): void {
  if (filenamePattern === undefined) return;
  for (const entry of entries) {
    if (entry.path === ".") continue;
    for (const segment of entry.path.split("/")) {
      if (matches(filenamePattern.regex, segment)) continue;
      errors.push({
        message: `${segment} in folders ${entry.path} does not match filename_pattern ${JSON.stringify(filenamePattern.source)}`,
      });
    }
  }
}

function validateDeclaredPathsAreVisible(
  entries: readonly FolderEntry[],
  ignore: readonly CompiledPattern[],
  errors: ConfigError[],
): void {
  for (const entry of entries) {
    if (entry.path === ".") continue;
    for (const segment of entry.path.split("/")) {
      const pattern = ignore.find((candidate) => matches(candidate.regex, segment));
      if (pattern === undefined) continue;
      errors.push({
        message: `folders ${entry.path} is hidden by ignore pattern ${JSON.stringify(pattern.source)}`,
      });
      break;
    }
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

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function canonical(path: string): string {
  return caseFold(path);
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
    if (allowed.includes(key)) continue;
    errors.push({ message: `${location === "" ? "" : `${location} has an `}unknown key ${JSON.stringify(key)}` });
  }
}

function describe(error: unknown): string {
  const message = error instanceof YAMLException ? error.reason : error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}
