import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { check, starterConfig, type CheckResult, type Finding } from "@telepath-computer/autofile";

// A small strict-idiom config for targeted tests.
const strictConfig = [
  "global:",
  "  ignore:",
  "    pattern: '^\\.'",
  "  filenames:",
  "    pattern: '^[a-z0-9][a-z0-9-]*$'",
  "  assets:",
  "    allowed: false",
  "paths:",
  "  contacts:",
  "    description: People.",
  "    records:",
  "      schema:",
  "        required: [name, type]",
  "        properties:",
  "          name: { type: string }",
  "          type: { enum: [person, organization] }",
  "      body:",
  "        allowed: false",
  "  notes:",
  "    description: Notes.",
  "    records: {}",
  "  assets:",
  "    description: Files.",
  "    assets:",
  "      allowed: true",
  "",
].join("\n");

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * Builds a vault on disk from a map of vault-relative paths to contents;
 * a path ending in "/" creates an empty folder.
 */
async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autofile-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      await mkdir(join(root, path), { recursive: true });
    } else {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
  return root;
}

function byRule(result: CheckResult, rule: string): Finding[] {
  return result.findings.filter((finding) => finding.rule === rule);
}

function violations(result: CheckResult): Finding[] {
  return result.findings.filter((finding) => finding.severity === "violation");
}

// --- config ---

// vault.md: "An `autofile.yml` that cannot be read, does not parse, or does
// not match the above makes the vault invalid; nothing else is checked".
test("a missing config is a config violation and nothing else is checked", async () => {
  const root = await vault({ "stray.txt": "x", "junk/deep.md": "---\nbad: [\n---\n" });
  const result = await check(root);
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) {
    assert.equal(finding.rule, "config");
    assert.equal(finding.severity, "violation");
  }
  assert.match(result.findings[0]!.message, /cannot be read/);
  assert.equal(result.filesChecked, 0);
});

test("an unparseable config is a config violation", async () => {
  const root = await vault({ "autofile.yml": "global: [unclosed\n" });
  const result = await check(root);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.rule, "config");
  assert.match(result.findings[0]!.message, /does not parse/);
  assert.equal(result.filesChecked, 0);
});

test("an invalid config reports config findings only, however broken the vault", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    records: {}\n", // missing description
    "loose.txt": "x",
    "undeclared/x.md": "no frontmatter",
  });
  const result = await check(root);
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) assert.equal(finding.rule, "config");
  assert.equal(result.filesChecked, 0);
});

// --- the starter shape ---

// cli.md starter on a fresh-init-shaped vault: no violations; the declared
// folders are empty, which is the legitimate fresh state — warnings only.
test("the starter config passes clean on a fresh-init-shaped vault", async () => {
  const root = await vault({
    "autofile.yml": starterConfig,
    "datasets/": "",
    "assets/": "",
    "topics/": "",
  });
  const result = await check(root);
  assert.deepEqual(violations(result), []);
  assert.equal(result.findings.length, 3);
  for (const finding of result.findings) {
    assert.equal(finding.rule, "empty");
    assert.equal(finding.severity, "warning");
  }
  assert.deepEqual(
    result.findings.map((finding) => finding.file).sort(),
    ["assets", "datasets", "topics"],
  );
  assert.equal(result.filesChecked, 0);
});

test("a populated valid starter vault has no findings", async () => {
  const root = await vault({
    "autofile.yml": starterConfig,
    "datasets/pets.md": "---\ntitle: Pets\ndescription: Our pets.\ndata: [1, 2]\n---\n",
    "assets/photo.jpg": "not really a jpeg",
    "topics/autofile.md": "---\ntitle: Autofile\ndescription: The filing system.\n---\n\nNotes here.\n",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 3);
});

// --- parse ---

test("a governed record whose frontmatter is not valid YAML is a parse violation", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/jules-verne.md": "---\nname: [unclosed\n---\n",
  });
  const result = await check(root);
  const parse = byRule(result, "parse");
  assert.equal(parse.length, 1);
  assert.equal(parse[0]!.severity, "violation");
  assert.equal(parse[0]!.file, "contacts/jules-verne.md");
  assert.match(parse[0]!.message, /not valid YAML/);
  // A parse failure precludes schema and body checks for the file.
  assert.equal(byRule(result, "schema").length, 0);
  assert.equal(byRule(result, "body").length, 0);
});

