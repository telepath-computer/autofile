import { load } from "js-yaml";

// The reference grammar (spec/vault.md): what counts as a reference in a
// record, and the vault-relative path a target resolves through. Pure text
// work — resolving against the disk is check's job.

export interface Reference {
  /** The reference's source text, exactly as written in the record. */
  asWritten: string;
  /** The part that resolves: the target before any `|` or `#`. */
  target: string;
}

// A wikilink `[[target]]` or embed `![[target]]`: brackets holding at
// least one character, none of them a bracket or newline — a reference is
// a single-line construct, so an unclosed `[[` never fuses with a stray
// `]]` on a later line.
const wikilink = /!?\[\[([^\][\n]+)\]\]/g;
const wholeWikilink = /^!?\[\[([^\][\n]+)\]\]$/;
// A markdown link `[label](target)` or image `![alt](target)`: no brackets
// or newlines in the label, no parentheses or newlines in the target.
// Deliberately simple; nested brackets, angle-bracket destinations, and
// labels wrapped across lines are out of scope.
const markdownLink = /!?\[([^\][\n]*)\]\(([^()\n]*)\)/g;

/**
 * Extracts a record's references: whole-value wikilinks at any depth in
 * the frontmatter — a wikilink inside larger prose in a frontmatter string
 * is body-level prose, not a typed link, and is not extracted — and both
 * wikilink and markdown forms anywhere in the body. Frontmatter that does
 * not parse or is not a mapping is skipped; the body is always scanned.
 */
export function extractReferences(frontmatterSource: string | undefined, body: string): Reference[] {
  const references: Reference[] = [];
  if (frontmatterSource !== undefined) {
    let frontmatter: unknown;
    try {
      frontmatter = load(frontmatterSource);
    } catch {
      frontmatter = undefined;
    }
    // Only a mapping is frontmatter proper — anything else is the record's
    // parse problem, not a place references live.
    if (typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)) {
      collectFrontmatter(frontmatter, new Set(), references);
    }
  }
  for (const match of body.matchAll(wikilink)) {
    const target = targetOf(match[1]!);
    if (target !== "") references.push({ asWritten: match[0], target });
  }
  for (const match of body.matchAll(markdownLink)) {
    const target = match[2]!.trim();
    if (isVaultRelative(target)) references.push({ asWritten: match[0], target });
  }
  return references;
}

/**
 * Walks frontmatter values at any depth, collecting strings that are a
 * wikilink whole. Keys are names, not values, and are not scanned. The
 * seen set breaks cycles, which YAML anchors can build.
 */
function collectFrontmatter(value: unknown, seen: Set<object>, references: Reference[]): void {
  if (typeof value === "string") {
    const match = wholeWikilink.exec(value);
    if (match === null) return;
    const target = targetOf(match[1]!);
    if (target !== "") references.push({ asWritten: value, target });
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const nested of values) collectFrontmatter(nested, seen, references);
}

/** The target of a wikilink's inner text: the part before the first `|` or `#`. */
function targetOf(inner: string): string {
  const cut = inner.search(/[|#]/);
  return cut === -1 ? inner : inner.slice(0, cut);
}

/**
 * Whether a markdown-link target is a vault-relative path (spec/vault.md):
 * a URL is not a reference, nor is a target with `./` or `../` segments or
 * URL-encoding. Nor, beyond those, anything that cannot name a vault file:
 * an empty target, a bare `#fragment`, an absolute path or empty segment,
 * or whitespace, which a bare markdown destination cannot hold.
 */
function isVaultRelative(target: string): boolean {
  if (target === "" || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (/%[0-9a-f]{2}/i.test(target)) return false;
  if (/\s/.test(target)) return false;
  return target.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The vault-relative path a target resolves through: `<target>.md` when
 * the final segment contains no dot, the literal path when it contains
 * any — leading included, so `assets/.env` is reached as written
 * (spec/vault.md). This deliberately differs from the filename-pattern
 * rule (check's stripExtension), where a leading dot opens no extension.
 * Undefined when no path inside the vault could satisfy it (empty,
 * absolute, or a `.`/`..` segment), so resolution must not touch the
 * disk.
 */
export function candidatePath(target: string): string | undefined {
  const segments = target.split("/");
  const escapes = segments.some(
    (segment) => segment === "" || segment === "." || segment === "..",
  );
  if (escapes) return undefined;
  const name = segments[segments.length - 1]!;
  return name.includes(".") ? target : `${target}.md`;
}
