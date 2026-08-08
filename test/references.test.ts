import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, extractReferences, resolveReference as resolveIndexedReference } from "../dist/references.js";

function resolveReference(target: string, linkingNotePath: string, files: readonly string[]): string | undefined {
  return resolveIndexedReference(target, linkingNotePath, buildIndex(files));
}

test("extracts body links in source order with their original spelling", () => {
  assert.deepEqual(
    extractReferences(undefined, "[[Some Note|alias]] [read](Some%20Note) ![[photo.jpg#crop]] ![alt](photo.jpg)"),
    [
      { asWritten: "[[Some Note|alias]]", target: "Some Note" },
      { asWritten: "[read](Some%20Note)", target: "Some Note" },
      { asWritten: "![[photo.jpg#crop]]", target: "photo.jpg" },
      { asWritten: "![alt](photo.jpg)", target: "photo.jpg" },
    ],
  );
});

test("decodes markdown targets before removing their heading", () => {
  assert.deepEqual(extractReferences(undefined, "[roadmap](Some%20Note.md#goals)"), [
    { asWritten: "[roadmap](Some%20Note.md#goals)", target: "Some Note.md" },
  ]);
});

test("excludes URL markdown targets but retains relative and absolute internal targets", () => {
  assert.deepEqual(
    extractReferences(
      undefined,
      "[web](https://example.com) [mail](mailto:a@example.com) [local](./x) [up](../x) [root](/x)",
    ),
    [
      { asWritten: "[local](./x)", target: "./x" },
      { asWritten: "[up](../x)", target: "../x" },
      { asWritten: "[root](/x)", target: "/x" },
    ],
  );
});

test("treats wikilinks as internal even when their targets resemble URL schemes", () => {
  const frontmatter = { web: "[[https://example.com]]", mail: "[[mailto:a@example.com]]" };
  assert.deepEqual(
    extractReferences(frontmatter, "[[https://example.com]] [[TODO: refactor]] [[local]]"),
    [
      { asWritten: "[[https://example.com]]", target: "https://example.com" },
      { asWritten: "[[mailto:a@example.com]]", target: "mailto:a@example.com" },
      { asWritten: "[[https://example.com]]", target: "https://example.com" },
      { asWritten: "[[TODO: refactor]]", target: "TODO: refactor" },
      { asWritten: "[[local]]", target: "local" },
    ],
  );
});

test("extracts markdown destinations with titles and angle brackets", () => {
  assert.deepEqual(
    extractReferences(
      undefined,
      `[double](notes/x.md "Title") [single](notes/y.md 'Title') [paren](notes/z.md (Title)) [angle](<my note.md>)`,
    ),
    [
      { asWritten: `[double](notes/x.md "Title")`, target: "notes/x.md" },
      { asWritten: `[single](notes/y.md 'Title')`, target: "notes/y.md" },
      { asWritten: `[paren](notes/z.md (Title))`, target: "notes/z.md" },
      { asWritten: "[angle](<my note.md>)", target: "my note.md" },
    ],
  );
});

test("retains a markdown link when percent decoding fails", () => {
  assert.deepEqual(extractReferences(undefined, "[a](50%.md)"), [
    { asWritten: "[a](50%.md)", target: "50%.md" },
  ]);
});

test("does not scan fenced blocks or inline code spans", () => {
  const body = [
    "before [[yes]] `[[inline]]`",
    "```md",
    "[[fenced]] [also](fenced)",
    "```",
    "~~~",
    "[[tilde]]",
    "~~~",
    "after [yes](yes)",
  ].join("\n");
  assert.deepEqual(extractReferences(undefined, body), [
    { asWritten: "[[yes]]", target: "yes" },
    { asWritten: "[yes](yes)", target: "yes" },
  ]);
});

test("frontmatter extracts only whole-value wikilinks at any depth", () => {
  const frontmatter = {
    direct: "[[one|alias]]",
    nested: [{ link: "![[two#heading]]" }],
    prose: "see [[not-one]] here",
    markdown: "[not-two](somewhere)",
  };
  assert.deepEqual(extractReferences(frontmatter, ""), [
    { asWritten: "[[one|alias]]", target: "one" },
    { asWritten: "![[two#heading]]", target: "two" },
  ]);
});

