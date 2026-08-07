# Vault

A vault is a folder with an `autofile.yml` at its root. The root itself
holds only the config and the declared folders: anything else at the
root — a loose file, an undeclared folder — is a violation, ignored
entries aside. A subtree at the root that belongs to another system is
therefore ignored explicitly, which documents the exception in the config. The config is a set
of *entries*, all of one shape: `global`, the entry for the vault as a
whole, and `paths`, entries for the vault's top-level folders. A path entry
carries a description
of what belongs in its scope and may declare rule blocks that the files
there must satisfy; `global` declares rule blocks only. An entry with no
rule blocks carries no enforcement, only guidance.

The descriptions are what keep filing predictable: an agent reads them
before writing, and every file goes where a description says it belongs.

## Config

```yaml
global:
  ignore:
    pattern: '^\.'
  filenames:
    pattern: '^[a-z0-9][a-z0-9-]*$'
  assets:
    allowed: false

paths:
  contacts:
    description: |
      People and organizations. One record per person or organization.
      Update the existing record when someone's details change.
    records:
      schema:
        required: [name, type]
        properties:
          name: { type: string }
          type: { enum: [person, organization] }
      body:
        allowed: false

  events:
    description: |
      Dated records of things that happened: meetings, calls, visits.
    records:
      schema:
        required: [title, date]
        properties:
          title: { type: string }
          date: { type: string, format: date }

  assets:
    description: |
      Source material and attached files: scans, photos, downloads.
    assets:
      allowed: true
```

This example is the strict idiom: `global` forbids non-record files, the
`assets` folder allows them again, so everything that is not a record has
exactly one place to go.

`global` holds one entry; `paths` holds one entry per top-level folder,
keyed by folder name — a single path segment, no `/`. Only folders at the
vault root have entries; folders nest freely below them, with the entry's
description saying what goes where inside. Entry order carries no meaning;
by convention, configs list specific paths before broad ones, so they read
as a decision list. An entry declares any of:

- `description` — a filing instruction rather than documentation: what
  belongs in this scope rather than another, and how to file it. Path
  entries only, and required on each.
- `records` — rules for markdown files:
  - `schema` — JSON Schema (2020-12) that each record's frontmatter must
    satisfy. `format` is asserted, so `format: date` must hold a date. A
    record with no frontmatter is checked as an empty object.
  - `body` — rules for the region below the frontmatter. `allowed: false`
    forbids a body on records here, for scopes holding pure structured
    data. Bodies are allowed by default.
- `assets` — rules for files that are not records:
  - `allowed` — `false` forbids non-record files in this scope. Allowed by
    default.
- `filenames` — rules for file and folder names:
  - `pattern` — a regular expression every path segment of every governed
    file must match in full, the final segment with its extension
    stripped — so one convention governs record ids and asset names alike.
- `ignore` — what is not vault content:
  - `pattern` — a regular expression; a file or folder whose name matches
    it in full is ignored, subtree included. Ignored files are invisible
    to `check` — sync and editor artifacts, not vault content.

Scope is positional: `global` governs the whole vault, a path entry the
subtree under its folder. For each rule block, a path entry's block, where
declared, replaces `global`'s entirely; an entry that omits a block leaves
`global`'s in force, and an empty block (`records: {}`) is therefore how a
folder relaxes a global rule.

Unknown keys are rejected at every level — a misspelled key is otherwise a
rule that silently never runs. A schema that does not compile as JSON
Schema, or a pattern that does not compile as a regular expression, is
rejected for the same reason: a broken rule looks exactly like one
everything passes. Two paths that differ only by case are rejected, since
their folders would be one folder on a case-insensitive filesystem.

Both top-level keys are optional — a config that declares neither is a
valid vault with no rules. Patterns are JavaScript `RegExp` syntax. The
config file itself is neither record nor asset: no rule block governs
`autofile.yml`, and `check` neither names it in a finding (beyond `config`)
nor counts it.

An `autofile.yml` that cannot be read, does not parse, or does not match the
above makes the vault invalid; nothing else is checked until it is fixed.

## Records

A record is one `.md` file representing one thing: a person, an event, a
task, a source. Folders may nest below a path entry.

A record has two parts, both optional:

- **Frontmatter** — a YAML block opened and closed by a `---` line at the
  start of the file, carrying the record's structured fields. This is what
  a governing `schema` validates.
- **Body** — everything below the frontmatter: concise agent-authored prose,
  links, and retrieval cues. Whitespace alone is no body.

Filenames are how records are referenced, so a filename must be one every
filesystem can hold: no empty path segments, no `.` or `..` segments, no
control characters, Unicode NFC. Paths are case-sensitive as written, but
two paths that differ only by case collide on a case-insensitive
filesystem, so a vault may not contain them both.

## References

A reference points at a record or file by its full vault-relative path:
records without the `.md` extension — `contacts/priya-narayan.md` is
referenced as `contacts/priya-narayan` — and any other file with its
extension. Resolution is always vault-relative; there is no search by
filename. A bare slug (`[[priya-narayan]]`) therefore points at the vault
root, where no file can be, and `check` reports it dangling.

One spelling per target is what the full path buys: backlinks are found by
grepping for it, and resolving a reference is a lookup rather than a
vault-wide search with an ambiguity policy that every consumer — `check`,
a server, a script following a frontmatter link — would have to
reimplement.

A reference may be written as any of:

- a wikilink `[[contacts/priya-narayan]]` or embed `![[assets/cat.jpg]]`;
- a markdown link `[label](contacts/priya-narayan)` or image
  `![alt](assets/cat.jpg)` whose target is a vault-relative path. A URL
  target is not a reference.

A wikilink may carry an alias or heading —
`[[contacts/priya-narayan|Priya]]`, `[[contacts/priya-narayan#history]]` —
and the reference is the part before the first `|` or `#`. Markdown-link
targets resolve against the vault root only: a target with `./` or `../`
segments or URL-encoding is not a reference. A reference resolves to a
file — an extensionless target through `<target>.md`, any other through
the literal path; a folder at the target path does not satisfy it.

In YAML a wikilink must be quoted — unquoted, `[[contacts/priya-narayan]]`
is a nested array. A wikilink in body prose is a markdown-level link between
records; a frontmatter field whose value is a wikilink is a typed link an
agent or app can follow.

Every record's references are checked: wikilinks at any depth in
frontmatter values, and both forms in the body. A reference may
point at a record that does not exist yet; it marks something worth filing
later. `check` reports these as warnings, not violations.
