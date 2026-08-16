import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("config failures are the sole finding and the version gate does not cascade", async () => {
  for (const config of [
    "strict: true\nfolders: []\n",
    "version: 2\nstrict: true\n",
    "version: 1\nfolders:\n  - path: contacts\n    shema: {}\n",
    "version: 1\nfolders: [\n",
  ]) {
    const result = await check(await vault({
      "autofile.yml": config,
      "outside.txt": "uncovered",
      "notes/bad.md": "---\nx: [\n---\n",
    }));
    assert.equal(result.filesChecked, 0);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0], {
      rule: "config",
      severity: "violation",
      file: "autofile.yml",
      message: result.findings[0]!.message,
    });
  }
  const missing = await check(await vault({ "autofile.yml": "strict: true\n" }));
  assert.match(missing.findings[0]!.message, /migrate.*version 1/u);
  const unknown = await check(await vault({ "autofile.yml": "version: 3\n" }));
  assert.equal(unknown.findings[0]!.message, "version 3 is not understood");
});

test("out-of-scope files are silent unless strict turns them into coverage findings", async () => {
  const entries = {
    "autofile.yml": "version: 1\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/kept.md": "",
    "journal/2026-08-15.md": "",
    "loose.txt": "",
    ".obsidian/workspace.json": "{}",
    "skip-this.txt": "",
  };
  const scoped = await check(await vault(entries));
  assert.deepEqual(scoped, { findings: [], filesChecked: 1 });

  const strict = await check(await vault({
    ...entries,
    "autofile.yml": "version: 1\nstrict: true\nignore: ['^skip', '^\\.']\nfolders:\n  - path: notes\n    description: Notes.\n",
  }));
  assert.deepEqual(findings(strict, "coverage").map(({ file }) => file), [
    "journal/2026-08-15.md",
    "loose.txt",
  ]);
  assert.equal(strict.filesChecked, 3);
});

test("a dot entry governs root files and all otherwise-unclaimed subtrees", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: .\n    description: Everything.\n    extensions: [md, txt]\n",
    "root.txt": "",
    "root.md": "",
    "nested/note.md": "",
  }));
  assert.deepEqual(result, { findings: [], filesChecked: 3 });
});

test("a nested folder entry replaces every parent statement wholesale", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: parent
    description: Restricted parent.
    schema: { required: [title] }
    extensions: [pdf]
    filename_pattern: 'parent-[a-z]+'
    body: none
    additional_subfolders: false
  - path: parent/free
    description: Unconstrained child.
`,
    "parent/parent-source.pdf": "",
    "parent/free/Bad Name.md": "free prose",
    "parent/free/deep/arbitrary.xyz": "",
  }));
  assert.deepEqual(result, { findings: [], filesChecked: 3 });
});

test("governed note frontmatter must parse as a mapping", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/plain.md": "body",
    "notes/map.md": "---\na: 1\n---\n",
    "notes/empty.md": "---\n---\n",
    "notes/yaml.md": "---\na: [\n---\n",
    "notes/list.md": "---\n- a\n---\n",
    "notes/null.md": "---\nnull\n---\n",
  }));
  assert.deepEqual(findings(result, "parse").map(({ file }) => file), [
    "notes/list.md",
    "notes/null.md",
    "notes/yaml.md",
  ]);
});

test("folder schemas report every failure and absent frontmatter is an empty object", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: people
    description: People.
    schema:
      type: object
      additionalProperties: false
      required: [name, age]
      properties:
        name: { type: string }
        age: { type: integer }
`,
    "people/good.md": "---\nname: Mira\nage: 3\n---\n",
    "people/bad.md": "---\nname: 7\nextra: true\n---\n",
    "people/empty.md": "",
  }));
  assert.equal(findings(result, "schema").length, 5);
  assert.ok(findings(result, "schema").every(({ file }) => file === "people/bad.md" || file === "people/empty.md"));
  assert.ok(findings(result, "schema").some(({ message }) => message === "extra is not an allowed field"));
  assert.ok(findings(result, "schema").some(({ message }) => message === "name must be a string"));
});

