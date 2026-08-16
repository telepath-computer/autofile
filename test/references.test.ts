import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";

import { check, type CheckResult, type Finding, type Rule } from "@telepath-computer/autofile";
import {
  buildIndex,
  extractReferences,
  resolveMarkdownReference,
  resolvesWikilink,
} from "../dist/references.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function vault(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-references-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(entries)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

function findings(result: CheckResult, rule: Rule): Finding[] {
  return result.findings.filter((finding) => finding.rule === rule);
}

test("extracts whole-value field links in both syntaxes and prose links in source order", () => {
  assert.deepEqual(extractReferences({
    wiki: "[[contacts/mira|Mira]]",
    markdown: "[Mira](../contacts/mira)",
    nested: [{ image: "![[assets/photo.jpg#crop]]" }],
    external: "[Web](https://example.com)",
    longer: "See [[contacts/not-a-reference]]",
    unquotedShape: [["contacts/not-a-reference"]],
  }, "[[contacts/mira]] [right](../contacts/mira) ![image](../assets/photo.jpg)"), [
    { location: "frontmatter", syntax: "wikilink", asWritten: "[[contacts/mira|Mira]]", target: "contacts/mira" },
    { location: "frontmatter", syntax: "markdown", asWritten: "[Mira](../contacts/mira)", target: "../contacts/mira" },
    { location: "frontmatter", syntax: "wikilink", asWritten: "![[assets/photo.jpg#crop]]", target: "assets/photo.jpg" },
    { location: "prose", syntax: "wikilink", asWritten: "[[contacts/mira]]", target: "contacts/mira" },
    { location: "prose", syntax: "markdown", asWritten: "[right](../contacts/mira)", target: "../contacts/mira" },
    { location: "prose", syntax: "markdown", asWritten: "![image](../assets/photo.jpg)", target: "../assets/photo.jpg" },
  ]);
});

test("preserves wikilinks whose alias or fragment leaves an empty target", () => {
  assert.deepEqual(extractReferences({
    fragment: "[[#part]]",
    alias: "[[|Alias]]",
  }, "[[#part]] [[|Alias]]"), [
    { location: "frontmatter", syntax: "wikilink", asWritten: "[[#part]]", target: "" },
    { location: "frontmatter", syntax: "wikilink", asWritten: "[[|Alias]]", target: "" },
    { location: "prose", syntax: "wikilink", asWritten: "[[#part]]", target: "" },
    { location: "prose", syntax: "wikilink", asWritten: "[[|Alias]]", target: "" },
  ]);
});

test("markdown targets are URL-decoded and fragments and titles are not part of the path", () => {
  assert.deepEqual(extractReferences(undefined, `[one](Some%20Note.md#goals) [two](<more%20notes/x> "Title") [three](x.md 'Title')`), [
    { location: "prose", syntax: "markdown", asWritten: "[one](Some%20Note.md#goals)", target: "Some Note.md" },
    { location: "prose", syntax: "markdown", asWritten: `[two](<more%20notes/x> "Title")`, target: "more notes/x" },
    { location: "prose", syntax: "markdown", asWritten: "[three](x.md 'Title')", target: "x.md" },
  ]);
});

test("scheme'd, protocol-relative, and same-document markdown targets are external", () => {
  assert.deepEqual(extractReferences(undefined, [
    "[web](https://example.com)",
    "[mail](mailto:a@example.com)",
    "[custom](obsidian://open?vault=x)",
    "[protocol-relative](//example.com/x)",
    "[heading](#part)",
    "[local](./x)",
    "[root](/x)",
  ].join(" ")), [
    { location: "prose", syntax: "markdown", asWritten: "[local](./x)", target: "./x" },
    { location: "prose", syntax: "markdown", asWritten: "[root](/x)", target: "/x", rooted: true },
  ]);
});

test("classifies markdown URL syntax before percent-decoding the path", () => {
  assert.deepEqual(extractReferences(undefined, [
    "[hash](%23part)",
    "[colon](foo%3Abar)",
    "[slashes](%2F%2Fserver)",
    "[scheme](foo:bar)",
    "[authority](//server)",
    "[fragment](#part)",
  ].join(" ")), [
    { location: "prose", syntax: "markdown", asWritten: "[hash](%23part)", target: "#part" },
    { location: "prose", syntax: "markdown", asWritten: "[colon](foo%3Abar)", target: "foo:bar" },
    { location: "prose", syntax: "markdown", asWritten: "[slashes](%2F%2Fserver)", target: "//server" },
  ]);
});

