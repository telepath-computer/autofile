import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ErrorObject } from "ajv";
import { load } from "js-yaml";

import { loadConfig, resolve, type Config, type RecordsBlock } from "./config.js";
import { candidatePath, extractReferences } from "./references.js";

// The findings engine: walks a vault and returns findings as data, in a
// deterministic order — violations before warnings, then by file, then by
// rule. Output formatting is the CLI's job. Symlinks are never followed:
// a symlink is neither checked nor counted.

export type Rule =
  | "config"
  | "parse"
  | "schema"
  | "body"
  | "asset"
  | "root"
  | "filename"
  | "collision"
  | "empty"
  | "reference";

export type Severity = "violation" | "warning";

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** Vault-relative path; absent on findings about the config itself. */
  file?: string;
  message: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Files checked — ignored files and the config aside (spec/cli.md). */
  filesChecked: number;
}

/**
 * Checks the vault at `vaultRoot` and returns its findings as data.
 * `onFile`, when given, is called once per checked file with the running
 * count — the CLI's loading state ("Checking… N files") hangs off it.
 */
export async function check(
  vaultRoot: string,
  opts: { onFile?: (count: number) => void } = {},
): Promise<CheckResult> {
  const loaded = await loadConfig(join(vaultRoot, "autofile.yml"));
  if (!loaded.ok) {
    // An invalid config makes the vault invalid; nothing else is checked
    // until it is fixed (spec/vault.md).
    const findings = loaded.errors.map<Finding>((error) => ({
      rule: "config",
      severity: "violation",
      message: error.message,
    }));
    return { findings: sortFindings(findings), filesChecked: 0 };
  }
  const config = loaded.config;

  const files: string[] = [];
  const folders: string[] = [];
  await walk(vaultRoot, "", config, files, folders);

  const findings: Finding[] = [];
  // Reference resolution hits the disk, not the walked file list, because
  // an ignored file exists — a reference to it is not dangling. The cache
  // spans the run, so a target shared across records is stated once.
  const existsCache = new Map<string, boolean>();
  for (const [index, file] of files.entries()) {
    opts.onFile?.(index + 1);
    checkFilename(config, file, findings);
    const blocks = resolve(config, file);
    // A record is a `.md` file whose name does not begin with a dot: a
    // dot-leading name resolves literally, so no reference could reach it
    // as a record (spec/vault.md). Dot-leading `.md` files — ".md" itself
    // included — answer to asset rules and are never parse-, schema-,
    // body-, or reference-checked.
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (name.endsWith(".md") && !name.startsWith(".")) {
      let content: string | undefined;
      try {
        content = await readFile(join(vaultRoot, file), "utf8");
      } catch (error) {
        // A governed record that cannot be read is a parse violation; an
        // ungoverned one has nothing to violate and nothing to scan.
        if (blocks.records !== undefined) {
          findings.push({
            rule: "parse",
            severity: "violation",
            file,
            message: `cannot be read: ${describe(error)}`,
          });
        }
      }
      if (content !== undefined) {
        // Only a record an entry governs has anything to violate; every
        // record's references are checked (spec/vault.md).
        if (blocks.records !== undefined) {
          checkRecord(file, content, blocks.records, findings);
        }
        await checkReferences(vaultRoot, file, content, existsCache, findings);
      }
    } else if (blocks.assets?.allowed === false) {
      findings.push({
        rule: "asset",
        severity: "violation",
        file,
        message: "not a record, in a path that forbids assets",
      });
    }
  }
  checkRoot(config, files, folders, findings);
  checkCollisions(files, folders, findings);
  checkEmpty(config, files, folders, findings);

  return { findings: sortFindings(findings), filesChecked: files.length };
}

/**
 * Collects the vault's visible files and folders, vault-relative. Ignored
 * names prune their whole subtree, the config file is carved out, and
 * symlinks are skipped.
 */
async function walk(
  vaultRoot: string,
  parent: string,
  config: Config,
  files: string[],
  folders: string[],
): Promise<void> {
  const dir = join(vaultRoot, parent);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // An unreadable directory is an environment error, not vault content:
    // unlike an unreadable file, which yields a `parse` finding, the
    // failure is thrown for the CLI to report on stderr.
    throw new Error(`cannot read directory "${dir}": ${describe(error)}`);
  }
  entries.sort((a, b) => compare(a.name, b.name));
  for (const entry of entries) {
    const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
    if (path === "autofile.yml") continue;
    // The ignore pattern in force at this location — a plain match on the
    // name ignores the whole subtree (spec/vault.md).
    const ignore = resolve(config, path).ignore?.pattern;
    if (ignore !== undefined && ignore.regex.test(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      folders.push(path);
      await walk(vaultRoot, path, config, files, folders);
    } else {
      files.push(path);
    }
  }
}

