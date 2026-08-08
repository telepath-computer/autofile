import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";

import { check, type CheckResult, type Finding, type Rule } from "@telepath-computer/autofile";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function vault(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-check-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(entries)) {
    if (path.endsWith("/")) await mkdir(join(root, path), { recursive: true });
    else {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
  }
  return root;
}

function findings(result: CheckResult, rule: Rule): Finding[] {
  return result.findings.filter((finding) => finding.rule === rule);
}

test("an Obsidian-shaped vault with a config declaring nothing has no findings and counts nothing", async () => {
  const root = await vault({
    "autofile.yml": "# Deliberately declares nothing.\n",
    ".obsidian/workspace.json": "{}",
    "Daily Notes/2026-08-08.md": "[[Mira Holt]]\n",
    "People/Mira Holt.md": "---\nname: Mira\n---\n",
    "Templates/Person.md": "---\nname: {{name}}\n---\n",
    ["Archive/cafe\u0301.md"]: "NFD filename\n",
  });
  assert.deepEqual(await check(root), { findings: [], filesChecked: 0 });
});

test("config read, parse, and validation failures are the only findings", async () => {
  const cases: Array<Record<string, string>> = [
    { "notes/bad.md": "---\nx: [\n---\n" },
    { "autofile.yml": "paths: [\n", "notes/bad.md": "---\nx: [\n---\n" },
    { "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    shema: {}\n", "notes/bad.md": "x" },
  ];
  for (const entries of cases) {
    const result = await check(await vault(entries));
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings.every((finding) => finding.rule === "config" && finding.file === "autofile.yml"));
    assert.equal(result.filesChecked, 0);
  }
  assert.deepEqual(await check(await vault({ "autofile.yml": "# valid empty config\n" })), {
    findings: [], filesChecked: 0,
  });
});

test("description alone governs its subtree and activates parse, name, collision, and links only there", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  /Notes:\n    description: Notes only\n",
    "Notes/broken.md": "---\nx: [\n---\n",
    "Notes/control\u0007.md": "",
    "Notes/Twin.md": "",
    "Notes/twin.md": "[[missing]]\n",
    "Outside/broken.md": "---\nx: [\n---\n[[also-missing]]\n",
  });
  const result = await check(root);
  assert.equal(result.filesChecked, 4);
  assert.equal(findings(result, "parse").length, 1);
  assert.equal(findings(result, "name").length, 1);
  assert.equal(findings(result, "collision").length, 2);
  assert.equal(findings(result, "internal_links.resolve").length, 1);
  assert.ok(result.findings.every((finding) => finding.file?.startsWith("Notes/") ?? true));
});

test("parse accepts absent or mapping frontmatter and reports invalid YAML and non-mappings", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /n:\n    description: Notes\n",
    "n/plain.md": "body",
    "n/map.md": "---\na: 1\n---\n",
    "n/yaml.md": "---\na: [\n---\n",
    "n/list.md": "---\n- a\n---\n",
    "n/null.md": "---\nnull\n---\n",
  }));
  assert.deepEqual(findings(result, "parse").map((finding) => finding.file), ["n/list.md", "n/null.md", "n/yaml.md"]);
});

test("schema reports every failure while valid frontmatter passes", async () => {
  const result = await check(await vault({
    "autofile.yml": ["paths:", "  /people:", "    description: People", "    schema:",
      "      type: object", "      required: [name, age]", "      properties:",
      "        name: { type: string }", "        age: { type: integer }", ""].join("\n"),
    "people/good.md": "---\nname: Mira\nage: 3\n---\n",
    "people/bad.md": "---\nname: 7\n---\n",
  }));
  assert.equal(findings(result, "schema").length, 2);
  assert.ok(findings(result, "schema").every((finding) => finding.file === "people/bad.md"));
});

test("schema messages cover additional fields and integer, object, array, and null types", async () => {
  const result = await check(await vault({
    "autofile.yml": `paths:
  /n:
    schema:
      type: object
      additionalProperties: false
      properties:
        integer: { type: integer }
        object: { type: object }
        array: { type: array }
        null: { type: "null" }
`,
    "n/bad.md": "---\ninteger: nope\nobject: nope\narray: nope\nnull: nope\nextra: nope\n---\n",
  }));
  assert.deepEqual(findings(result, "schema").map(({ message }) => message), [
    "array must be an array",
    "extra is not an allowed field",
    "integer must be an integer",
    "null must be null",
    "object must be an object",
  ]);
});

test("symbolic links are skipped rather than traversed as vault content", async () => {
  const root = await vault({ "autofile.yml": "strict: true\n" });
  const target = await mkdtemp(join(tmpdir(), "autofile-symlink-target-"));
  roots.push(target);
  await writeFile(join(target, "note.md"), "outside the vault\n");
  await symlink(target, join(root, "linked"), "dir");
  assert.deepEqual(await check(root), { findings: [], filesChecked: 0 });
});

