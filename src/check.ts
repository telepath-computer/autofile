import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ErrorObject } from "ajv";
import { CORE_SCHEMA, load, YAMLException } from "js-yaml";

import {
  caseFold,
  folderEntryFor,
  isIgnored,
  loadConfig,
  type Config,
  type FolderEntry,
} from "./config.js";
import {
  buildIndex,
  extractReferences,
  resolveMarkdownReference,
  resolvesWikilink,
  type ReferenceIndex,
} from "./references.js";

export type Rule =
  | "config"
  | "coverage"
  | "parse"
  | "schema"
  | "body"
  | "filename_pattern"
  | "extensions"
  | "additional_subfolders"
  | "description"
  | "link_format"
  | "resolve"
  | "collision"
  | "missing";

export type Severity = "violation" | "warning";

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** Vault-relative file or declared folder path, or autofile.yml. */
  file: string;
  message: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Governed files, plus coverage failures when strict. */
  filesChecked: number;
}

export interface CheckOptions {
  /** Called once per counted file with the running checked-file count. */
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
        message: loaded.errors.map(({ message }) => message).join("; "),
      }],
      filesChecked: 0,
    };
  }

  const allFiles: string[] = [];
  const allFolders: string[] = [];
  await walk(vaultRoot, "", allFiles, allFolders);

  const config = loaded.config;
  // Ignored and out-of-scope files remain valid targets, so the index is
  // built from the complete file walk before governance filters it.
  const referenceIndex = buildIndex(allFiles);
  const governedFiles: string[] = [];
  const findings: Finding[] = [];
  let filesChecked = 0;

  checkDescriptions(config, findings);
  checkMissing(config, allFolders, findings);
  checkAdditionalSubfolders(config, allFolders, findings);

  for (const file of allFiles) {
    if (file === "autofile.yml" || isIgnored(config, file)) continue;
    const entry = folderEntryFor(config, file);
    if (entry === undefined) {
      if (!config.strict) continue;
      filesChecked++;
      opts.onFile?.(filesChecked);
      findings.push({
        rule: "coverage",
        severity: "violation",
        file,
        message: "no folder entry accounts for this file",
      });
      continue;
    }

    filesChecked++;
    opts.onFile?.(filesChecked);
    governedFiles.push(file);
    await checkFolderFile(vaultRoot, file, entry, config, referenceIndex, findings);
  }

  checkCollisions(governedFiles, findings);
  return { findings: sortFindings(findings), filesChecked };
}

