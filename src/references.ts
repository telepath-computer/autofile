import { posix } from "node:path";

// Pure internal-link API for the check engine:
// - extractReferences scans parsed frontmatter and body into the spelling
//   shown to users plus the target used for resolution.
// - resolveReference selects a vault-relative file path from the check
//   engine's file index, given the linking note's vault-relative path.
// The caller builds the index and includes files only, never folders.

export interface Reference {
  /** The reference's source text, exactly as written in the note. */
  asWritten: string;
  /** The part that resolves: the target before any `|` or `#`. */
  target: string;
}

interface IndexedFile {
  path: string;
  normalizedPath: string;
}

export interface ReferenceIndex {
  byBasename: Map<string, IndexedFile[]>;
  byFullPath: Map<string, IndexedFile[]>;
}

/** Builds the opaque lookup structure used to resolve vault references. */
export function buildIndex(files: readonly string[]): ReferenceIndex {
  const byBasename = new Map<string, IndexedFile[]>();
  const byFullPath = new Map<string, IndexedFile[]>();
  for (const path of files) {
    const normalizedPath = comparable(toPosixSeparators(path));
    const file = { path, normalizedPath };
    addToIndex(byBasename, posix.basename(normalizedPath), file);
    addToIndex(byFullPath, normalizedPath, file);
  }
  return { byBasename, byFullPath };
}

function addToIndex(index: Map<string, IndexedFile[]>, key: string, file: IndexedFile): void {
  const matches = index.get(key);
  if (matches === undefined) index.set(key, [file]);
  else matches.push(file);
}

// A wikilink `[[target]]` or embed `![[target]]`: brackets holding at
// least one character, none of them a bracket or newline — a reference is
// a single-line construct, so an unclosed `[[` never fuses with a stray
// `]]` on a later line.
const wikilinkInner = String.raw`[^\][\r\n]+`;
const wikilink = new RegExp(String.raw`!?\[\[(${wikilinkInner})\]\]`, "g");
const wholeWikilink = new RegExp(String.raw`^!?\[\[(${wikilinkInner})\]\]$`);

/** Whether a string consists entirely of one valid wikilink or embed. */
export function isWholeWikilink(value: string): boolean {
  return wholeWikilink.test(value);
}
// A markdown link `[label](target)` or image `![alt](target)`: no brackets
// or newlines in the label. Destinations may be angle-bracketed and may
// carry a double-quoted, single-quoted, or parenthesized title. Deliberate
// simplifications: nested brackets, nested parentheses in destinations or
// titles, and labels wrapped across lines are out of scope.
const markdownLink = /!?\[([^\][\n]*)\]\((<[^>\n]*>|(?:[^()\n]|\([^()\n]*\))*)\)/g;

/**
 * Extracts a note's references: whole-value wikilinks at any depth in
 * the frontmatter — a wikilink inside larger prose in a frontmatter string
 * is body-level prose, not a typed link, and is not extracted — and both
 * wikilink and markdown forms anywhere in the body outside code: fenced
 * code blocks and inline code spans are not scanned (spec/vault.md).
 * Frontmatter that does not parse or is not a mapping is skipped; the body
 * is always scanned.
 */
export function extractReferences(frontmatter: unknown, body: string): Reference[] {
  const references: Reference[] = [];
  // Only a mapping is frontmatter proper — anything else is the note's
  // parse problem, not a place references live.
  if (typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)) {
    collectFrontmatter(frontmatter, new Set(), references);
  }
  const scanned = blankCode(body);
  const bodyReferences: Array<Reference & { index: number }> = [];
  for (const match of scanned.matchAll(wikilink)) {
    const target = targetOf(match[1]!);
    if (target !== "") bodyReferences.push({ asWritten: match[0], target, index: match.index });
  }
  for (const match of scanned.matchAll(markdownLink)) {
    const encoded = markdownDestination(match[2]!);
    const decoded = decodeTarget(encoded);
    const heading = decoded.indexOf("#");
    const target = heading === -1 ? decoded : decoded.slice(0, heading);
    if (isInternalTarget(target)) {
      bodyReferences.push({ asWritten: match[0], target, index: match.index });
    }
  }
  bodyReferences.sort((left, right) => left.index - right.index);
  references.push(...bodyReferences.map(({ asWritten, target }) => ({ asWritten, target })));
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

/** Whether a decoded markdown destination is internal rather than a URL. */
function isInternalTarget(target: string): boolean {
  if (target === "" || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith("//")) return false;
  return true;
}

/** Removes a markdown title and angle brackets, yielding the encoded destination. */
function markdownDestination(contents: string): string {
  let destination = contents.trim();
  const title = /\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))\s*$/u.exec(destination);
  if (title !== null) destination = destination.slice(0, title.index).trimEnd();
  if (destination.startsWith("<") && destination.endsWith(">")) return destination.slice(1, -1);
  return destination;
}

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Resolves an extracted target against an index of vault-relative file
 * paths. Plain targets suffix-match; `./` and `../` targets are relative to
 * the linking note's folder; `/` targets are vault-absolute. The literal
 * target is tried before its `.md` fallback. Among suffix matches, the file
 * with the fewest segments in its relative path from the note wins, with a
 * lexicographic path tie-break. Comparisons use NFC Unicode normalization;
 * the selected path is returned exactly as supplied by the index.
 */
export function resolveReference(
  target: string,
  linkingNotePath: string,
  index: ReferenceIndex,
): string | undefined {
  const noteFolder = posix.dirname(toPosixSeparators(linkingNotePath));
  const relative = target.startsWith("./") || target.startsWith("../");
  const absolute = target.startsWith("/");
  const written = toPosixSeparators(target);

  const base = relative
    ? posix.normalize(posix.join(noteFolder, written))
    : posix.normalize(absolute ? written.slice(1) : written);
  // A target that climbs past the vault root, or is rooted outside it, names
  // no vault file. "." is rejected only on the plain branch: an absolute "/"
  // normalizes to "." too, and there it still probes the root ".md" file.
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return undefined;
  if (base === "." && !relative && !absolute) return undefined;

  for (const probe of [base, `${base}.md`]) {
    const normalizedProbe = comparable(probe);
    const matches = relative || absolute
      ? index.byFullPath.get(normalizedProbe) ?? []
      : (index.byBasename.get(posix.basename(normalizedProbe)) ?? []).filter((file) =>
        file.normalizedPath === normalizedProbe || file.normalizedPath.endsWith(`/${normalizedProbe}`));
    if (matches.length > 0) return nearest(matches, noteFolder).path;
  }
  return undefined;
}

// Link targets are authored by hand, so a Windows-style separator can reach
// us in one; vault paths from the walk are always `/`-joined already.
function toPosixSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function comparable(path: string): string {
  return path.normalize("NFC");
}

function nearest(files: readonly IndexedFile[], noteFolder: string): IndexedFile {
  const normalizedNoteFolder = comparable(noteFolder);
  return [...files].sort((left, right) => {
    const leftDistance = distance(normalizedNoteFolder, left.normalizedPath);
    const rightDistance = distance(normalizedNoteFolder, right.normalizedPath);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return left.normalizedPath < right.normalizedPath ? -1 : left.normalizedPath > right.normalizedPath ? 1 : 0;
  })[0]!;
}

function distance(normalizedNoteFolder: string, normalizedFile: string): number {
  const relative = posix.relative(normalizedNoteFolder, normalizedFile);
  return relative === "" ? 0 : relative.split("/").length;
}
