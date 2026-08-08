# Vault

A vault is a folder with an `autofile.yml` at its root. The config declares
*paths* — folders it governs — and what the notes there must satisfy. It
need not describe the whole folder: a vault may be an existing Obsidian
vault with three declared paths among thirty. A file under a declared path
is *governed*; one under none is outside Autofile's concern.

## Notes

A note is a markdown file in the vault. The extension is exactly `.md`;
`.markdown` and `.canvas` are other files, which a vault stores rather than
validates. What a note holds — one person, one day, a running log — is the
path description's to say.

A name's extension is what follows its last dot, unless the name begins
with that dot: `.env` and `.md` alike have none. So a file named `.md` is
not a note, and the same reading serves `extensions` and the name
`filenames.pattern` matches.

A note has two parts, both optional:

- **Frontmatter** — a YAML block opened and closed by a `---` line at the
  start of the file, carrying the note's fields. It must parse to a
  mapping. Values parse as YAML's core schema, to JSON: `true` and `false`
  are booleans where `yes` and `on` are strings, and an unquoted date stays
  the string it was written as.
- **Body** — everything below the frontmatter. Whitespace alone does not
  count as one.

## Config

Every key the config may hold:

```yaml
strict: <boolean>

paths:
  <path>:
    description: <text>
    schema: <JSON Schema>
    body:
      allowed: <boolean>
    extensions: [<extension>, …]
    filenames:
      pattern: <regexp>
    internal_links:
      resolve: <boolean>
      format: wikilink | markdown-relative | markdown-absolute
    ignore:
      dotfiles: <boolean>
      pattern: <regexp>
```

### `strict`

Asserts that the config completely describes the vault. Without it,
Autofile answers only for the scopes it was given; with it, every file in
the folder is governed, so one under no declared path contradicts the
claim. Strict widens what a vault answers for; it does not change what is
required of a governed file.

**Default:** `false`.

### `paths`

The entries, keyed by folder.

- A key starts with `/` and carries no trailing slash. It may name a folder
  at any depth: `/`, `/contacts`, `/Daily Notes`,
  `/personal/misc/video games`.
- Spaces need no quoting; a key containing `: ` does.
- `/` is the entry for the vault root, and so the outermost scope.
- Entries may overlap: declaring both `/personal` and
  `/personal/misc/video games` covers a subtree broadly while governing one
  corner of it specifically.
- Order carries no meaning. By convention configs are written in path
  order, so they read as an outline of the vault.

An entry may declare any of the settings below.

#### `description`

What belongs in this scope rather than another, and how to file it — a
filing instruction rather than documentation.

**Default:** none. An entry without one scopes rules rather than inviting
filing: nothing is filed there, and a file already there answers to the
nearest description above it.

#### `schema`

JSON Schema (2020-12) that a note's frontmatter must satisfy. A note with
no frontmatter is checked as an empty object.

Formats are asserted, not annotations. Autofile adds two to JSON Schema's
own: `internal-link`, a value that is entirely a wikilink, since that is
what a link in frontmatter is, and `datetime`, a date and time without a
timezone offset —
`2026-08-08T10:00`, seconds optional, as Obsidian writes it, where JSON
Schema's `date-time` demands an offset Obsidian omits. Neither checks that
a link resolves.

**Default:** none; frontmatter is unconstrained.

#### `body`

`allowed: false` forbids a body here, for scopes holding pure structured
data.

**Default:** `allowed: true`.

#### `extensions`

The file extensions this scope may hold: `[md]` for notes only,
`[pdf, png]` for a folder of attachments.

**Default:** none; any file may sit here.

#### `filenames`

`pattern` is a regular expression that every path segment below this
entry's folder must match in full, the final segment of a file with its
extension stripped.

**Default:** none; any name a filesystem can carry.

#### `internal_links`

`resolve: false` drops the expectation that links here resolve.

`format` requires prose links to be written one way: `wikilink`,
`markdown-relative`, or `markdown-absolute`. External URLs are not internal
links and no `format` constrains them.

**Default:** `resolve: true`, and no `format`.

#### `ignore`

`dotfiles` ignores names beginning with a dot, `.obsidian/` and `.trash/`
among them. `pattern` ignores a name it matches — matched against one path
segment at a time, and a plain match rather than a full one.

