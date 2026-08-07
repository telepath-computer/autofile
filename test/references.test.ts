import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { check, type CheckResult, type Finding } from "@telepath-computer/autofile";

// A config for reference tests: notes is a governed records path, contacts
// and assets are ungoverned, and dotfiles are ignored.
const config = [
  "global:",
  "  ignore:",
  "    pattern: '^\\.'",
  "paths:",
  "  notes:",
  "    description: Notes.",
  "    records: {}",
  "  contacts:",
  "    description: People.",
  "  assets:",
  "    description: Files.",
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
  const root = await mkdtemp(join(tmpdir(), "autofile-refs-"));
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

function references(result: CheckResult): Finding[] {
  return result.findings.filter((finding) => finding.rule === "reference");
}

function violations(result: CheckResult): Finding[] {
  return result.findings.filter((finding) => finding.severity === "violation");
}

// --- frontmatter ---

// vault.md: "wikilinks at any depth in frontmatter values" — a frontmatter
// string that is a wikilink, top-level or nested in a list.
test("a dangling wikilink in frontmatter warns, top-level and nested in a list", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "---",
      "spouse: '[[contacts/mira-holt]]'",
      "related:",
      "  - '[[contacts/priya-narayan]]'",
      "---",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 2);
  for (const finding of refs) {
    assert.equal(finding.severity, "warning");
    assert.equal(finding.file, "notes/n.md");
  }
  assert.deepEqual(
    refs.map((finding) => finding.message).sort(),
    ["[[contacts/mira-holt]] does not exist", "[[contacts/priya-narayan]] does not exist"],
  );
});