/**
 * Checks every segment of a file's path: universal validity first, then
 * the filenames pattern in force at the segment's location. The final
 * segment is a file name and is matched with its extension — everything
 * from the last dot — stripped; folder segments are matched unstripped.
 */
function checkFilename(config: Config, file: string, findings: Finding[]): void {
  const segments = file.split("/");
  for (let depth = 0; depth < segments.length; depth++) {
    const segment = segments[depth]!;
    const issue = segmentIssue(segment);
    if (issue !== undefined) {
      findings.push({ rule: "filename", severity: "violation", file, message: issue });
      continue;
    }
    const location = segments.slice(0, depth + 1).join("/");
    const pattern = resolve(config, location).filenames?.pattern;
    if (pattern === undefined) continue;
    const isFile = depth === segments.length - 1;
    const subject = isFile ? stripExtension(segment) : segment;
    if (!pattern.regex.test(subject)) {
      findings.push({
        rule: "filename",
        severity: "violation",
        file,
        message: `${isFile ? "" : "folder "}"${subject}" does not match the filenames pattern "${pattern.source}"`,
      });
    }
  }
}

/**
 * A segment's universal validity issue, config aside: a filename must be
 * one every filesystem can hold (spec/vault.md). 255 UTF-8 bytes is the
 * per-name limit on the common filesystems (ext4, APFS, NTFS).
 */
function segmentIssue(segment: string): string | undefined {
  const name = JSON.stringify(segment);
  if (segment === "") return "has an empty path segment";
  if (segment === "." || segment === "..") return `has a ${name} path segment`;
  if (/[\u0000-\u001f\u007f]/.test(segment)) return `segment ${name} contains a control character`;
  if (segment !== segment.normalize("NFC")) return `segment ${name} is not Unicode NFC`;
  if (Buffer.byteLength(segment, "utf8") > 255) return `segment ${name} is longer than 255 bytes`;
  return undefined;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot opens no extension: ".env" is a whole name, not an
  // empty stem with an extension. This rule serves filename-pattern
  // matching only; reference resolution (candidatePath) deliberately
  // differs — there, any dot in the final segment, leading included,
  // means the literal path.
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Checks one governed record: parse, then schema and body (spec/cli.md). */
function checkRecord(
  file: string,
  content: string,
  records: RecordsBlock,
  findings: Finding[],
): void {
  const { frontmatterSource, body } = splitRecord(content);
  let frontmatter: unknown = {};
  if (frontmatterSource !== undefined) {
    try {
      // A record with no frontmatter — or an empty block — is checked as
      // an empty object (spec/vault.md).
      frontmatter = load(frontmatterSource) ?? {};
    } catch (error) {
      findings.push({
        rule: "parse",
        severity: "violation",
        file,
        message: `frontmatter is not valid YAML: ${describe(error)}`,
      });
      return;
    }
    // The block, when present, must parse to a mapping — a structural rule
    // of its own, because JSON Schema keywords constrain only objects
    // (spec/vault.md). A non-mapping is a parse violation and, like YAML
    // that does not parse, precludes the schema and body checks.
    if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      findings.push({
        rule: "parse",
        severity: "violation",
        file,
        message: "frontmatter is not a mapping",
      });
      return;
    }
  }
  const schema = records.schema;
  if (schema !== undefined && !schema.validate(frontmatter)) {
    const messages = new Set((schema.validate.errors ?? []).map(translateSchemaError));
    for (const message of messages) {
      findings.push({ rule: "schema", severity: "violation", file, message });
    }
  }
  if (records.body?.allowed === false && body.trim() !== "") {
    findings.push({
      rule: "body",
      severity: "violation",
      file,
      message: "has a body, in a path that forbids bodies",
    });
  }
}

/**
 * Checks a record's references — a dangling one is a warning, one finding
 * per distinct spelling per record (spec/cli.md). Resolution is by lstat,
 * so an ignored file satisfies a reference and a folder or symlink does
 * not; a target no vault path could satisfy dangles without touching the
 * disk, which keeps `..` and absolute targets from reading outside the
 * vault root.
 */