Ignoring a folder ignores its subtree. An ignored file is not vault
content, so no rule reaches it, but it is still a file: a link to it
resolves.

**Default:** `dotfiles: true`, and no `pattern`.

## Inheritance

- Each setting is inherited on its own: a file takes the value from the
  nearest enclosing entry that specifies that setting, or the default where
  no entry does. An entry declaring `internal_links: { format: … }`
  therefore keeps an inherited `resolve: false`.
- A setting's *value* is taken whole. A nearer `schema` replaces an
  inherited one rather than merging with it.
- Writing a setting overrides what an ancestor said; omitting it inherits.
  An override is a value the setting takes: a boolean is written `true` or
  `false`, and a setting that can be none — a `schema`, a pattern,
  `extensions`, a link format — is written `null`, which is also its
  default.
- A folder's rules apply to its children, not to the folder itself.

At their defaults the settings constrain nothing, with one exception:
`internal_links.resolve` is on, so links in a declared path are expected to
resolve.

## Internal links

An internal link points from one note to a note or file in the same vault.
It may be written as any of:

- a wikilink `[[contacts/priya-narayan]]` or embed `![[assets/cat.jpg]]`;
- a markdown link `[label](contacts/priya-narayan)` or image
  `![alt](assets/cat.jpg)`. A URL target is not an internal link.

A link may carry a heading, and a wikilink may also carry an alias —
`[[contacts/priya-narayan|Priya]]`, `[[contacts/priya-narayan#history]]`,
`[Priya](contacts/priya-narayan#history)`. The link is the part before the
first `|` or `#`. Markdown targets are URL-decoded before that.

A target is matched against the vault as a path suffix: `contacts/priya`
finds a file whose path ends in those segments wherever it sits, and a bare
`Some Note` matches on its name alone.

- Where several files match, the nearest to the linking note wins: the
  shortest relative path from its folder, ties broken lexicographically.
- A target beginning `./` or `../` is note-relative instead, resolved
  against the folder holding the note; one that climbs past the vault root
  resolves to nothing.
- A target beginning `/` is vault-absolute, resolved from the vault root
  and matched there rather than by suffix.
- Either way the literal path is tried first, then `<target>.md`.
- A folder at the target path does not satisfy a link.
- Comparison normalizes, so a name stored as NFD is reached by a link
  written as NFC.

In YAML a wikilink must be quoted — unquoted, `[[contacts/priya-narayan]]`
is a nested array. A frontmatter field whose value is a wikilink is a typed
link an agent or app can follow; only a whole value is one, since a link
inside a longer string is prose that happens to live in a field.

- Links are checked in notes under a declared path, unless that path sets
  `internal_links: { resolve: false }`.
- Wikilinks are found at any depth in frontmatter values, and both forms in
  the body.
- Fenced code blocks and inline code spans are not scanned: a link inside
  code is code.
- Targets are matched against the whole vault, governed or not, so a link
  into an undeclared corner still resolves.

## Validity

A vault is valid when its config is well-formed and its governed files
satisfy what is asked of them.

The config is well-formed when:

- It holds no unknown keys, every schema compiles as JSON Schema, and every
  pattern compiles as a regular expression — a broken rule looks exactly
  like one everything passes.
- Schemas compile strictly, so an unknown schema keyword is rejected like
  any other misspelled key.
- No two path keys differ only by case or Unicode normalization, since they
  would name one folder.

A config that is empty, or holds nothing but comments, is well-formed and
declares nothing; only a folder with no `autofile.yml` at all is not a
vault.

A governed file satisfies every setting that reaches it, and three things
no setting controls:

- Frontmatter parses, and parses to a mapping — `parse`.
- Names are ones a filesystem can carry: no empty, `.`, or `..` segments,
  no control characters — `name`.
- No two paths differ only by case or Unicode normalization, which the
  filesystems these vaults sync across hold as one path — `collision`.

Two conditions are advisory and leave a vault valid either way:

- A link that resolves to nothing, since a note may be linked before it is
  filed — `internal_links.resolve`.
- A declared path with no folder yet — `missing`. A folder that exists
  but holds nothing is not one: a mistyped key leaves no folder at all, so
  an empty folder carries no signal beyond "nothing filed here yet".

Patterns are JavaScript `RegExp` syntax. No rule governs `autofile.yml`
itself.