test("a wikilink nested in a frontmatter object value warns", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "---\nlinks:\n  spouse: '[[contacts/mira-holt]]'\n---\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// A wikilink inside larger prose in a frontmatter string is body-level
// prose, not a typed link; frontmatter is scanned whole-value only.
test("a wikilink inside a larger frontmatter string is not checked", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "---\nnote: 'see [[contacts/mira-holt]] for details'\n---\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// vault.md: frontmatter parses to JSON values — an unquoted date next to a
// wikilink must not disturb extraction.
test("references extract from frontmatter containing unquoted dates", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "---",
      "date: 2026-08-05",
      "spouse: '[[contacts/mira-holt]]'",
      "---",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// --- body forms ---

test("a dangling embed in the body warns with the embed spelling", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "Look: ![[assets/cat.jpg]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.severity, "warning");
  assert.equal(refs[0]!.message, "![[assets/cat.jpg]] does not exist");
});

// vault.md: "the reference is the part before the first `|` or `#`".
test("alias and heading are stripped for resolution", async () => {
  const root = await vault({
    "autofile.yml": config,
    "contacts/priya-narayan.md": "",
    "notes/n.md": "[[contacts/priya-narayan|Priya]] and [[contacts/priya-narayan#history]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

test("a dangling aliased wikilink is reported as originally written", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "[[contacts/mira-holt|Mira]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt|Mira]] does not exist");
});

test("markdown links and images warn when dangling and pass when resolving", async () => {
  const root = await vault({
    "autofile.yml": config,
    "contacts/priya-narayan.md": "",
    "assets/cat.jpg": "x",
    "notes/n.md": [
      "[Priya](contacts/priya-narayan) [Mira](contacts/mira-holt)",
      "![cat](assets/cat.jpg) ![dog](assets/dog.jpg)",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((finding) => finding.message).sort(),
    ["![dog](assets/dog.jpg) does not exist", "[Mira](contacts/mira-holt) does not exist"],
  );
});

// vault.md: "A URL target is not a reference" and "a target with `./` or
// `../` segments or URL-encoding is not a reference".
test("URL, dot-segment, and URL-encoded markdown targets are not references", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "[site](https://example.com/page) [mail](mailto:a@b.c)",
      "[rel](./contacts/mira-holt) [up](../outside)",
      "[enc](contacts/mira%20holt) [anchor](#heading)",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// vault.md: a bare markdown destination cannot hold whitespace — a titled
// link's `path "Title"` and a space-containing target are not references.
test("titled and whitespace-containing markdown targets are not references", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": '[t](contacts/mira-holt "Mira") [s](contacts/mira holt)\n',
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// --- code is not scanned ---

// vault.md: "Fenced code blocks and inline code spans are not scanned — a
// link inside code is code."
test("a dangling wikilink inside a code fence is not scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": ["```", "[[contacts/mira-holt]]", "```", ""].join("\n"),
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// The real-world case: shell test syntax inside a fence looks exactly like
// a wikilink and must not produce a finding. The fence carries a language
// info string.
test("shell syntax inside a fenced block produces no finding", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": ["```bash", '[[ -z "$TMUX" && $- == *i* ]]', "```", ""].join("\n"),
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

test("an inline code span is not scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "see `[[not/a/link]]` here\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// A span opens and closes with equal-length backtick runs: a double-run
// span may hold single backticks, and everything inside is code.
test("a double-backtick span holding single backticks is not scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "`` `[[contacts/mira-holt]]` `` after\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// An unmatched backtick run is literal text, not an opener that swallows
// the rest of the line.
test("an unmatched backtick does not hide a later reference", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "a ` stray backtick and [[contacts/mira-holt]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// Blanking a fence must not blind the scanner to the prose around it.
test("a dangling link in prose between two fences still warns", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "```",
      "[[contacts/inside-one]]",
      "```",
      "real [[contacts/mira-holt]]",
      "```",
      "[[contacts/inside-two]]",
      "```",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// An unclosed fence runs to end of file, as in CommonMark: everything
// after the opener is code.
test("an unclosed fence swallows the rest of the body", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": ["before [[contacts/before-fence]]", "```", "[[contacts/inside]]", ""].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/before-fence]] does not exist");
});

test("a tilde fence is not scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": ["~~~", "[[contacts/mira-holt]]", "~~~", ""].join("\n"),
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// Indented (4-space) code blocks stay scanned: the spec excludes fences
// and spans only, and indentation in vault prose (nested lists, pasted
// text) is too ambiguous to treat as code.
test("a dangling link in a 4-space-indented line still warns", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "    [[contacts/mira-holt]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// Frontmatter keys are names, not values — a key that is a wikilink is
// not extracted.
test("a frontmatter key that is a wikilink is not extracted", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "---\n'[[contacts/mira-holt]]': spouse\n---\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// vault.md: "wikilinks at any depth" — a whole-value wikilink inside a map
// nested in a list is extracted.
test("a wikilink whole-value in a map nested in a list warns", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": ["---", "related:", "  - person: '[[contacts/mira-holt]]'", "---", ""].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// --- newlines ---

// A reference is a single-line construct: an unclosed `[[` must not fuse
// with a stray `]]` on a later line into a phantom reference.
test("an unclosed wikilink does not fuse with a later stray ]]", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "unclosed [[x\nsome prose here\n]] stray close\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

test("a wikilink split across lines is not a reference", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "[[first\nsecond]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

test("findings from a multiline adversarial body never carry a newline", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "unclosed [[x",
      "prose ]] and [markdown",
      "label](target",
      "here) with a real [[contacts/mira-holt]]",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  for (const finding of result.findings) {
    assert.ok(!finding.message.includes("\n"), `message holds a newline: ${finding.message}`);
  }
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

// --- resolution ---

// vault.md: "the literal path first, then `<target>.md` when nothing sits
// at the literal path".
test("a target resolves through the literal path or the .md fallback", async () => {
  const root = await vault({
    "autofile.yml": config,
    "assets/cat.jpg": "x",
    "notes/real.md": "",
    "notes/n.md": "[[assets/cat.jpg]] [[notes/real]] [[assets/cat]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  // assets/cat probes assets/cat, then assets/cat.md; neither exists —
  // two probes in one order, never a search across other extensions.
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[assets/cat]] does not exist");
});

// vault.md: "`docs/v1.2` reaches `docs/v1.2.md`" — a record whose name
// carries a dot is referenced extensionless like any other: the literal
// probe misses and the .md fallback resolves.
test("a dotted-basename record is reachable extensionless", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/v1.2.md": "",
    "notes/n.md": "[[notes/v1.2]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// A target already ending in .md gets the same two probes: the record
// notes/x.md.md is referenced extensionless as [[notes/x.md]], resolving
// through the fallback when no file sits at the literal path.
test("a target ending in .md falls back to <target>.md.md", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/x.md.md": "",
    "notes/n.md": "[[notes/x.md]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// The literal path is probed first: an extensionless file beside its .md
// sibling resolves the reference. When both probes would hit, which one
// won is invisible to dangling detection — the order shows in the tests
// either side, where exactly one probe hits.
test("a literal file beside its .md sibling resolves", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/v1.2": "raw",
    "notes/v1.2.md": "",
    "notes/n.md": "[[notes/v1.2]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// vault.md: "A folder at the target path does not satisfy a reference" —
// and it does not stop the .md fallback either: nothing that could
// satisfy the reference sits at the literal path, so the second probe
// runs and finds the record.
test("a folder at the literal path does not stop the .md fallback", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/v1.2/x.md": "",
    "notes/v1.2.md": "",
    "notes/n.md": "[[notes/v1.2]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// vault.md: "A folder at the target path does not satisfy a reference".
test("a folder at the target path dangles when the fallback misses too", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/sub/x.md": "",
    "notes/sub.d/y.md": "",
    // Each target probes the literal path — a folder, which does not
    // satisfy a reference — and then the .md fallback (notes/sub.md,
    // notes/sub.d.md), which does not exist.
    "notes/n.md": "[[notes/sub]] [[notes/sub.d]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.deepEqual(
    refs.map((finding) => finding.message).sort(),
    ["[[notes/sub.d]] does not exist", "[[notes/sub]] does not exist"],
  );
});

// cli.md: "Ignored files are not checked at all, but they exist: a
// reference to one is not dangling."
test("a reference to an ignored file is not dangling", async () => {
  const root = await vault({
    "autofile.yml": config,
    "assets/.secret.png": "x",
    "notes/n.md": "![[assets/.secret.png]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
  assert.equal(result.filesChecked, 1);
});

// vault.md: "`assets/.env` is reached as written" — the literal probe
// hits first, and an ignored file exists, so the reference is not
// dangling.
test("a dot-leading target resolves through the literal path", async () => {
  const root = await vault({
    "autofile.yml": config,
    "assets/.env": "SECRET=1",
    "notes/n.md": "[[assets/.env]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

test("a dot-leading target dangles when neither probe hits", async () => {
  const root = await vault({
    "autofile.yml": config,
    // Neither assets/.env nor the fallback assets/.env.md exists.
    "notes/n.md": "[[assets/.env]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[assets/.env]] does not exist");
});

// A dot-leading .md file — ignored here, but ignored files exist — is
// reached by the fallback extensionless: [[notes/.hidden]] probes
// notes/.hidden, then notes/.hidden.md — a file. Both spellings resolve.
test("a dot-leading .md file is reachable extensionless and literally", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/.hidden.md": "",
    "notes/n.md": "[[notes/.hidden]] [[notes/.hidden.md]]\n",
  });
  const result = await check(root);
  assert.deepEqual(references(result), []);
});

// cli.md: "Forward links are allowed, so this never fails the check."
test("a forward reference warns and the vault stays clean of violations", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "File later: [[contacts/future-person]]\n",
  });
  const result = await check(root);
  assert.deepEqual(violations(result), []);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.severity, "warning");
});

// vault.md: "A bare slug ... points at the vault root, where no file can
// be, and `check` reports it dangling."
test("a bare slug warns", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": "[[priya-narayan]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[priya-narayan]] does not exist");
});

// --- dedupe ---

test("identical dangling spellings in one record are reported once", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/n.md": [
      "---",
      "spouse: '[[contacts/mira-holt]]'",
      "---",
      "[[contacts/mira-holt]] again [[contacts/mira-holt]]",
      "and aliased: [[contacts/mira-holt|Mira]]",
      "",
    ].join("\n"),
  });
  const result = await check(root);
  const refs = references(result);
  // One finding per distinct spelling: the bare form once, the aliased
  // form once.
  assert.deepEqual(
    refs.map((finding) => finding.message).sort(),
    ["[[contacts/mira-holt]] does not exist", "[[contacts/mira-holt|Mira]] does not exist"],
  );
});

test("the same dangling spelling in two records is reported per record", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/a.md": "[[contacts/mira-holt]]\n",
    "notes/b.md": "[[contacts/mira-holt]]\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.deepEqual(refs.map((finding) => finding.file).sort(), ["notes/a.md", "notes/b.md"]);
});

// --- which records are scanned ---

// vault.md: "Every record's references are checked" — governed or not.
test("an ungoverned record's body is scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "contacts/mira-holt.md": "See [[contacts/priya-narayan]].\n",
  });
  const result = await check(root);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.file, "contacts/mira-holt.md");
  assert.equal(refs[0]!.message, "[[contacts/priya-narayan]] does not exist");
  assert.equal(result.filesChecked, 1);
});

test("a record with unparseable frontmatter is still body-scanned", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/broken.md": "---\nbad: [\n---\n[[contacts/mira-holt]]\n",
  });
  const result = await check(root);
  // The governed record's parse violation fires, and the body reference
  // still warns.
  assert.equal(violations(result).length, 1);
  assert.equal(violations(result)[0]!.rule, "parse");
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/mira-holt]] does not exist");
});

test("a record with non-mapping frontmatter skips frontmatter, scans the body", async () => {
  const root = await vault({
    "autofile.yml": config,
    "contacts/odd.md": "---\n'[[contacts/mira-holt]]'\n---\n[[contacts/priya-narayan]]\n",
  });
  const result = await check(root);
  // Ungoverned, so no parse violation; the scalar frontmatter is skipped
  // and only the body reference warns.
  assert.deepEqual(violations(result), []);
  const refs = references(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.message, "[[contacts/priya-narayan]] does not exist");
});

// --- escapes ---

// vault.md: "Resolution is always vault-relative" — a target that escapes
// the vault root can never resolve, even when a file exists there.
test("a target escaping the vault root dangles, even when the outside file exists", async () => {
  const parent = await mkdtemp(join(tmpdir(), "autofile-refs-outside-"));
  roots.push(parent);
  const root = join(parent, "vault");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "autofile.yml"), config);
  await writeFile(join(root, "notes", "n.md"), "[[../evil]] [[/etc/hostname]]\n");
  await writeFile(join(parent, "evil.md"), "outside");
  const result = await check(root);
  const refs = references(result);
  assert.deepEqual(
    refs.map((finding) => finding.message).sort(),
    ["[[../evil]] does not exist", "[[/etc/hostname]] does not exist"],
  );
  assert.deepEqual(violations(result), []);
});

// --- ordering and determinism ---

test("reference warnings slot into the deterministic order; runs are deep-equal", async () => {
  const root = await vault({
    "autofile.yml": config,
    "notes/z.md": "[[contacts/zed]] and [[contacts/abe]]\n",
    "notes/a.md": "[[contacts/mid]]\n",
    "contacts/": "",
    "loose.txt": "x",
  });
  const first = await check(root);
  const second = await check(root);
  assert.deepEqual(first, second);

  const severities = first.findings.map((finding) => finding.severity);
  const firstWarning = severities.indexOf("warning");
  assert.ok(firstWarning > 0, "expected both severities");
  assert.ok(!severities.slice(firstWarning).includes("violation"), "violations precede warnings");

  const warningKeys = first.findings
    .slice(firstWarning)
    .map((finding) => `${finding.file ?? ""} ${finding.rule} ${finding.message}`);
  assert.deepEqual(warningKeys, [...warningKeys].sort());
});