test("body.allowed rejects non-whitespace bodies and accepts absent or whitespace-only bodies", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /data:\n    description: Data\n    body:\n      allowed: false\n",
    "data/empty.md": "---\na: 1\n---\n \t\n",
    "data/full.md": "---\na: 1\n---\nprose\n",
  }));
  assert.deepEqual(findings(result, "body.allowed").map((finding) => finding.file), ["data/full.md"]);
});

test("extensions rejects only extensions outside the declared list", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /assets:\n    description: Assets\n    extensions: [pdf, png]\n",
    "assets/good.pdf": "%PDF", "assets/good.png": "png", "assets/bad.md": "text",
  }));
  assert.deepEqual(findings(result, "extensions").map((finding) => finding.file), ["assets/bad.md"]);
});

test("filenames.pattern checks every segment below the entry and strips the file extension", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    filenames:\n      pattern: '^[a-z-]+$'\n",
    "notes/good-name.md": "", "notes/Bad/name.md": "", "notes/Bad Folder/Bad Name.md": "",
  }));
  assert.deepEqual(findings(result, "filenames.pattern").map((finding) => finding.file), [
    "notes/Bad Folder/Bad Name.md", "notes/Bad Folder/Bad Name.md", "notes/Bad/name.md",
  ]);
});

test("a file named .md has no extension, is not a note, and filenames.pattern matches its whole name", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    schema:\n      required: [target]\n    extensions: [md]\n    filenames:\n      pattern: '^\\.md$'\n    ignore:\n      dotfiles: false\n",
    "notes/.md": "---\nnot: valid: yaml\n---\n",
  }));
  assert.deepEqual(result, {
    findings: [{ rule: "extensions", severity: "violation", file: "notes/.md", message: "no extension is not among the extensions this path holds" }],
    filesChecked: 1,
  });
});

test("whole-value frontmatter wikilinks are typed while body wikilinks must use the prose format", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    internal_links:\n      format: markdown-relative\n",
    "notes/source.md": "---\ntarget: '[[target]]'\n---\n[[target]]\n",
    "notes/target.md": "",
  }));
  assert.deepEqual(result, {
    findings: [{ rule: "internal_links.format", severity: "violation", file: "notes/source.md", message: "[[target]] is not markdown-relative" }],
    filesChecked: 2,
  });
});

test("invalid and non-mapping frontmatter skip typed links but still scan the body", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n",
    "notes/invalid.md": "---\nbroken: [\n---\n[[body-invalid]]",
    "notes/list.md": "---\n- '[[frontmatter-list]]'\n---\n[[body-list]]",
  }));
  assert.deepEqual(findings(result, "internal_links.resolve").map((finding) => finding.message), [
    "[[body-invalid]] does not exist",
    "[[body-list]] does not exist",
  ]);
  assert.equal(findings(result, "parse").length, 2);
});

test("internal link format distinguishes wikilinks, relative markdown, and absolute markdown", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  /wiki:\n    description: Wiki\n    internal_links:\n      format: wikilink\n  /relative:\n    description: Relative\n    internal_links:\n      format: markdown-relative\n  /absolute:\n    description: Absolute\n    internal_links:\n      format: markdown-absolute\n",
    "target.md": "",
    "wiki/good.md": "[[target]]", "wiki/bad.md": "[t](/target.md)",
    "relative/good.md": "[t](../target.md)", "relative/bad.md": "[[target]]",
    "absolute/good.md": "[t](/target.md)", "absolute/bad.md": "[t](../target.md)",
  });
  assert.deepEqual(findings(await check(root), "internal_links.format").map((finding) => finding.file), [
    "absolute/bad.md", "relative/bad.md", "wiki/bad.md",
  ]);
});

test("dead links warn once per occurrence while ignored and undeclared target files resolve", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    ignore:\n      pattern: '^ignored$'\n",
    "notes/source.md": "[[ignored/hidden]] [[Outside Target]] [[gone]] [[gone]]",
    "notes/ignored/hidden.md": "---\nbroken: [\n---\n",
    "Elsewhere/Outside Target.md": "",
  }));
  assert.equal(result.filesChecked, 1);
  const dead = findings(result, "internal_links.resolve");
  assert.equal(dead.length, 2);
  assert.ok(dead.every((finding) => finding.severity === "warning" && finding.message.includes("[[gone]]")));
});

