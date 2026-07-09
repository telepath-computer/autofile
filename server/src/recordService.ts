import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";

export interface VaultConfig {
  name: string;
  root: string;
}

export interface RecordJson {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  body: string;
  mtime: string;
}

export interface ErrorJson {
  path?: string;
  message: string;
}

export interface CollectionJson {
  records: RecordJson[];
  errors?: ErrorJson[];
}

export interface RecordPayload {
  properties: Record<string, unknown>;
  body: string;
}

export type ListResult =
  | { kind: "ok"; collection: CollectionJson }
  | { kind: "invalidSegment"; message: string }
  | { kind: "unknownVault" }
  | { kind: "notFound" };

export type GetResult =
  | { kind: "ok"; record: RecordJson }
  | { kind: "invalidSegment"; message: string }
  | { kind: "unknownVault" }
  | { kind: "notFound" }
  | { kind: "parseError"; error: ErrorJson };

export type PutResult =
  | { kind: "ok"; record: RecordJson; created: boolean }
  | { kind: "invalidSegment"; message: string }
  | { kind: "unknownVault" }
  | { kind: "refused"; message: string };

export interface RecordService {
  listRecords(vaultName: string, type: string): Promise<ListResult>;
  getRecord(vaultName: string, type: string, slug: string): Promise<GetResult>;
  putRecord(vaultName: string, type: string, slug: string, payload: RecordPayload): Promise<PutResult>;
}

// YAML engine using the JSON schema so scalars pass through uncoerced: unquoted
// dates stay strings instead of becoming Date objects (which would JSON-serialize
// as full timestamps and transform the frontmatter on the way through).
const yamlEngines = {
  yaml: {
    parse: (source: string): object => {
      const data = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
      if (data === null || data === undefined) {
        return {};
      }
      if (typeof data !== "object" || Array.isArray(data)) {
        throw new Error("frontmatter must be a YAML mapping");
      }
      // Self-referencing anchors produce circular objects that would blow up
      // JSON serialization of the response; treat them as unparseable here so
      // they travel the same errors/422 channel as any broken file.
      try {
        JSON.stringify(data);
      } catch {
        throw new Error("frontmatter is not JSON-serializable (circular YAML references)");
      }
      return data;
    }
  }
};