// vault.md: "When present, the block must parse to a mapping" — a
// structural rule of its own; a non-mapping is a parse violation and is
// not schema-checked.
for (const [shape, frontmatter] of [
  ["a scalar", "42"],
  ["a sequence", "- a\n- b"],
  ["a bare string", "just a string"],
] as const) {
  test(`frontmatter that parses to ${shape} is a parse violation, not schema-checked`, async () => {
    const root = await vault({
      "autofile.yml": strictConfig,
      "contacts/odd.md": `---\n${frontmatter}\n---\n`,
    });
    const result = await check(root);
    const parse = byRule(result, "parse");
    assert.equal(parse.length, 1);
    assert.equal(parse[0]!.severity, "violation");
    assert.equal(parse[0]!.file, "contacts/odd.md");
    assert.match(parse[0]!.message, /not a mapping/);
    assert.equal(byRule(result, "schema").length, 0);
    assert.deepEqual(violations(result), parse);
  });
}

// vault.md: "A record with no frontmatter is checked as an empty object" —
// an empty block parses to null and stays {}, not a parse violation.
test("an empty frontmatter block is checked as an empty object, not a parse violation", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/blank-block.md": "---\n---\n",
  });
  const result = await check(root);
  assert.equal(byRule(result, "parse").length, 0);
  const schema = byRule(result, "schema");
  assert.ok(schema.length >= 1);
  for (const finding of schema) assert.match(finding.message, /required/);
});

// cli.md: "a file no entry governs has nothing to violate" — an ungoverned
// .md is never parsed.
test("an ungoverned record is not parsed at all", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    "notes/broken.md": "---\nname: [unclosed\n---\n",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 1);
});

// --- schema ---

test("schema findings are plain prose per field", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/jules-verne.md": "---\nname: 42\ntype: person\n---\n",
  });
  const result = await check(root);
  const schema = byRule(result, "schema");
  assert.equal(schema.length, 1);
  assert.equal(schema[0]!.severity, "violation");
  assert.equal(schema[0]!.file, "contacts/jules-verne.md");
  // cli.md's example message, verbatim.
  assert.equal(schema[0]!.message, "name must be a string");
});

test("a missing required field is reported by name", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/nameless.md": "---\ntype: person\n---\n",
  });
  const result = await check(root);
  const schema = byRule(result, "schema");
  assert.equal(schema.length, 1);
  assert.match(schema[0]!.message, /^name\b/);
  assert.match(schema[0]!.message, /required/);
});

test("an enum failure names the allowed values", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/pet.md": "---\nname: Rex\ntype: dog\n---\n",
  });
  const result = await check(root);
  const schema = byRule(result, "schema");
  assert.equal(schema.length, 1);
  assert.match(schema[0]!.message, /^type /);
  assert.match(schema[0]!.message, /person/);
  assert.match(schema[0]!.message, /organization/);
});

test("nested failures use dotted paths", async () => {
  const root = await vault({
    "autofile.yml": [
      "paths:",
      "  contacts:",
      "    description: People.",
      "    records:",
      "      schema:",
      "        properties:",
      "          address:",
      "            type: object",
      "            properties:",
      "              city: { type: string }",
      "",
    ].join("\n"),
    "contacts/x.md": "---\naddress:\n  city: 7\n---\n",
  });
  const result = await check(root);
  const schema = byRule(result, "schema");
  assert.equal(schema.length, 1);
  assert.equal(schema[0]!.message, "address.city must be a string");
});

// vault.md: "A record with no frontmatter is checked as an empty object."
test("a record with no frontmatter is checked as an empty object", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/blank.md": "",
  });
  const result = await check(root);
  const schema = byRule(result, "schema");
  assert.ok(schema.length >= 1);
  for (const finding of schema) assert.match(finding.message, /required/);
});

test("every schema failure is reported, not just the first", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/bad.md": "---\nname: 42\ntype: dog\n---\n",
  });
  const result = await check(root);
  const messages = byRule(result, "schema").map((finding) => finding.message);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((message) => message.startsWith("name ")));
  assert.ok(messages.some((message) => message.startsWith("type ")));
});

// --- body ---

