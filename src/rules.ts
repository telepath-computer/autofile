import { posix } from "node:path";

import type { ErrorObject } from "ajv";

import {
  caseFold,
  folderEntryFor,
  isIgnored,
  type Config,
  type FolderEntry,
} from "./config.js";
import { sortFindings, type Finding } from "./findings.js";
import { extractReferences, type Reference } from "./references.js";

export interface ParsedRecord {
  /** Undefined when `check` could not parse frontmatter. */
  fields?: unknown;
  body?: string;
}

export interface ProspectiveRecord {
  /** Vault-relative API path, without the `.md` extension. */
  path: string;
  fields: Record<string, unknown>;
  body?: string;
}

/**
 * Applies every rule that judges one parsed record. `file` is the actual
 * vault-relative filename, including its extension.
 */
export function recordFindings(
  config: Config,
  entry: FolderEntry,
  file: string,
  record: ParsedRecord,
): Finding[] {
  const findings: Finding[] = [];
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
  if (!note) return findings;

  if (record.fields !== undefined && entry.schema !== undefined && !entry.schema.validate(record.fields)) {
    for (const error of entry.schema.validate.errors ?? []) {
      findings.push({ rule: "schema", severity: "violation", file, message: translateSchemaError(error) });
    }
  }
  const body = record.body ?? "";
  if (entry.body === "none" && body.trim() !== "") {
    findings.push({ rule: "body", severity: "violation", file, message: "body is not allowed" });
  }
  for (const reference of recordReferences(entry, record)) {
    let message: string | undefined;
    if (reference.syntax !== config.linkFormat) {
      message = `${reference.asWritten} must use ${config.linkFormat} format`;
    } else if (reference.syntax === "markdown" && reference.rooted === true) {
      message = `${reference.asWritten} must use a relative markdown target`;
    }
    if (message !== undefined) {
      findings.push({ rule: "link_format", severity: "violation", file, message });
    }
  }
  return findings;
}

/** References visible to record rules; raw bodies are deliberately opaque. */
export function recordReferences(entry: FolderEntry, record: ParsedRecord): Reference[] {
  return extractReferences(record.fields, entry.body === "raw" ? "" : (record.body ?? ""));
}

/**
 * Validates an extensionless API record as the `<path>.md` file a write
 * would produce. `governedPaths` contains vault-relative file paths,
 * including extensions, from the server's governed-record index.
 */
export function writeFindings(
  config: Config,
  record: ProspectiveRecord,
  governedPaths: Iterable<string>,
): Finding[] {
  const file = `${record.path}.md`;
  if (isIgnored(config, file)) return [];

  const entry = folderEntryFor(config, file);
  if (entry === undefined) {
    return config.strict ? [coverageFinding(file)] : [];
  }

  const findings = recordFindings(config, entry, file, record);
  checkProspectiveSubfolders(file, entry, findings);
  checkProspectiveCollisions(file, governedPaths, findings);
  return sortFindings(findings);
}

export function isNote(file: string): boolean {
  return nameExtension(posix.basename(file)) === "md";
}

export function coverageFinding(file: string): Finding {
  return {
    rule: "coverage",
    severity: "violation",
    file,
    message: "no folder entry accounts for this file",
  };
}

export function additionalSubfolderFinding(entry: FolderEntry, folder: string): Finding | undefined {
  if (entry.additionalSubfolders || entry.path.normalize("NFC") === folder.normalize("NFC")) return undefined;
  return {
    rule: "additional_subfolders",
    severity: "violation",
    file: folder,
    message: `subfolder is not allowed by folders ${entry.path}`,
  };
}

/** Reports every collision in a complete set of governed file paths. */
export function collisionFindings(governedPaths: Iterable<string>): Finding[] {
  const groups = new Map<string, string[]>();
  for (const path of pathsWithAncestors(governedPaths)) {
    const key = caseFold(path);
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(compare);
    for (const path of group) {
      const others = group.filter((candidate) => candidate !== path).map((candidate) => JSON.stringify(candidate));
      findings.push({ rule: "collision", severity: "violation", file: path, message: `collides with ${others.join(", ")}` });
    }
  }
  return findings;
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

function checkProspectiveSubfolders(file: string, entry: FolderEntry, findings: Finding[]): void {
  if (entry.additionalSubfolders) return;
  const folderSegments = posix.dirname(file).split("/").filter((segment) => segment !== ".");
  const entryDepth = entry.path === "." ? 0 : entry.path.split("/").length;
  for (let depth = entryDepth + 1; depth <= folderSegments.length; depth++) {
    const finding = additionalSubfolderFinding(entry, folderSegments.slice(0, depth).join("/"));
    if (finding !== undefined) findings.push(finding);
  }
}

function checkProspectiveCollisions(
  file: string,
  governedPaths: Iterable<string>,
  findings: Finding[],
): void {
  const prospectivePaths = pathsWithAncestors([file]);
  const completePaths = [...governedPaths, file];
  findings.push(...collisionFindings(completePaths).filter(({ file: path }) => prospectivePaths.has(path)));
}

function pathsWithAncestors(paths: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const path of paths) {
    expanded.add(path);
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length++) {
      expanded.add(segments.slice(0, length).join("/"));
    }
  }
  return expanded;
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

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