test("body none rejects non-whitespace bodies in notes only", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: data\n    description: Data.\n    body: none\n",
    "data/empty.md": "---\na: 1\n---\n \t\n",
    "data/full.md": "---\na: 1\n---\nprose\n",
    "data/source.txt": "ordinary non-note body",
  }));
  assert.deepEqual(findings(result, "body"), [
    { rule: "body", severity: "violation", file: "data/full.md", message: "body is not allowed" },
  ]);
});

test("raw bodies are left uninterpreted and produce no link findings", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: raw
    description: Raw records.
    body: raw
`,
    "raw/source.md": "[wrong](missing) [[missing]]\n",
  }));
  assert.deepEqual(result, { findings: [], filesChecked: 1 });
});

test("markdown bodies retain link scanning", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: markdown
    description: Markdown notes.
    body: markdown
`,
    "markdown/source.md": "[wrong](missing) [[missing]]\n",
  }));
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), [
    { file: "markdown/source.md", rule: "link_format" },
    { file: "markdown/source.md", rule: "resolve" },
    { file: "markdown/source.md", rule: "resolve" },
  ]);
});

test("a dot-only .md name is extensionless rather than a note", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: notes
    description: Files.
    schema: false
    body: none
`,
    "notes/.md": "ordinary non-note content",
  }));
  assert.deepEqual(result, { findings: [], filesChecked: 1 });
});

test("vault filename patterns bind notes, while a folder override binds every file", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
filename_pattern: '[a-z-]+'
folders:
  - path: lower
    description: Vault pattern.
  - path: upper
    description: Folder pattern.
    filename_pattern: '[A-Z]+'
`,
    "lower/good-name.md": "",
    "lower/Bad.md": "",
    "lower/Bad.PDF": "",
    "upper/GOOD.md": "",
    "upper/GOOD.PDF": "",
    "upper/Bad.md": "",
    "upper/Bad.PDF": "",
  }));
  assert.deepEqual(findings(result, "filename_pattern").map(({ file }) => file), [
    "lower/Bad.md",
    "upper/Bad.PDF",
    "upper/Bad.md",
  ]);
});

test("nested entries independently constrain extensions case-insensitively", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: assets
    description: Documents.
    extensions: [pdf]
  - path: assets/images
    description: Images.
    extensions: [png]
`,
    "assets/manual.PDF": "",
    "assets/manual.txt": "",
    "assets/archive.tar.gz": "",
    "assets/note.md": "",
    "assets/images/photo.PNG": "",
    "assets/images/photo.pdf": "",
    "assets/images/deep/photo.png": "",
  }));
  assert.deepEqual(findings(result, "extensions").map(({ file }) => file), [
    "assets/archive.tar.gz",
    "assets/images/photo.pdf",
    "assets/manual.txt",
    "assets/note.md",
  ]);
});

test("extension matching uses Unicode case folding", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: assets\n    description: Assets.\n    extensions: [οσ]\n",
    "assets/file.ΟΣ": "",
  }));
  assert.deepEqual(findings(result, "extensions"), []);
});

test("extensionless files need an omitted or wildcard extension constraint", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: open
    description: Omitted.
  - path: wildcard
    description: Explicit wildcard.
    extensions: ['*']
  - path: closed
    description: Nothing accepted.
    extensions: []
`,
    "open/README": "",
    "open/file.anything": "",
    "wildcard/README": "",
    "wildcard/file.anything": "",
    "closed/README": "",
    "closed/file.txt": "",
  }));
  assert.deepEqual(findings(result, "extensions").map(({ file }) => file), ["closed/README", "closed/file.txt"]);
});

test("additional_subfolders false permits declared carve-outs and reports undeclared folders", async () => {
  const result = await check(await vault({
    "autofile.yml": `version: 1
folders:
  - path: closed
    description: No extra folders.
    additional_subfolders: false
  - path: closed/allowed
    description: Explicit carve-out.
`,
    "closed/direct.txt": "",
    "closed/allowed/deep/file.txt": "",
    "closed/extra/file.txt": "",
    "closed/empty/": "",
  }));
  assert.deepEqual(findings(result, "additional_subfolders"), [
    {
      rule: "additional_subfolders",
      severity: "violation",
      file: "closed/empty",
      message: "subfolder is not allowed by folders closed",
    },
    {
      rule: "additional_subfolders",
      severity: "violation",
      file: "closed/extra",
      message: "subfolder is not allowed by folders closed",
    },
  ]);
  assert.equal(result.filesChecked, 3);
});