test("a body where body.allowed is false is a violation", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/chatty.md": "---\nname: A\ntype: person\n---\n\nSome prose.\n",
  });
  const result = await check(root);
  const body = byRule(result, "body");
  assert.equal(body.length, 1);
  assert.equal(body[0]!.severity, "violation");
  assert.equal(body[0]!.file, "contacts/chatty.md");
});

// vault.md: "Whitespace alone is no body."
test("whitespace below the frontmatter is no body", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/tidy.md": "---\nname: A\ntype: person\n---\n\n   \n\t\n",
  });
  const result = await check(root);
  assert.equal(byRule(result, "body").length, 0);
});

// vault.md: "Bodies are allowed by default."
test("bodies are allowed by default", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n    records: {}\n",
    "notes/x.md": "---\na: 1\n---\n\nA body.\n",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
});

// vault.md: frontmatter is "a YAML block opened and closed by a `---` line"
// — an unclosed block is not frontmatter, so the whole file is body.
test("an unterminated frontmatter block is body, not frontmatter", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/unclosed.md": "---\nname: A\ntype: person\n",
  });
  const result = await check(root);
  assert.equal(byRule(result, "body").length, 1);
  // The frontmatter is the empty object, so required fields are missing.
  assert.ok(byRule(result, "schema").length >= 1);
});

// --- asset ---

test("a non-record file where assets are forbidden is an asset violation", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/scan.pdf": "%PDF",
  });
  const result = await check(root);
  const asset = byRule(result, "asset");
  assert.equal(asset.length, 1);
  assert.equal(asset[0]!.severity, "violation");
  assert.equal(asset[0]!.file, "contacts/scan.pdf");
  assert.equal(asset[0]!.message, "not a record, in a path that forbids assets");
});

test("an asset in a path that allows assets is fine", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "assets/scan.pdf": "%PDF",
  });
  const result = await check(root);
  assert.equal(byRule(result, "asset").length, 0);
  assert.equal(result.filesChecked, 1);
});

// vault.md: "A `.md` file whose name begins with a dot is not a record" —
// and ".md" itself begins with a dot, so asset rules apply to it.
test("a file named exactly .md is not a record; asset rules apply", async () => {
  const config = [
    "global:",
    "  assets:",
    "    allowed: false",
    "paths:",
    "  notes:",
    "    description: Notes.",
    "    records:",
    "      schema:",
    "        required: [title]",
    "",
  ].join("\n");
  const root = await vault({
    "autofile.yml": config,
    "notes/.md": "",
    "notes/x.md": "",
  });
  const result = await check(root);
  const asset = byRule(result, "asset");
  assert.equal(asset.length, 1);
  assert.equal(asset[0]!.file, "notes/.md");
  const schema = byRule(result, "schema");
  assert.equal(schema.length, 1);
  assert.equal(schema[0]!.file, "notes/x.md");
  assert.match(schema[0]!.message, /title.*required/);
});

// vault.md: "A `.md` file whose name begins with a dot is not a record: a
// dot-leading name resolves literally, so no reference could reach it as
// one." It answers to asset rules, and its content is never parsed,
// schema-checked, or reference-scanned.
test("a dot-leading .md file is not a record: asset rules apply, content unscanned", async () => {
  const config = [
    "global:",
    "  assets:",
    "    allowed: false",
    "paths:",
    "  notes:",
    "    description: Notes.",
    "    records:",
    "      schema:",
    "        required: [title]",
    "",
  ].join("\n");
  const root = await vault({
    "autofile.yml": config,
    // Unparseable frontmatter and a dangling body link: were this a
    // record, parse and reference findings would fire.
    "notes/.hidden.md": "---\nbad: [\n---\n[[contacts/nowhere]]\n",
    "notes/x.md": "---\ntitle: t\n---\n",
  });
  const result = await check(root);
  const asset = byRule(result, "asset");
  assert.equal(asset.length, 1);
  assert.equal(asset[0]!.file, "notes/.hidden.md");
  assert.deepEqual(byRule(result, "parse"), []);
  assert.deepEqual(byRule(result, "schema"), []);
  assert.deepEqual(byRule(result, "reference"), []);
  assert.equal(result.filesChecked, 2);
});

test("with no assets block in force, any file is fine", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  misc:\n    description: Misc.\n",
    "misc/anything.bin": "\x00\x01",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
});

// --- root ---

