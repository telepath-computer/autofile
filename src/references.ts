import { CORE_SCHEMA, load } from "js-yaml";

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
 * wikilink and markdown forms anywhere in the body outside code: fenced
 * code blocks and inline code spans are not scanned (spec/vault.md).
 * Frontmatter that does not parse or is not a mapping is skipped; the body
 * is always scanned.
 */
export function extractReferences(frontmatterSource: string | undefined, body: string): Reference[] {
  const references: Reference[] = [];
  if (frontmatterSource !== undefined) {
    let frontmatter: unknown;
    try {
      // CORE_SCHEMA, matching the record checker: frontmatter parses to
      // JSON values, so an unquoted date stays a string (spec/vault.md).
      frontmatter = load(frontmatterSource, { schema: CORE_SCHEMA });
    } catch {
      frontmatter = undefined;
    }
    // Only a mapping is frontmatter proper — anything else is the record's
    // parse problem, not a place references live.
    if (typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)) {
      collectFrontmatter(frontmatter, new Set(), references);
    }
  }
  const scanned = blankCode(body);
  for (const match of scanned.matchAll(wikilink)) {
    const target = targetOf(match[1]!);
    if (target !== "") references.push({ asWritten: match[0], target });
  }
  for (const match of scanned.matchAll(markdownLink)) {
    const target = match[2]!.trim();
    if (isVaultRelative(target)) references.push({ asWritten: match[0], target });
  }
  return references;
}

// A fence opener (spec/vault.md: "fenced code blocks ... are not
// scanned"): up to 3 leading spaces, a run of 3+ backticks or tildes, and
// an optional info string. Per CommonMark, a backtick fence's info string
// may not contain a backtick — such a line is prose holding code spans,
// not an opener that would swallow the rest of the body.
const fenceOpen = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A closer: the same character, a run at least as long, nothing after but
// whitespace. Length is checked against the opener where this is applied.
const fenceClose = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Blanks fenced code blocks and inline code spans out of a body, replacing
 * them with spaces of equal length so the surviving text keeps its exact
 * offsets. An unclosed fence runs to the end of the body, as in
 * CommonMark. Deliberate simplifications: inline spans pair within a
 * single line only (a reference is single-line anyway), backslash escapes
 * are ignored, fences inside blockquotes or lists are not recognized, and
 * indented (4-space) code blocks stay scanned — indentation in vault prose
 * is too ambiguous to treat as code.
 */
function blankCode(body: string): string {
  const lines = body.split("\n");
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence !== undefined) {
      const close = fenceClose.exec(line);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = undefined;
      }
      lines[i] = " ".repeat(line.length);
      continue;
    }
    const open = fenceOpen.exec(line);
    if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      lines[i] = " ".repeat(line.length);
      continue;
    }
    lines[i] = blankSpans(line);
  }
  return lines.join("\n");
}

/**
 * Blanks inline code spans in one line of prose. Per CommonMark basics, a
 * span opens with a backtick run and closes with the next run of exactly
 * equal length; a run with no equal partner is literal text.
 */
function blankSpans(line: string): string {
  const runs = [...line.matchAll(/`+/g)];
  let result = line;
  let i = 0;
  while (i < runs.length) {
    const open = runs[i]!;
    let j = i + 1;
    while (j < runs.length && runs[j]![0].length !== open[0].length) j++;
    if (j === runs.length) {
      i++;
      continue;
    }
    const end = runs[j]!.index + runs[j]![0].length;
    result = result.slice(0, open.index) + " ".repeat(end - open.index) + result.slice(end);
    i = j + 1;
  }
  return result;
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
 * The vault-relative paths a target resolves through, in probe order: the
 * literal path first, then `<target>.md` — so `contacts/priya-narayan`
 * reaches `contacts/priya-narayan.md`, `docs/v1.2` reaches `docs/v1.2.md`,
 * and `assets/.env` is reached as written (spec/vault.md). Two probes in
 * one order, never a search; the paths always differ, `.md`-suffixed
 * targets included, since the fallback appends. Empty when no path inside
 * the vault could satisfy the target (empty, absolute, or a `.`/`..`
 * segment), so resolution must not touch the disk.
 */
export function candidatePaths(target: string): string[] {
  const escapes = target
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
  if (escapes) return [];
  return [target, `${target}.md`];
}