test("suffix matching resolves a bare name and a deep suffix", () => {
  const files = ["archive/Some Note.md", "work/contacts/priya.md"];
  assert.equal(resolveReference("Some Note", "notes/current.md", files), "archive/Some Note.md");
  assert.equal(resolveReference("contacts/priya", "notes/current.md", files), "work/contacts/priya.md");
  assert.equal(resolveReference("riya", "notes/current.md", files), undefined);
});

test("nearest suffix match wins and equal-distance ties are lexicographic", () => {
  const files = [
    "elsewhere/topic.md",
    "projects/near/topic.md",
    "projects/a/topic.md",
    "projects/z/topic.md",
  ];
  assert.equal(resolveReference("topic", "projects/near/note.md", files), "projects/near/topic.md");
  assert.equal(
    resolveReference("topic", "projects/middle/note.md", ["projects/z/topic.md", "projects/a/topic.md"]),
    "projects/a/topic.md",
  );
  assert.equal(
    resolveReference("t", "a/b/note.md", ["a/t.md", "a/b/c/d/t.md"]),
    "a/t.md",
  );
});

test("skips absent and non-mapping frontmatter while still scanning the body", () => {
  assert.deepEqual(extractReferences(undefined, "[[body]]"), [{ asWritten: "[[body]]", target: "body" }]);
  assert.deepEqual(extractReferences(["[[frontmatter-list]]"], "[[body]]"), [
    { asWritten: "[[body]]", target: "body" },
  ]);
});

test("frontmatter and body agree on bracket and carriage-return wikilink boundaries", () => {
  const frontmatter = { bracket: "[[a[b]]", carriageReturn: "[[a\rb]]", valid: "[[ab]]" };
  assert.deepEqual(extractReferences(frontmatter, "[[a[b]] [[a\rb]] [[ab]]"), [
    { asWritten: "[[ab]]", target: "ab" },
    { asWritten: "[[ab]]", target: "ab" },
  ]);
});

test("note-relative targets resolve after normalization", () => {
  const files = ["notes/day/peer.md", "notes/shared/person.md"];
  assert.equal(resolveReference("./peer", "notes/day/current.md", files), "notes/day/peer.md");
  assert.equal(resolveReference("../shared/person", "notes/day/current.md", files), "notes/shared/person.md");
  assert.equal(resolveReference("../day/./peer", "notes/day/current.md", files), "notes/day/peer.md");
});

test("note-relative targets that escape the vault do not resolve", () => {
  assert.equal(resolveReference("../../outside", "notes/current.md", ["outside.md"]), undefined);
});

test("vault-absolute targets match only from the vault root", () => {
  const files = ["contact.md", "nested/contact.md"];
  assert.equal(resolveReference("/contact", "notes/current.md", files), "contact.md");
  assert.equal(resolveReference("/nested/contact", "notes/current.md", files), "nested/contact.md");
  assert.equal(resolveReference("/missing/contact", "notes/current.md", files), undefined);
});

test("literal matches are preferred over .md fallback matches", () => {
  const files = ["far/item", "notes/item.md"];
  assert.equal(resolveReference("item", "notes/current.md", files), "far/item");
  assert.equal(resolveReference("missing", "notes/current.md", ["notes/missing.md"]), "notes/missing.md");
});

test("folders cannot satisfy a target because the index contains files only", () => {
  assert.equal(resolveReference("folder", "notes/current.md", ["folder/child.md"]), undefined);
  assert.equal(resolveReference("folder", "notes/current.md", ["folder/child.md", "folder.md"]), "folder.md");
});

test("comparison normalizes Unicode while returning the indexed path", () => {
  const stored = `contacts/${"Café".normalize("NFD")}.md`;
  assert.equal(resolveReference("Café", "notes/current.md", [stored]), stored);
});