// vault.md: "The root itself holds only the config and the declared
// folders: anything else at the root — a loose file, an undeclared folder —
// is a violation".
test("a loose file and an undeclared folder at the root are root violations", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    "notes/x.md": "hello",
    "loose.md": "hello",
    "undeclared/y.md": "hello",
  });
  const result = await check(root);
  const rootFindings = byRule(result, "root");
  assert.equal(rootFindings.length, 2);
  assert.deepEqual(
    rootFindings.map((finding) => finding.file).sort(),
    ["loose.md", "undeclared"],
  );
  for (const finding of rootFindings) assert.equal(finding.severity, "violation");
  // Files inside an undeclared folder are still checked and counted.
  assert.equal(result.filesChecked, 3);
});

// vault.md: "The config file itself is neither record nor asset ... `check`
// neither names it in a finding (beyond `config`) nor counts it."
test("autofile.yml is exempt from every rule and never counted", async () => {
  const root = await vault({
    // The strict global forbids assets and its filenames pattern would
    // reject the "autofile" stem, were the config governed.
    "autofile.yml": [
      "global:",
      "  filenames:",
      "    pattern: '^x$'",
      "  assets:",
      "    allowed: false",
      "paths:",
      "  x:",
      "    description: X.",
      "",
    ].join("\n"),
    "x/x.md": "",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 1);
});

// --- filename ---

test("a file's final segment is matched with its extension stripped", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "notes/Bad Name.md": "",
    "notes/good-name.md": "",
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  assert.equal(filename.length, 1);
  assert.equal(filename[0]!.severity, "violation");
  assert.equal(filename[0]!.file, "notes/Bad Name.md");
  assert.match(filename[0]!.message, /Bad Name/);
});

// The extension is from the last dot, so earlier dots stay in the matched
// stem — and the strict pattern forbids them.
test("only the last dot starts the extension", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "notes/report.final.md": "",
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  assert.equal(filename.length, 1);
  assert.match(filename[0]!.message, /report\.final/);
});

test("folder segments are matched unstripped", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "notes/sub.dir/x.md": "",
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  assert.equal(filename.length, 1);
  assert.equal(filename[0]!.file, "notes/sub.dir/x.md");
  assert.match(filename[0]!.message, /sub\.dir/);
});

// vault.md: "A folder's rules apply to its children, not to the folder
// itself" — a top-level folder's name answers to global's pattern, and
// segments below it to the entry's.
test("each segment answers to the pattern in force at its location", async () => {
  const root = await vault({
    "autofile.yml": [
      "global:",
      "  filenames:",
      "    pattern: '^[a-z]+$'",
      "paths:",
      "  notes:",
      "    description: Notes.",
      "    filenames:",
      "      pattern: '^[0-9]+$'",
      "",
    ].join("\n"),
    "notes/123.md": "", // entry pattern: ok
    "notes/abc.md": "", // entry pattern: fails
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  // "notes" itself passes global's pattern; only abc fails the entry's.
  assert.equal(filename.length, 1);
  assert.equal(filename[0]!.file, "notes/abc.md");
});

test("a segment with a control character is a filename violation", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    "notes/be\u0007p.md": "",
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  assert.equal(filename.length, 1);
  assert.match(filename[0]!.message, /control character/);
});

test("a segment that is not Unicode NFC is a filename violation", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    // "café" in decomposed (NFD) form: e + combining acute accent.
    "notes/cafe\u0301.md": "",
  });
  const result = await check(root);
  const filename = byRule(result, "filename");
  assert.equal(filename.length, 1);
  assert.match(filename[0]!.message, /NFC/);
});

// 255 UTF-8 bytes is the common per-segment filesystem limit; a name at
// exactly the limit is legal. (A longer one cannot be created on disk here,
// so the over-limit branch is covered by the checker's own bound.)
test("a 255-byte segment is legal", async () => {
  const name = "a".repeat(252) + ".md";
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    [`notes/${name}`]: "",
  });
  const result = await check(root);
  assert.equal(byRule(result, "filename").length, 0);
});

// --- collision ---

// vault.md: "two paths that differ only by case collide on a
// case-insensitive filesystem, so a vault may not contain them both."
test("two files differing only by case are a collision", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    "notes/alpha.md": "",
    "notes/Alpha.md": "",
  });
  const result = await check(root);
  const collision = byRule(result, "collision");
  assert.equal(collision.length, 2);
  assert.deepEqual(
    collision.map((finding) => finding.file).sort(),
    ["notes/Alpha.md", "notes/alpha.md"],
  );
  for (const finding of collision) {
    assert.equal(finding.severity, "violation");
    assert.match(finding.message, /case/);
  }
});

