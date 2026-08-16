import { posix } from "node:path";

export type ReferenceLocation = "frontmatter" | "prose";
export type ReferenceSyntax = "wikilink" | "markdown";

export interface Reference {
  location: ReferenceLocation;
  syntax: ReferenceSyntax;
  /** Source text exactly as written in the note. */
  asWritten: string;
  /** Address after alias/fragment handling and URL decoding as applicable. */
  target: string;
  /** Markdown destination was written with a vault-root slash. */
  rooted?: true;
}

interface SuffixNode {
  children: Map<string, SuffixNode>;
  terminal: boolean;
}

export interface ReferenceIndex {
  byFullPath: Set<string>;
  suffixRoot: SuffixNode;
}

/** Builds the full-path set and reversed whole-segment suffix trie shared by every link. */
export function buildIndex(files: readonly string[]): ReferenceIndex {
  const byFullPath = new Set<string>();
  const suffixRoot: SuffixNode = { children: new Map(), terminal: false };
  for (const path of files) {
    const comparablePath = comparable(path);
    byFullPath.add(comparablePath);

    let node = suffixRoot;
    for (const segment of comparablePath.split("/").reverse()) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), terminal: false };
        node.children.set(segment, child);
      }
      child.terminal = true;
      node = child;
    }
  }
  return { byFullPath, suffixRoot };
}

const wikilinkInner = String.raw`[^\][\r\n]+`;
const wikilink = new RegExp(String.raw`!?\[\[(${wikilinkInner})\]\]`, "g");
const wholeWikilink = new RegExp(String.raw`^!?\[\[(${wikilinkInner})\]\]$`);

/** Whether a string is entirely one wikilink (or embedded wikilink). */
export function isWholeWikilink(value: string): boolean {
  return wholeWikilink.test(value);
}

/** Whether a string is entirely one relative internal Markdown link or image. */
export function isWholeMarkdownLink(value: string): boolean {
  const reference = wholeMarkdownReference(value);
  return reference !== undefined && reference.rooted !== true;
}

/**
 * Extracts whole-value frontmatter references and prose links outside code.
 * Parsed arrays are traversed normally, which means an unquoted `[[x]]`
 * (YAML nested arrays) is data rather than a special case.
 */
export function extractReferences(frontmatter: unknown, body: string): Reference[] {
  const references: Reference[] = [];
  if (isMapping(frontmatter)) collectFrontmatter(frontmatter, new Set(), references);

  const scanned = blankCode(body);
  const bodyReferences: Array<Reference & { index: number }> = [];
  for (const match of scanned.matchAll(wikilink)) {
    const target = wikilinkTarget(match[1]!);
    bodyReferences.push({
      location: "prose",
      syntax: "wikilink",
      asWritten: match[0],
      target,
      index: match.index,
    });
  }
  for (const match of scanMarkdownLinks(scanned)) {
    const parsed = markdownTarget(match.target);
    if (parsed !== undefined) {
      bodyReferences.push({
        location: "prose",
        syntax: "markdown",
        asWritten: match.asWritten,
        target: parsed.target,
        ...(parsed.rooted ? { rooted: true as const } : {}),
        index: match.index,
      });
    }
  }
  bodyReferences.sort((left, right) => left.index - right.index);
  references.push(...bodyReferences.map(({ location, syntax, asWritten, target, rooted }) => ({
    location,
    syntax,
    asWritten,
    target,
    ...(rooted ? { rooted } : {}),
  })));
  return references;
}

/** Whether a wikilink reaches some file by a whole-segment path suffix. */
export function resolvesWikilink(target: string, index: ReferenceIndex): boolean {
  if (target === "") return false;
  for (const probe of [target, `${target}.md`]) {
    let node = index.suffixRoot;
    let found = true;
    for (const segment of comparable(probe).split("/").reverse()) {
      const child = node.children.get(segment);
      if (child === undefined) {
        found = false;
        break;
      }
      node = child;
    }
    if (found && node.terminal) return true;
  }
  return false;
}

/** Whether a Markdown target reaches a file URL-style from its note folder. */
export function resolveMarkdownReference(
  target: string,
  linkingNotePath: string,
  index: ReferenceIndex,
  rooted = target.startsWith("/"),
): boolean {
  const folder = posix.dirname(linkingNotePath);
  for (const probe of [target, `${target}.md`]) {
    const path = resolveUrlPath(probe, folder, rooted);
    if (path !== undefined && index.byFullPath.has(comparable(path))) return true;
  }
  return false;
}