test("wikilink and markdown headings resolve while a dead markdown link still warns", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /n:\n    description: Notes\n",
    "n/a.md": "[[n/roadmap#goals]] [relative](roadmap.md#goals) [encoded](Some%20Note.md#goals) [dead](missing.md#goals)",
    "n/roadmap.md": "# Goals\n",
    "n/Some Note.md": "# Goals\n",
  }));
  assert.deepEqual(findings(result, "internal_links.resolve"), [
    {
      rule: "internal_links.resolve",
      severity: "warning",
      file: "n/a.md",
      message: "[dead](missing.md#goals) does not exist",
    },
  ]);
});

test("internal_links.resolve false suppresses dead-link warnings", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n    internal_links:\n      resolve: false\n",
    "notes/x.md": "[[missing]]",
  }));
  assert.deepEqual(findings(result, "internal_links.resolve"), []);
});

test("strict reports each undeclared file, does not report declared files, and counts both", async () => {
  const result = await check(await vault({
    "autofile.yml": "strict: true\npaths:\n  /notes:\n    description: Notes\n",
    "notes/declared.txt": "", "loose.txt": "", "other/deep.txt": "",
  }));
  assert.deepEqual(findings(result, "strict").map((finding) => finding.file), ["loose.txt", "other/deep.txt"]);
  assert.equal(result.filesChecked, 3);
});

test("strict accepts files under both described and undescribed path entries", async () => {
  const result = await check(await vault({
    "autofile.yml": "strict: true\npaths:\n  /described:\n    description: Notes\n  /rules-only:\n    extensions: [md]\n",
    "described/a.md": "", "rules-only/b.md": "", "loose.md": "",
  }));
  assert.deepEqual(findings(result, "strict").map((finding) => finding.file), ["loose.md"]);
  assert.equal(result.filesChecked, 3);
});

test("collision reports both governed paths, while distinct paths do not collide", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n",
    "notes/A.md": "", "notes/a.md": "", "notes/b.md": "",
  }));
  assert.deepEqual(findings(result, "collision"), [
    { rule: "collision", severity: "violation", file: "notes/A.md", message: 'collides with "notes/a.md"' },
    { rule: "collision", severity: "violation", file: "notes/a.md", message: 'collides with "notes/A.md"' },
  ]);
});

test("missing warns only for an absent declared folder", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /missing:\n    description: Missing\n  /empty:\n    description: Empty\n  /ignored-only:\n    description: Ignored\n    ignore:\n      pattern: '^ignored\\.txt$'\n  /full:\n    description: Full\n",
    "empty/": "", "ignored-only/ignored.txt": "", "full/x.txt": "",
  }));
  assert.deepEqual(findings(result, "missing"), [
    { rule: "missing", severity: "warning", file: "missing", message: "declared path is missing" },
  ]);
});

test("missing compares configured and on-disk paths after Unicode normalization", async () => {
  const result = await check(await vault({
    "autofile.yml": "paths:\n  /caf\u00e9:\n    extensions: [md]\n",
    ["cafe\u0301/note.md"]: "",
  }));
  assert.deepEqual(findings(result, "missing"), []);
  assert.equal(result.filesChecked, 1);
});

test("findings are deterministic and ordered by severity, path, rule, then message", async () => {
  const root = await vault({
    "autofile.yml": "strict: true\npaths:\n  /n:\n    description: Notes\n    schema:\n      required: [z, a]\n",
    "n/b.md": "[[missing]]", "n/a.md": "---\nx: 1\n---\n[[missing]]", "loose.txt": "",
  });
  const first = await check(root);
  assert.deepEqual(await check(root), first);
  assert.equal(first.findings.length, 7);
  const keys = first.findings.map((finding) => `${finding.severity === "violation" ? 0 : 1}\0${finding.file}\0${finding.rule}\0${finding.message}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("progress fires once per governed file with the governed running count", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  /n:\n    description: Notes\n", "n/a.md": "", "n/b.md": "", "outside.md": "",
  });
  const progress: number[] = [];
  const result = await check(root, { onFile: (count) => progress.push(count) });
  assert.deepEqual(progress, [1, 2]);
  assert.equal(result.filesChecked, 2);
});

test("check scales to 5000 linked notes without scanning the vault per link", async () => {
  const entries: Record<string, string> = {
    "autofile.yml": "paths:\n  /notes:\n    description: Notes\n",
  };
  for (let index = 0; index < 5000; index++) {
    entries[`notes/${index}.md`] = `[[${(index + 1) % 5000}]]`;
  }
  const root = await vault(entries);

  const started = performance.now();
  const result = await check(root);
  const elapsed = performance.now() - started;

  assert.equal(result.filesChecked, 5000);
  assert.deepEqual(result.findings, []);
  // Indexed checks normally finish in a few seconds. Eight seconds leaves
  // generous headroom on a loaded machine but fails the 17s quadratic probe.
  assert.ok(elapsed < 8000, `check took ${Math.round(elapsed)}ms`);
});