test("two folders differing only by case are a collision", async () => {
  const root = await vault({
    "autofile.yml": "paths:\n  notes:\n    description: Notes.\n",
    "notes/Sub/x.md": "",
    "notes/sub/y.md": "",
  });
  const result = await check(root);
  const collision = byRule(result, "collision");
  const files = collision.map((finding) => finding.file).sort();
  assert.deepEqual(files, ["notes/Sub", "notes/sub"]);
});

// --- empty ---

// cli.md: "`empty` — a described path whose folder is missing or empty."
test("a declared folder that is missing or empty is an empty warning", async () => {
  const root = await vault({
    "autofile.yml": [
      "paths:",
      "  present:",
      "    description: Present.",
      "  hollow:",
      "    description: Hollow.",
      "  absent:",
      "    description: Absent.",
      "",
    ].join("\n"),
    "present/x.md": "",
    "hollow/": "",
  });
  const result = await check(root);
  const empty = byRule(result, "empty");
  assert.equal(empty.length, 2);
  for (const finding of empty) assert.equal(finding.severity, "warning");
  assert.deepEqual(empty.map((finding) => finding.file).sort(), ["absent", "hollow"]);
  assert.match(empty.find((finding) => finding.file === "absent")!.message, /missing/);
  assert.match(empty.find((finding) => finding.file === "hollow")!.message, /empty/);
});

// --- ignore ---

// vault.md: "Ignored files are invisible to `check`" — not checked, not
// counted, subtree included.
test("ignored files and subtrees are invisible: unchecked and uncounted", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/ok.md": "---\nname: A\ntype: person\n---\n",
    "contacts/.trash/awful name.pdf": "x",
    "contacts/.draft.md": "---\nbroken: [\n---\n",
    ".obsidian/workspace.json": "{}",
    "notes/n.md": "",
    "assets/pic.jpg": "x",
  });
  const result = await check(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 3);
});

// --- symlinks ---

test("symlinks are not followed, checked, or counted", async () => {
  const outside = await mkdtemp(join(tmpdir(), "autofile-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "Bad Name.pdf"), "x");
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/ok.md": "---\nname: A\ntype: person\n---\n",
    "notes/n.md": "",
    "assets/pic.jpg": "x",
  });
  await symlink(outside, join(root, "contacts", "linked"));
  await symlink(join(outside, "Bad Name.pdf"), join(root, "contacts", "linked.pdf"));
  const result = await check(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesChecked, 3);
});

// --- determinism and ordering ---

test("findings come back violations first, then by file, then by rule; runs are deep-equal", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "contacts/zz.md": "---\nname: 42\ntype: person\n---\n\nA body.\n", // body + schema
    "contacts/aa.pdf": "x", // asset
    "loose.txt": "x", // root (and asset at the root under global)
    "notes/": "",
  });
  const first = await check(root);
  const second = await check(root);
  assert.deepEqual(first, second);

  const severities = first.findings.map((finding) => finding.severity);
  const firstWarning = severities.indexOf("warning");
  assert.ok(firstWarning > 0, "expected both severities");
  assert.ok(!severities.slice(firstWarning).includes("violation"), "violations precede warnings");

  const violationKeys = violations(first).map((finding) => `${finding.file ?? ""} ${finding.rule}`);
  assert.deepEqual(violationKeys, [...violationKeys].sort());

  // Within one file, rules are ordered: body before schema for zz.md.
  const zz = first.findings.filter((finding) => finding.file === "contacts/zz.md");
  assert.deepEqual(zz.map((finding) => finding.rule), ["body", "schema"]);
});

// cli.md loading state: "the count rising as files are read" — check
// reports progress through the optional onFile callback, once per checked
// file with the running count.
test("check reports progress through onFile, once per file", async () => {
  const root = await vault({
    "autofile.yml": strictConfig,
    "notes/a.md": "",
    "notes/b.md": "",
    "notes/c.md": "",
  });
  const counts: number[] = [];
  const result = await check(root, { onFile: (count) => counts.push(count) });
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(result.filesChecked, 3);
});