function collectFrontmatter(value: unknown, seen: Set<object>, references: Reference[]): void {
  if (typeof value === "string") {
    const wikilinkMatch = wholeWikilink.exec(value);
    if (wikilinkMatch !== null) {
      references.push({
        location: "frontmatter",
        syntax: "wikilink",
        asWritten: value,
        target: wikilinkTarget(wikilinkMatch[1]!),
      });
      return;
    }
    const markdownReference = wholeMarkdownReference(value);
    if (markdownReference !== undefined) references.push(markdownReference);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectFrontmatter(nested, seen, references);
  }
}

function wholeMarkdownReference(value: string): Reference | undefined {
  const matches = scanMarkdownLinks(value);
  if (matches.length !== 1 || matches[0]!.index !== 0 || matches[0]!.asWritten.length !== value.length) {
    return undefined;
  }
  const parsed = markdownTarget(matches[0]!.target);
  if (parsed === undefined) return undefined;
  return {
    location: "frontmatter",
    syntax: "markdown",
    asWritten: value,
    target: parsed.target,
    ...(parsed.rooted ? { rooted: true } : {}),
  };
}

/** Alias and heading both end the address; the first one written wins. */
function wikilinkTarget(inner: string): string {
  const cut = inner.search(/[|#]/u);
  return cut === -1 ? inner : inner.slice(0, cut);
}

interface ParsedMarkdownLink {
  asWritten: string;
  target: string;
  index: number;
}

function scanMarkdownLinks(source: string): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  let index = 0;
  while (index < source.length) {
    const image = source[index] === "!" && source[index + 1] === "[";
    if (source[index] !== "[" && !image) {
      index++;
      continue;
    }
    const parsed = parseMarkdownLinkAt(source, index, image);
    if (parsed === undefined) {
      index++;
      continue;
    }
    links.push(parsed);
    index += parsed.asWritten.length;
  }
  return links;
}

function parseMarkdownLinkAt(
  source: string,
  start: number,
  image: boolean,
): ParsedMarkdownLink | undefined {
  const labelStart = start + (image ? 1 : 0);
  let cursor = labelStart + 1;
  let brackets = 1;
  while (cursor < source.length && brackets > 0) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "[") brackets++;
    else if (source[cursor] === "]") brackets--;
    cursor++;
  }
  if (brackets !== 0 || source[cursor] !== "(") return undefined;

  const destination = parseDestination(source, cursor);
  if (destination === undefined) return undefined;
  return {
    asWritten: source.slice(start, destination.end),
    target: destination.target,
    index: start,
  };
}

function parseDestination(source: string, open: number): { target: string; end: number } | undefined {
  let cursor = skipWhitespace(source, open + 1);
  if (source[cursor] === ")") return { target: "", end: cursor + 1 };

  if (source[cursor] === "<") {
    const start = ++cursor;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === "\n" || source[cursor] === "<") return undefined;
      if (source[cursor] === ">") {
        const target = source.slice(start, cursor);
        const end = parseTitleAndClose(source, cursor + 1);
        return end === undefined ? undefined : { target, end };
      }
      cursor++;
    }
    return undefined;
  }

  const start = cursor;
  let parentheses = 0;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "(") {
      parentheses++;
      cursor++;
      continue;
    }
    if (char === ")") {
      if (parentheses === 0) {
        return { target: source.slice(start, cursor), end: cursor + 1 };
      }
      parentheses--;
      cursor++;
      continue;
    }
    if (/\s/u.test(char) && parentheses === 0) {
      const target = source.slice(start, cursor);
      const end = parseTitleAndClose(source, cursor);
      return end === undefined ? undefined : { target, end };
    }
    cursor++;
  }
  return undefined;
}