test("missing descriptions and missing declared folders are advisory", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: absent\n  - path: empty\n    description: Empty.\n",
    "empty/": "",
  }));
  assert.deepEqual(findings(result, "description"), [
    { rule: "description", severity: "warning", file: "absent", message: "folder entry has no description" },
  ]);
  assert.deepEqual(findings(result, "missing"), [
    { rule: "missing", severity: "warning", file: "absent", message: "declared path is missing" },
  ]);
  assert.equal(result.filesChecked, 0);
});

test("a regular file at a declared path leaves it missing and is otherwise judged normally", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nstrict: true\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes": "not a folder",
  }));
  assert.deepEqual(result.findings, [
    { rule: "coverage", severity: "violation", file: "notes", message: "no folder entry accounts for this file" },
    { rule: "missing", severity: "warning", file: "notes", message: "declared path is missing" },
  ]);
  assert.equal(result.filesChecked, 1);
});

test("missing-folder comparison normalizes Unicode and recognizes the root entry", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: .\n    description: Root.\n  - path: café\n    description: Café.\n",
    [`${"café".normalize("NFD")}/photo.jpg`]: "",
  }));
  assert.deepEqual(findings(result, "missing"), []);
});

test("collision checks governed files only; ignored and out-of-scope files are invisible", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nignore: ['^ignored']\nfolders:\n  - path: files\n    description: Files.\n",
    "files/A.md": "",
    "files/a.md": "",
    "files/ignoredA.md": "",
    "files/ignoreda.md": "",
    "outside/B.md": "",
    "outside/b.md": "",
  }));
  assert.deepEqual(findings(result, "collision"), [
    { rule: "collision", severity: "violation", file: "files/A.md", message: 'collides with "files/a.md"' },
    { rule: "collision", severity: "violation", file: "files/a.md", message: 'collides with "files/A.md"' },
  ]);
  assert.deepEqual(findings(result, "coverage"), []);
  assert.equal(result.filesChecked, 2);
});

test("collision includes the ancestor paths of governed files", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: files\n    description: Files.\n",
    "files/A/x.txt": "",
    "files/a/y.txt": "",
  }));
  assert.deepEqual(findings(result, "collision").map(({ file }) => file), ["files/A", "files/a"]);
});

test("collision comparison uses Unicode case folding", async () => {
  const result = await check(await vault({
    "autofile.yml": "version: 1\nfolders:\n  - path: files\n    description: Files.\n",
    "files/ΟΣ/x.txt": "",
    "files/οσ/y.txt": "",
  }));
  assert.deepEqual(findings(result, "collision").map(({ file }) => file), ["files/ΟΣ", "files/οσ"]);
});

test("symbolic links are skipped rather than traversed", async () => {
  const root = await vault({ "autofile.yml": "version: 1\n" });
  const target = await mkdtemp(join(tmpdir(), "autofile-symlink-target-"));
  roots.push(target);
  await writeFile(join(target, "note.md"), "outside\n");
  await symlink(target, join(root, "linked"), "dir");
  assert.deepEqual(await check(root), { findings: [], filesChecked: 0 });
});

test("findings are deterministic and ordered by severity, path, rule, then message", async () => {
  const root = await vault({
    "autofile.yml": "version: 1\nstrict: true\nfolders:\n  - path: notes\n    schema:\n      required: [z, a]\n",
    "notes/b.md": "",
    "notes/a.md": "",
    "loose.txt": "",
  });
  const first = await check(root);
  assert.deepEqual(await check(root), first);
  const keys = first.findings.map((finding) => `${finding.severity === "violation" ? 0 : 1}\0${finding.file}\0${finding.rule}\0${finding.message}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("progress and the count include governed files and strict coverage failures only", async () => {
  const root = await vault({
    "autofile.yml": "version: 1\nstrict: true\nignore: ['^skip']\nfolders:\n  - path: notes\n    description: Notes.\n",
    "notes/a.md": "",
    "outside.txt": "",
    "skip-this.txt": "",
  });
  const progress: number[] = [];
  const result = await check(root, { onFile: (count) => progress.push(count) });
  assert.deepEqual(progress, [1, 2]);
  assert.equal(result.filesChecked, 2);
});