async function walk(root: string, parent: string, files: string[], folders: string[]): Promise<void> {
  const directory = join(root, parent);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read directory ${JSON.stringify(directory)}: ${describe(error)}`);
  }
  entries.sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    // Links are neither vault content nor safe traversal roots.
    if (entry.isSymbolicLink()) continue;
    const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
    if (entry.isDirectory()) {
      folders.push(path);
      await walk(root, path, files, folders);
    } else if (entry.isFile()) files.push(path);
  }
}

async function checkFolderFile(
  root: string,
  file: string,
  entry: FolderEntry,
  config: Config,
  referenceIndex: ReferenceIndex,
  findings: Finding[],
): Promise<void> {
  const note = isNote(file);
  const pattern = entry.filenamePattern ?? (note ? config.filenamePattern : undefined);
  if (pattern !== undefined) {
    const filename = stripExtension(posix.basename(file));
    if (!matches(pattern.regex, filename)) {
      findings.push({
        rule: "filename_pattern",
        severity: "violation",
        file,
        message: `${JSON.stringify(filename)} does not match ${JSON.stringify(pattern.source)}`,
      });
    }
  }

  checkExtensions(file, entry, findings);
  if (!note) return;

  let content: string;
  try {
    content = await readFile(join(root, file), "utf8");
  } catch (error) {
    findings.push({ rule: "parse", severity: "violation", file, message: `cannot be read: ${describe(error)}` });
    return;
  }

  const { frontmatterSource, body } = splitRecord(content);
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
      findings.push({
        rule: "parse",
        severity: "violation",
        file,
        message: `frontmatter is not valid YAML: ${describe(error)}`,
      });
    }
  }

  if (parsed && entry.schema !== undefined && !entry.schema.validate(frontmatter)) {
    for (const error of entry.schema.validate.errors ?? []) {
      findings.push({ rule: "schema", severity: "violation", file, message: translateSchemaError(error) });
    }
  }
  if (entry.body === "none" && body.trim() !== "") {
    findings.push({ rule: "body", severity: "violation", file, message: "body is not allowed" });
  }
  checkReferences(
    file,
    parsed ? frontmatter : undefined,
    entry.body === "raw" ? "" : body,
    config,
    referenceIndex,
    findings,
  );
}

function checkReferences(
  file: string,
  frontmatter: unknown,
  body: string,
  config: Config,
  index: ReferenceIndex,
  findings: Finding[],
): void {
  for (const reference of extractReferences(frontmatter, body)) {
    let formatMessage: string | undefined;
    if (reference.syntax !== config.linkFormat) {
      formatMessage = `${reference.asWritten} must use ${config.linkFormat} format`;
    } else if (reference.syntax === "markdown" && reference.rooted === true) {
      formatMessage = `${reference.asWritten} must use a relative markdown target`;
    }
    if (formatMessage !== undefined) {
      findings.push({ rule: "link_format", severity: "violation", file, message: formatMessage });
    }

    const resolved = reference.syntax === "wikilink"
      ? resolvesWikilink(reference.target, index)
      : resolveMarkdownReference(reference.target, file, index, reference.rooted === true);
    if (!resolved) {
      findings.push({
        rule: "resolve",
        severity: "warning",
        file,
        message: `${reference.asWritten} does not exist`,
      });
    }
  }
}

function checkExtensions(file: string, entry: FolderEntry, findings: Finding[]): void {
  if (entry.extensions === undefined) return;
  const extension = nameExtension(posix.basename(file));
  if (extension !== undefined && entry.extensions.includes(caseFold(extension))) return;
  findings.push({
    rule: "extensions",
    severity: "violation",
    file,
    message: `${extension ?? "no extension"} is not among the extensions this folder accepts`,
  });
}

function checkDescriptions(config: Config, findings: Finding[]): void {
  for (const entry of config.folders) {
    if (entry.description !== undefined) continue;
    findings.push({
      rule: "description",
      severity: "warning",
      file: entry.path,
      message: "folder entry has no description",
    });
  }
}

function checkMissing(config: Config, folders: readonly string[], findings: Finding[]): void {
  const normalizedFolders = new Set(folders.map((folder) => folder.normalize("NFC")));
  normalizedFolders.add(".");
  for (const entry of config.folders) {
    if (normalizedFolders.has(entry.path.normalize("NFC"))) continue;
    findings.push({ rule: "missing", severity: "warning", file: entry.path, message: "declared path is missing" });
  }
}

function checkAdditionalSubfolders(config: Config, folders: readonly string[], findings: Finding[]): void {
  for (const folder of folders) {
    if (isIgnored(config, folder)) continue;
    const entry = folderEntryFor(config, `${folder}/.autofile-folder`);
    if (entry === undefined || entry.additionalSubfolders || entry.path.normalize("NFC") === folder.normalize("NFC")) {
      continue;
    }
    findings.push({
      rule: "additional_subfolders",
      severity: "violation",
      file: folder,
      message: `subfolder is not allowed by folders ${entry.path}`,
    });
  }
}

function checkCollisions(governedFiles: readonly string[], findings: Finding[]): void {
  const paths = new Set<string>();
  for (const file of governedFiles) {
    paths.add(file);
    const segments = file.split("/");
    for (let length = 1; length < segments.length; length++) {
      paths.add(segments.slice(0, length).join("/"));
    }
  }

  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = canonical(path);
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

function splitRecord(content: string): { frontmatterSource?: string; body: string } {
  const withoutBom = content.replace(/^\uFEFF/u, "");
  const lines = withoutBom.split(/\r?\n/u);
  if (lines[0] !== "---") return { body: withoutBom };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { body: withoutBom };
  return {
    frontmatterSource: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

function translateSchemaError(error: ErrorObject): string {
  const path = error.instancePath
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") {
    return `${path === "" ? "" : `${path}.`}${String(params["missingProperty"])} is required`;
  }
  if (error.keyword === "type") return `${path || "frontmatter"} must be ${article(String(params["type"]))}`;
  if (error.keyword === "additionalProperties") {
    return `${path === "" ? "" : `${path}.`}${String(params["additionalProperty"])} is not an allowed field`;
  }
  return `${path || "frontmatter"} ${error.message ?? "is invalid"}`;
}

function article(type: string): string {
  if (type === "integer" || type === "object" || type === "array") return `an ${type}`;
  if (type === "null") return "null";
  return `a ${type}`;
}

function nameExtension(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : undefined;
}

function stripExtension(name: string): string {
  const extension = nameExtension(name);
  return extension === undefined ? name : name.slice(0, -(extension.length + 1));
}

function isNote(file: string): boolean {
  return nameExtension(posix.basename(file)) === "md";
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