async function checkReferences(
  vaultRoot: string,
  file: string,
  content: string,
  existsCache: Map<string, boolean>,
  findings: Finding[],
): Promise<void> {
  const { frontmatterSource, body } = splitRecord(content);
  const seen = new Set<string>();
  for (const reference of extractReferences(frontmatterSource, body)) {
    if (seen.has(reference.asWritten)) continue;
    seen.add(reference.asWritten);
    const candidate = candidatePath(reference.target);
    if (candidate !== undefined && (await fileExists(vaultRoot, candidate, existsCache))) continue;
    findings.push({
      rule: "reference",
      severity: "warning",
      file,
      message: `${reference.asWritten} does not exist`,
    });
  }
}

async function fileExists(
  vaultRoot: string,
  path: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let result: boolean;
  try {
    result = (await lstat(join(vaultRoot, path))).isFile();
  } catch {
    result = false;
  }
  cache.set(path, result);
  return result;
}

/**
 * Splits a record into frontmatter source and body. Frontmatter is a YAML
 * block opened and closed by a `---` line at the start of the file
 * (spec/vault.md); an unclosed opener is no block, so the whole file is
 * body.
 */
function splitRecord(content: string): { frontmatterSource?: string; body: string } {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { body: content };
  const close = lines.indexOf("---", 1);
  if (close === -1) return { body: content };
  return {
    frontmatterSource: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

/** Translates an Ajv error into plain prose with a dotted path (spec/cli.md). */
function translateSchemaError(error: ErrorObject): string {
  const path = error.instancePath
    .split("/")
    .filter((part) => part !== "")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
  const subject = path === "" ? "frontmatter" : path;
  const prefix = path === "" ? "" : `${path}.`;
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `${prefix}${String(params["missingProperty"])} is required`;
    case "type": {
      const type = params["type"];
      const types = Array.isArray(type) ? type.map(String) : [String(type)];
      return `${subject} must be ${types.map(describeType).join(" or ")}`;
    }
    case "enum": {
      const allowed = Array.isArray(params["allowedValues"]) ? params["allowedValues"] : [];
      return `${subject} must be one of ${allowed.map((value) => JSON.stringify(value)).join(", ")}`;
    }
    case "format":
      return `${subject} must be a valid ${String(params["format"])}`;
    case "additionalProperties":
      return `${prefix}${String(params["additionalProperty"])} is not an allowed field`;
    default:
      return `${subject} ${error.message ?? "is invalid"}`;
  }
}

const typeArticles: Record<string, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

function describeType(type: string): string {
  return typeArticles[type] ?? `of type ${type}`;
}

/**
 * The root law: the vault root holds only autofile.yml and the declared
 * folders (spec/vault.md).
 */
function checkRoot(config: Config, files: string[], folders: string[], findings: Finding[]): void {
  const law = "the root holds only autofile.yml and the declared folders";
  for (const file of files) {
    if (!file.includes("/")) {
      findings.push({
        rule: "root",
        severity: "violation",
        file,
        message: `loose file at the vault root; ${law}`,
      });
    }
  }
  for (const folder of folders) {
    if (!folder.includes("/") && !config.paths.has(folder)) {
      findings.push({
        rule: "root",
        severity: "violation",
        file: folder,
        message: `undeclared folder at the vault root; ${law}`,
      });
    }
  }
}

/** Two paths that differ only by case, checked across the whole vault. */
function checkCollisions(files: string[], folders: string[], findings: Finding[]): void {
  const byFoldedCase = new Map<string, string[]>();
  for (const path of [...files, ...folders]) {
    const folded = path.toLowerCase();
    const group = byFoldedCase.get(folded);
    if (group === undefined) {
      byFoldedCase.set(folded, [path]);
    } else {
      group.push(path);
    }
  }
  for (const group of byFoldedCase.values()) {
    if (group.length < 2) continue;
    group.sort(compare);
    for (const path of group) {
      const others = group.filter((other) => other !== path);
      findings.push({
        rule: "collision",
        severity: "violation",
        file: path,
        message: `differs only by case from ${others.map((other) => `"${other}"`).join(", ")}`,
      });
    }
  }
}

/** A declared path whose folder is missing or empty is a warning (spec/cli.md). */
function checkEmpty(config: Config, files: string[], folders: string[], findings: Finding[]): void {
  for (const name of config.paths.keys()) {
    if (!folders.includes(name)) {
      findings.push({
        rule: "empty",
        severity: "warning",
        file: name,
        message: "declared folder is missing",
      });
    } else if (![...files, ...folders].some((path) => path.startsWith(`${name}/`))) {
      findings.push({
        rule: "empty",
        severity: "warning",
        file: name,
        message: "declared folder is empty",
      });
    }
  }
}

const severityRank: Record<Severity, number> = { violation: 0, warning: 1 };

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      compare(a.file ?? "", b.file ?? "") ||
      compare(a.rule, b.rule) ||
      compare(a.message, b.message),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