test("encoded markdown delimiters remain internal links for format checking", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/#part": "",
    "notes/foo:bar": "",
    "notes/server": "",
    "notes/source.md": "[hash](%23part) [colon](foo%3Abar) [slashes](%2F%2Fserver)\n",
  }));
  assert.deepEqual(findings(result, "link_format").map(({ message }) => message), [
    "[colon](foo%3Abar) must use wikilink format",
    "[hash](%23part) must use wikilink format",
    "[slashes](%2F%2Fserver) must use wikilink format",
  ]);
  assert.deepEqual(findings(result, "resolve"), []);
});

test("fenced code blocks and inline code spans are not scanned", () => {
  const body = [
    "before [[yes]] `[[inline]] [inline](no)`",
    "```md",
    "[[fenced]] [also](fenced)",
    "```",
    "~~~",
    "[[tilde]]",
    "~~~",
    "after [yes](yes)",
  ].join("\n");
  assert.deepEqual(extractReferences(undefined, body), [
    { location: "prose", syntax: "wikilink", asWritten: "[[yes]]", target: "yes" },
    { location: "prose", syntax: "markdown", asWritten: "[yes](yes)", target: "yes" },
  ]);
});

test("parses balanced and escaped parentheses in inline link destinations", () => {
  assert.deepEqual(extractReferences(undefined, String.raw`[deep](../a(b(c)).pdf) [escaped](../a\(b\).pdf)`), [
    { location: "prose", syntax: "markdown", asWritten: "[deep](../a(b(c)).pdf)", target: "../a(b(c)).pdf" },
    { location: "prose", syntax: "markdown", asWritten: String.raw`[escaped](../a\(b\).pdf)`, target: "../a(b).pdf" },
  ]);
});

test("does not scan multiline code spans or fences inside blockquotes and lists", () => {
  const body = [
    "before [yes](yes)",
    "`` code starts",
    "[[hidden]] [multiline](no)",
    "code ends ``",
    "> ```md",
    "> [[quoted]] [quoted](no)",
    "> ```",
    "- ~~~md",
    "  [[listed]] [listed](no)",
    "  ~~~",
    "after [[also]]",
  ].join("\n");
  assert.deepEqual(extractReferences(undefined, body), [
    { location: "prose", syntax: "markdown", asWritten: "[yes](yes)", target: "yes" },
    { location: "prose", syntax: "wikilink", asWritten: "[[also]]", target: "also" },
  ]);
});

test("wikilink suffix resolution accepts bare, partial, full, and .md-suffixed targets", () => {
  const index = buildIndex([
    "contacts/mira.md",
    "work/contacts/priya.md",
    "distracts/priya.md",
    "assets/item",
    "assets/item.md",
  ]);
  assert.equal(resolvesWikilink("mira", index), true);
  assert.equal(resolvesWikilink("contacts/priya", index), true);
  assert.equal(resolvesWikilink("work/contacts/priya", index), true);
  assert.equal(resolvesWikilink("contacts/mira.md", index), true);
  assert.equal(resolvesWikilink("assets/item", index), true);
  assert.equal(resolvesWikilink("acts/priya", index), false);
  assert.equal(resolvesWikilink("", index), false);
});

test("repeated-basename multi-segment targets resolve without scanning the basename bucket", () => {
  const size = 10_000;
  const index = buildIndex(Array.from({ length: size }, (_, item) => `group-${item}/shared.md`));

  const started = performance.now();
  for (let item = 0; item < size; item++) {
    assert.equal(resolvesWikilink(`group-${item}/shared`, index), true);
  }
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 300, `10,000 repeated-basename resolutions took ${Math.round(elapsed)}ms`);
});

test("markdown resolution is URL-style against the note folder", () => {
  const index = buildIndex([
    "contacts/mira.md",
    "events/peer.md",
    "elsewhere/peer.md",
    "root.md",
  ]);
  assert.equal(resolveMarkdownReference("../contacts/mira", "events/source.md", index), true);
  assert.equal(resolveMarkdownReference("peer", "events/source.md", index), true);
  assert.equal(resolveMarkdownReference("/root", "events/source.md", index), true);
  assert.equal(resolveMarkdownReference("mira", "events/source.md", index), false);
  assert.equal(resolveMarkdownReference("../../outside", "events/source.md", index), false);
});

