import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ErrorObject } from "ajv";
import { CORE_SCHEMA, load, YAMLException } from "js-yaml";

import { isIgnored, loadConfig, resolve, type Config, type EffectiveSettings } from "./config.js";
import {
  buildIndex,
  extractReferences,
  resolveReference,
  type Reference,
  type ReferenceIndex,
} from "./references.js";

export type Rule =
  | "config"
  | "schema"
  | "body.allowed"
  | "extensions"
  | "filenames.pattern"
  | "internal_links.format"
  | "strict"
  | "parse"
  | "name"
  | "collision"
  | "internal_links.resolve"
  | "missing";

export type Severity = "violation" | "warning";

export interface Finding {
  rule: Rule;
  severity: Severity;
  /**
   * Vault-relative path — a file, or the folder a declared path names for an
   * `missing` finding — or autofile.yml for a config finding.
   */
  file: string;
  message: string;
}

export interface CheckResult {
  findings: Finding[];
  /** The number of governed, non-ignored files. */
  filesChecked: number;
}

export interface CheckOptions {
  /** Called once per governed file with the running governed-file count. */
  onFile?: (count: number) => void;
}

export async function check(vaultRoot: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const loaded = await loadConfig(join(vaultRoot, "autofile.yml"));
  if (!loaded.ok) {
    return {
      findings: [{
        rule: "config",
        severity: "violation",
        file: "autofile.yml",
        message: loaded.errors.map((error) => error.message).join("; "),
      }],
      filesChecked: 0,
    };
  }

  const allFiles: string[] = [];
  const allFolders: string[] = [];
  await walk(vaultRoot, "", allFiles, allFolders);
  const config = loaded.config;
  const referenceFiles = allFiles.filter((file) => file !== "autofile.yml");
  const referenceIndex = buildIndex(referenceFiles);
  // An ignored path is invisible to every rule, so the walk is filtered once
  // here rather than re-tested rule by rule.
  const visibleFiles = referenceFiles.filter((file) => !isIgnored(config, file));
  const governedFiles: string[] = [];
  const findings: Finding[] = [];

  for (const file of visibleFiles) {
    const settings = resolve(config, file);
    if (!settings.governed) continue;
    governedFiles.push(file);
    opts.onFile?.(governedFiles.length);
    if (config.strict && !settings.declared) {
      findings.push({ rule: "strict", severity: "violation", file, message: "is under no declared path" });
    }
    checkNames(file, findings);
    checkFilenamePattern(config, file, findings);
    checkExtension(file, settings, findings);
    if (isNote(file)) await checkNote(vaultRoot, file, settings, referenceIndex, findings);
  }

  checkCollisions(governedFiles, findings);
  checkMissing(config, allFolders, findings);
  return { findings: sortFindings(findings), filesChecked: governedFiles.length };
}

