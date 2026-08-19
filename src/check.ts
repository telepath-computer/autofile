import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_SCHEMA, load, YAMLException } from "js-yaml";

import {
  folderEntryFor,
  isIgnored,
  loadConfig,
  type Config,
  type FolderEntry,
} from "./config.js";
import { sortFindings, type Finding } from "./findings.js";
import {
  buildIndex,
  resolveMarkdownReference,
  resolvesWikilink,
  type ReferenceIndex,
} from "./references.js";
import {
  additionalSubfolderFinding,
  collisionFindings,
  coverageFinding,
  isNote,
  recordFindings,
  recordReferences,
  type ParsedRecord,
} from "./rules.js";

export type { Finding, Rule, Severity } from "./findings.js";

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
      findings.push(coverageFinding(file));
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
  if (!isNote(file)) {
    findings.push(...recordFindings(config, entry, file, {}));
    return;
  }

  let content: string;
  try {
    content = await readFile(join(root, file), "utf8");
  } catch (error) {
    findings.push(...recordFindings(config, entry, file, {}));
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

  const record: ParsedRecord = { fields: parsed ? frontmatter : undefined, body };
  findings.push(...recordFindings(config, entry, file, record));
  checkResolutions(file, entry, record, referenceIndex, findings);
}

function checkResolutions(
  file: string,
  entry: FolderEntry,
  record: ParsedRecord,
  index: ReferenceIndex,
  findings: Finding[],
): void {
  for (const reference of recordReferences(entry, record)) {
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
    if (entry === undefined) continue;
    const finding = additionalSubfolderFinding(entry, folder);
    if (finding !== undefined) findings.push(finding);
  }
}

function checkCollisions(governedFiles: readonly string[], findings: Finding[]): void {
  findings.push(...collisionFindings(governedFiles));
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

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  const message = error instanceof YAMLException ? error.reason : error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}