test("folders never satisfy links and both resolution modes normalize Unicode", () => {
  const stored = `contacts/${"café".normalize("NFD")}.md`;
  const index = buildIndex(["folder/child.md", stored]);
  assert.equal(resolvesWikilink("folder", index), false);
  assert.equal(resolvesWikilink("contacts/café", index), true);
  assert.equal(resolveMarkdownReference("../contacts/café", "events/source.md", index), true);
});

test("wikilink mode accepts wikilinks everywhere and flags internal markdown everywhere", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: contacts
    description: Contacts.
  - path: events
    description: Events.
  - path: assets
    description: Assets.
`,
    "contacts/mira.md": "",
    "assets/manual.pdf": "",
    "events/source.md": `---
bare: '[[mira]]'
partial: '[[contacts/mira]]'
full: '[[contacts/mira.md]]'
alias: '[[contacts/mira|Mira]]'
heading: '[[contacts/mira#History]]'
asset: '[[manual.pdf]]'
wrong: '[Mira](../contacts/mira)'
missing: '[[contacts/missing]]'
external: '[Web](https://example.com)'
---
[[mira]] [[contacts/mira|Mira]] [[contacts/mira.md]]
[Mira](../contacts/mira) [root](/contacts/mira)
[Web](https://example.com) [protocol](//example.com/x)
`,
  }));
  assert.deepEqual(findings(result, "link_format").map(({ message }) => message), [
    "[Mira](../contacts/mira) must use wikilink format",
    "[Mira](../contacts/mira) must use wikilink format",
    "[root](/contacts/mira) must use wikilink format",
  ]);
  assert.deepEqual(findings(result, "resolve").map(({ message }) => message), [
    "[[contacts/missing]] does not exist",
  ]);
});

test("markdown mode accepts relative markdown everywhere and flags wikilinks and rooted targets", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
link_format: markdown
folders:
  - path: contacts
    description: Contacts.
  - path: events
    description: Events.
`,
    "contacts/mira.md": "",
    "events/source.md": `---
good: '[Mira](../contacts/mira)'
aliased_image: '![Mira](../contacts/mira)'
wrong: '[[mira]]'
rooted: '[Root](/contacts/mira)'
external: '[Web](https://example.com)'
---
[Mira](../contacts/mira) [[contacts/mira]] [Root](/contacts/mira)
[Missing](../contacts/missing)
[Web](https://example.com) [Mail](mailto:a@example.com) [Protocol](//example.com/x)
`,
  }));
  assert.deepEqual(findings(result, "link_format").map(({ message }) => message), [
    "[Root](/contacts/mira) must use a relative markdown target",
    "[Root](/contacts/mira) must use a relative markdown target",
    "[[contacts/mira]] must use markdown format",
    "[[mira]] must use markdown format",
  ]);
  assert.deepEqual(findings(result, "resolve").map(({ message }) => message), [
    "[Missing](../contacts/missing) does not exist",
  ]);
});

test("field detection is whole-value only and unquoted wikilinks remain data", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nlink_format: markdown\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/source.md": `---
longer_wiki: 'See [[missing]]'
longer_markdown: 'See [missing](missing)'
unquoted: [[missing]]
---
`,
  }));
  assert.deepEqual(findings(result, "link_format"), []);
  assert.deepEqual(findings(result, "resolve"), []);
});

test("only governed notes are scanned, while ignored and out-of-scope files remain targets", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nignore: ['^ignored$']\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/source.md": "[[ignored/hidden]] [[outside/hidden]]\n",
    "ignored/hidden.md": "[[missing-in-ignored]] [wrong](wrong)",
    "outside/hidden.md": "[[missing-outside]] [wrong](wrong)",
  }));
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 1);
});

test("5,000 repeated-basename linked notes resolve through the suffix index in linear time", async () => {
  const entries: Record<string, string> = {
    "autofile.yml": "version: 1\nfolders:\n  - path: notes\n    description: Notes.\n",
  };
  for (let index = 0; index < 5000; index++) {
    entries[`notes/group-${index}/shared.md`] = `[[group-${(index + 1) % 5000}/shared]]\n`;
  }
  const root = await vault(entries);

  const started = performance.now();
  const result = await check(root);
  const elapsed = performance.now() - started;

  assert.equal(result.filesChecked, 5000);
  assert.deepEqual(result.findings, []);
  assert.ok(elapsed < 30_000, `check took ${Math.round(elapsed)}ms`);
});