function parseTitleAndClose(source: string, start: number): number | undefined {
  let cursor = skipWhitespace(source, start);
  if (source[cursor] === ")") return cursor + 1;
  const opener = source[cursor];
  if (opener !== '"' && opener !== "'" && opener !== "(") return undefined;
  const closer = opener === "(" ? ")" : opener;
  cursor++;
  let nested = opener === "(" ? 1 : 0;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (opener === "(" && source[cursor] === "(") nested++;
    if (source[cursor] === closer) {
      if (opener !== "(" || --nested === 0) {
        cursor = skipWhitespace(source, cursor + 1);
        return source[cursor] === ")" ? cursor + 1 : undefined;
      }
    }
    cursor++;
  }
  return undefined;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor++;
  return cursor;
}

function unescapeMarkdown(target: string): string {
  return target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1");
}

function markdownTarget(target: string): { target: string; rooted: boolean } | undefined {
  const rawPath = cutUrlSuffix(target);
  if (!isInternalMarkdownTarget(rawPath)) return undefined;
  return {
    target: decodeTarget(unescapeMarkdown(rawPath)),
    rooted: rawPath.startsWith("/"),
  };
}

// Split syntactic URL suffixes before decoding so `%23` and `%3F` can still
// name literal filesystem characters.
function cutUrlSuffix(target: string): string {
  for (let index = 0; index < target.length; index++) {
    if (target[index] === "\\") {
      index++;
      continue;
    }
    if (target[index] === "#" || target[index] === "?") return target.slice(0, index);
  }
  return target;
}

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    // It remains an internal-looking link but cannot accidentally resolve
    // unless a file literally carries the malformed percent spelling.
    return target;
  }
}

function isInternalMarkdownTarget(target: string): boolean {
  if (target === "" || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return false;
  if (target.startsWith("//")) return false;
  return true;
}

function resolveUrlPath(target: string, folder: string, rooted: boolean): string | undefined {
  const resolved = posix.normalize(rooted
    ? target.slice(1)
    : posix.join(folder, target));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) return undefined;
  return resolved;
}

const fenceOpen = /^(`{3,}|~{3,})(.*)$/;
const fenceClose = /^(`{3,}|~{3,})\s*$/;

function blankCode(body: string): string {
  return blankCodeSpans(blankFencedCode(body));
}

function blankFencedCode(body: string): string {
  const lines = body.split("\n");
  let fence: { char: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const content = afterContainers(line);
    if (fence !== undefined) {
      const close = fenceClose.exec(content);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = undefined;
      }
      lines[index] = " ".repeat(line.length);
      continue;
    }
    const open = fenceOpen.exec(content);
    if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      lines[index] = " ".repeat(line.length);
    }
  }
  return lines.join("\n");
}

function afterContainers(line: string): string {
  let cursor = skipUpToThreeSpaces(line, 0);
  while (cursor < line.length) {
    if (line[cursor] === ">") {
      cursor++;
      if (line[cursor] === " " || line[cursor] === "\t") cursor++;
      cursor = skipUpToThreeSpaces(line, cursor);
      continue;
    }
    const list = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/u.exec(line.slice(cursor));
    if (list === null) break;
    cursor += list[0].length;
    cursor = skipUpToThreeSpaces(line, cursor);
  }
  return line.slice(cursor);
}

function skipUpToThreeSpaces(line: string, start: number): number {
  let cursor = start;
  while (cursor < start + 3 && line[cursor] === " ") cursor++;
  return cursor;
}

function blankCodeSpans(source: string): string {
  let result = source;
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("`", cursor);
    if (open < 0) break;
    const length = backtickRun(source, open);
    const close = matchingBacktickRun(source, open + length, length);
    if (close === undefined) {
      cursor = open + length;
      continue;
    }
    const end = close + length;
    const blank = source.slice(open, end).replace(/[^\r\n]/g, " ");
    result = result.slice(0, open) + blank + result.slice(end);
    cursor = end;
  }
  return result;
}

function matchingBacktickRun(source: string, start: number, length: number): number | undefined {
  let cursor = start;
  while (cursor < source.length) {
    const run = source.indexOf("`", cursor);
    if (run < 0) return undefined;
    const candidateLength = backtickRun(source, run);
    if (candidateLength === length) return run;
    cursor = run + candidateLength;
  }
  return undefined;
}

function backtickRun(source: string, start: number): number {
  let cursor = start;
  while (source[cursor] === "`") cursor++;
  return cursor - start;
}

function comparable(path: string): string {
  return path.normalize("NFC");
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