async function walk(root: string, parent: string, files: string[], folders: string[]): Promise<void> {
  const directory = join(root, parent);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read directory "${directory}": ${describe(error)}`);
  }
  entries.sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    // Symlinks are not vault content and traversing directory links could
    // escape the vault or introduce cycles.
    if (entry.isSymbolicLink()) continue;
    const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
    if (entry.isDirectory()) {
      folders.push(path);
      await walk(root, path, files, folders);
    } else if (entry.isFile()) files.push(path);
  }
}

/**
 * The `name` rule: segments a filesystem can carry. Spelled as spec/vault.md
 * states it, though only the control-character clause is reachable from the
 * walk — readdir yields no empty, `.`, or `..` entry.
 */
function checkNames(file: string, findings: Finding[]): void {
  for (const segment of file.split("/")) {
    if (/^[.]{1,2}$/u.test(segment) || segment === "" || /[\u0000-\u001f\u007f]/u.test(segment)) {
      findings.push({
        rule: "name",
        severity: "violation",
        file,
        message: `path segment ${JSON.stringify(segment)} is not a name every filesystem can carry`,
      });
    }
  }
}

/** The `filenames.pattern` rule, under the entry reaching each segment. */
function checkFilenamePattern(config: Config, file: string, findings: Finding[]): void {
  const segments = file.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const pattern = resolve(config, segments.slice(0, index + 1).join("/")).filenames.pattern;
    if (pattern === undefined) continue;
    const subject = index === segments.length - 1 ? stripExtension(segment) : segment;
    if (!pattern.regex.test(subject)) {
      findings.push({
        rule: "filenames.pattern",
        severity: "violation",
        file,
        message: `${JSON.stringify(subject)} does not match ${JSON.stringify(pattern.source)}`,
      });
    }
  }
}

function checkExtension(file: string, settings: EffectiveSettings, findings: Finding[]): void {
  if (settings.extensions === undefined) return;
  const extension = nameExtension(posix.basename(file));
  if (extension === undefined || !settings.extensions.includes(extension)) {
    findings.push({
      rule: "extensions",
      severity: "violation",
      file,
      message: `${extension === undefined ? "no extension" : `.${extension}`} is not among the extensions this path holds`,
    });
  }
}

async function checkNote(
  root: string,
  file: string,
  settings: EffectiveSettings,
  referenceIndex: ReferenceIndex,
  findings: Finding[],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(root, file), "utf8");
  } catch (error) {
    findings.push({ rule: "parse", severity: "violation", file, message: `cannot be read: ${describe(error)}` });
    return;
  }
  const { frontmatterSource, body } = splitNote(content);
  let frontmatter: unknown = {};
  let parsed = true;
  if (frontmatterSource !== undefined) {
    try {
      frontmatter = frontmatterSource.trim() === "" ? {} : load(frontmatterSource, { schema: CORE_SCHEMA });
      if (!isMapping(frontmatter)) {
        parsed = false;
        findings.push({ rule: "parse", severity: "violation", file, message: "frontmatter is not a mapping" });
      }
    } catch (error) {
      parsed = false;
      findings.push({ rule: "parse", severity: "violation", file, message: `frontmatter is not valid YAML: ${describe(error)}` });
    }
  }
  if (parsed && settings.schema !== undefined && !settings.schema.validate(frontmatter)) {
    for (const error of settings.schema.validate.errors ?? []) {
      findings.push({ rule: "schema", severity: "violation", file, message: translateSchemaError(error) });
    }
  }
  if (!settings.body.allowed && body.trim() !== "") {
    findings.push({ rule: "body.allowed", severity: "violation", file, message: "body is not allowed" });
  }
  checkLinks(file, parsed ? frontmatter : undefined, body, settings, referenceIndex, findings);
}

function checkLinks(
  file: string,
  frontmatter: unknown,
  body: string,
  settings: EffectiveSettings,
  referenceIndex: ReferenceIndex,
  findings: Finding[],
): void {
  const typedReferences = extractReferences(frontmatter, "");
  const proseReferences = extractReferences(undefined, body);
  // internal_links.format governs how a link is written in prose only, so it
  // applies to the body's references; both kinds must resolve.
  const format = settings.internal_links.format;
  if (format !== undefined) {
    for (const reference of proseReferences) {
      if (hasFormat(reference, format)) continue;
      findings.push({
        rule: "internal_links.format",
        severity: "violation",
        file,
        message: `${reference.asWritten} is not ${format}`,
      });
    }
  }
  if (settings.internal_links.resolve) {
    for (const reference of [...typedReferences, ...proseReferences]) {
      if (resolveReference(reference.target, file, referenceIndex) !== undefined) continue;
      findings.push({
        rule: "internal_links.resolve",
        severity: "warning",
        file,
        message: `${reference.asWritten} does not exist`,
      });
    }
  }
}

function hasFormat(reference: Reference, format: NonNullable<EffectiveSettings["internal_links"]["format"]>): boolean {
  if (/^!?\[\[/u.test(reference.asWritten)) return format === "wikilink";
  if (format === "wikilink") return false;
  return format === (reference.target.startsWith("/") ? "markdown-absolute" : "markdown-relative");
}

// Every governed file survived isIgnored, and ignoring is decided per
// segment against the rules reaching it, so no ancestor of one can be
// ignored either — the folders collected here need no further filtering.
function checkCollisions(governedFiles: readonly string[], findings: Finding[]): void {
  const paths = new Set<string>();
  for (const file of governedFiles) {
    paths.add(file);
    const segments = file.split("/");
    for (let length = 1; length < segments.length; length++) paths.add(segments.slice(0, length).join("/"));
  }
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(compare);
    for (const path of group) {
      const others = group.filter((candidate) => candidate !== path).map((candidate) => JSON.stringify(candidate));
      findings.push({ rule: "collision", severity: "violation", file: path, message: `collides with ${others.join(", ")}` });
    }
  }
}

function checkMissing(config: Config, folders: readonly string[], findings: Finding[]): void {
  const normalizedFolders = folders.map((path) => path.normalize("NFC"));
  for (const configuredPath of config.paths.keys()) {
    const folder = configuredPath.slice(1);
    const display = configuredPath === "/" ? "/" : folder;
    const normalizedFolder = folder.normalize("NFC");
    const exists = configuredPath === "/" || normalizedFolders.includes(normalizedFolder);
    if (!exists) {
      findings.push({
        rule: "missing",
        severity: "warning",
        file: display,
        message: "declared path is missing",
      });
    }
  }
}

function splitNote(content: string): { frontmatterSource?: string; body: string } {
  const withoutBom = content.replace(/^\uFEFF/u, "");
  const lines = withoutBom.split(/\r?\n/u);
  if (lines[0] !== "---") return { body: withoutBom };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { body: withoutBom };
  return { frontmatterSource: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n") };
}

function translateSchemaError(error: ErrorObject): string {
  const path = error.instancePath.split("/").filter(Boolean).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).join(".");
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") return `${path === "" ? "" : `${path}.`}${String(params["missingProperty"])} is required`;
  if (error.keyword === "type") return `${path || "frontmatter"} must be ${article(String(params["type"]))}`;
  if (error.keyword === "additionalProperties") return `${path === "" ? "" : `${path}.`}${String(params["additionalProperty"])} is not an allowed field`;
  return `${path || "frontmatter"} ${error.message ?? "is invalid"}`;
}

function article(type: string): string {
  if (type === "integer" || type === "object" || type === "array") return `an ${type}`;
  if (type === "null") return "null";
  return `a ${type}`;
}

function isNote(file: string): boolean {
  return nameExtension(posix.basename(file)) === "md";
}

function stripExtension(name: string): string {
  const extension = nameExtension(name);
  return extension === undefined ? name : name.slice(0, -(extension.length + 1));
}

function nameExtension(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const severityRank: Record<Severity, number> = { violation: 0, warning: 1 };

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || compare(left.file, right.file)
    || compare(left.rule, right.rule)
    || compare(left.message, right.message));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  const message = error instanceof YAMLException ? error.reason : error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}