export async function createRecordService(vaults: VaultConfig[]): Promise<RecordService> {
  const roots = new Map<string, string>();

  for (const vault of vaults) {
    let root: string;
    try {
      root = await realpath(vault.root);
    } catch {
      throw new Error(`vault ${vault.name}: path does not exist: ${vault.root}`);
    }
    if (!(await stat(root)).isDirectory()) {
      throw new Error(`vault ${vault.name}: path is not a directory: ${vault.root}`);
    }
    roots.set(vault.name, root);
  }

  return {
    async listRecords(vaultName, type) {
      const root = roots.get(vaultName);
      if (root === undefined) {
        return { kind: "unknownVault" };
      }
      const typeError = segmentError(type, "type");
      if (typeError !== undefined) {
        return { kind: "invalidSegment", message: typeError };
      }

      let typeDir: string | undefined;
      try {
        typeDir = await resolveContained(root, path.join(root, type));
        if (typeDir !== undefined && !(await stat(typeDir)).isDirectory()) {
          typeDir = undefined;
        }
      } catch {
        typeDir = undefined;
      }
      if (typeDir === undefined) {
        return { kind: "notFound" };
      }

      const records: RecordJson[] = [];
      const errors: ErrorJson[] = [];
      // Sorting slugs (not filenames) matches the spec's byte-wise id ordering:
      // ids share the "type/" prefix, and the .md suffix would misplace a slug
      // that is a prefix of another ("a" must sort before "a.b").
      const slugs = (await readdir(typeDir))
        .filter((name) => isVisibleMarkdownName(name))
        .map((name) => name.slice(0, -".md".length))
        .sort(compareBytewise);

      // Failures degrade per record, never per collection: the vault is edited
      // live, so a file that vanished mid-listing is skipped and any other
      // per-file fs error is reported alongside parse failures.
      for (const slug of slugs) {
        const errorPath = `${type}/${slug}.md`;
        try {
          const filePath = await resolveContained(root, path.join(typeDir, `${slug}.md`));
          if (filePath === undefined || !(await stat(filePath)).isFile()) {
            continue;
          }
          const parsed = parseRecordFile(await readFile(filePath, "utf8"));
          if (!parsed.ok) {
            errors.push({ path: errorPath, message: parsed.message });
            continue;
          }
          records.push(await toRecord(type, slug, parsed, filePath));
        } catch (error) {
          if (errnoCode(error) === "ENOENT") {
            continue;
          }
          errors.push({ path: errorPath, message: errorMessage(error) });
        }
      }

      return {
        kind: "ok",
        collection: errors.length > 0 ? { records, errors } : { records }
      };
    },

    async getRecord(vaultName, type, slug) {
      const root = roots.get(vaultName);
      if (root === undefined) {
        return { kind: "unknownVault" };
      }
      const message = segmentError(type, "type") ?? segmentError(slug, "slug");
      if (message !== undefined) {
        return { kind: "invalidSegment", message };
      }

      const errorPath = `${type}/${slug}.md`;
      try {
        const filePath = await resolveContained(root, path.join(root, type, `${slug}.md`));
        if (filePath === undefined || !(await stat(filePath)).isFile()) {
          return { kind: "notFound" };
        }

        const parsed = parseRecordFile(await readFile(filePath, "utf8"));
        if (!parsed.ok) {
          return { kind: "parseError", error: { path: errorPath, message: parsed.message } };
        }
        return { kind: "ok", record: await toRecord(type, slug, parsed, filePath) };
      } catch (error) {
        // A file that vanished mid-request is a plain 404; any other fs error
        // travels the same 422 channel as a parse failure.
        if (errnoCode(error) === "ENOENT") {
          return { kind: "notFound" };
        }
        return { kind: "parseError", error: { path: errorPath, message: errorMessage(error) } };
      }
    },

    async putRecord(vaultName, type, slug, payload) {
      const root = roots.get(vaultName);
      if (root === undefined) {
        return { kind: "unknownVault" };
      }
      const message = segmentError(type, "type") ?? segmentError(slug, "slug");
      if (message !== undefined) {
        return { kind: "invalidSegment", message };
      }

      let typeDir: string | undefined;
      try {
        await mkdir(path.join(root, type), { recursive: true });
        typeDir = await resolveContained(root, path.join(root, type));
        if (typeDir !== undefined && !(await stat(typeDir)).isDirectory()) {
          typeDir = undefined;
        }
      } catch (error) {
        // e.g. EEXIST/ENOTDIR when a regular file already occupies the type name.
        return { kind: "refused", message: `cannot create type folder: ${errorMessage(error)}` };
      }
      if (typeDir === undefined) {
        return { kind: "refused", message: "path escapes the vault root" };
      }

      const targetPath = path.join(typeDir, `${slug}.md`);
      const existing = await resolveContained(root, targetPath, { allowMissing: true });
      if (existing === undefined) {
        return { kind: "refused", message: "path escapes the vault root" };
      }
      const created = !(await exists(targetPath));

      const content = serializeRecordFile(payload.properties, payload.body);
      const tempPath = path.join(typeDir, `.${slug}.md.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(tempPath, content, "utf8");
        await rename(tempPath, targetPath);
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }

      // Re-parse what was written so the response matches a subsequent GET exactly.
      const parsed = parseRecordFile(content);
      if (!parsed.ok) {
        throw new Error(`written record failed to re-parse: ${parsed.message}`);
      }
      return { kind: "ok", record: await toRecord(type, slug, parsed, targetPath), created };
    }
  };
}

// Route-segment rules from the spec: reject empty, "." and "..", separators, a
// leading "." or "_" (which subsumes the dot cases), and a slug ending in .md.
function segmentError(segment: string, label: "type" | "slug"): string | undefined {
  if (segment === "") {
    return `${label} must not be empty`;
  }
  if (segment.includes("/") || segment.includes("\\")) {
    return `${label} must not contain path separators`;
  }
  if (segment.startsWith(".") || segment.startsWith("_")) {
    return `${label} must not begin with "." or "_"`;
  }
  if (label === "slug" && segment.endsWith(".md")) {
    return "slug must not end with .md";
  }
  return undefined;
}

// Resolves a candidate path and requires its real path to stay inside the vault
// root, so neither traversal nor symlinks can reach outside it. Returns the real
// path, or undefined when the target is missing or escapes; other fs errors
// (symlink loops, permissions) are rethrown for the caller to report. With
// allowMissing, a nonexistent target resolves to the candidate itself.
async function resolveContained(
  root: string,
  candidate: string,
  options: { allowMissing?: boolean } = {}
): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return options.allowMissing ? candidate : undefined;
    }
    throw error;
  }
  return isWithinRoot(root, real) ? real : undefined;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isVisibleMarkdownName(name: string): boolean {
  return name.endsWith(".md") && !name.startsWith(".") && !name.startsWith("_");
}

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

type ParsedFile =
  | { ok: true; properties: Record<string, unknown>; body: string }
  | { ok: false; message: string };

// Serializes a record as the exact inverse of parseRecordFile: gray-matter's
// content is the byte-exact remainder after the closing "---\n" fence line, so
// "---\n<yaml>---\n" + body round-trips the body verbatim (matter.stringify
// would append a trailing newline). safeDump never emits a bare "---" line
// (multiline strings become indented block scalars), so nothing in the YAML
// closes the fence early. The frontmatter block is omitted only when parsing
// the bare body demonstrably reproduces it — a body starting with "---" would
// otherwise be reinterpreted as frontmatter on read-back.
function serializeRecordFile(properties: Record<string, unknown>, body: string): string {
  const empty = Object.keys(properties).length === 0;
  if (empty && parsesAsBareBody(body)) {
    return body;
  }
  return `---\n${empty ? "" : yaml.safeDump(properties)}---\n${body}`;
}

function parsesAsBareBody(body: string): boolean {
  const parsed = parseRecordFile(body);
  return parsed.ok && parsed.body === body && Object.keys(parsed.properties).length === 0;
}

function parseRecordFile(content: string): ParsedFile {
  try {
    const parsed = matter(content, { engines: yamlEngines });
    return {
      ok: true,
      properties: (parsed.data ?? {}) as Record<string, unknown>,
      body: parsed.content
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

async function toRecord(
  type: string,
  slug: string,
  parsed: { properties: Record<string, unknown>; body: string },
  filePath: string
): Promise<RecordJson> {
  const fileStat = await stat(filePath);
  return {
    id: `${type}/${slug}`,
    type,
    properties: parsed.properties,
    body: parsed.body,
    mtime: fileStat.mtime.toISOString()
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
