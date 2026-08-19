# Vault

A vault is a folder of markdown notes with an `autofile.yml` at its
root. The config declares folders and states what is true inside each —
what belongs there, what shape its notes take, what files it may hold.
Autofile serves two ends with those statements: agents can file
reliably, because the config answers where a thing goes, what shape it
must have, and what it is called; and applications can trust the data,
because a declared folder's notes verifiably satisfy their schema. The
config governs only what it declares. A folder no entry reaches is
not governed — an existing vault adopts Autofile by declaring one
folder, and tightens by declaring more.

## Notes

A note is a markdown file. The extension is exactly `.md`. A note has
two parts, both optional:

- **Frontmatter** — a YAML block opened and closed by a `---` line at
  the start of the file, carrying the note's fields. It must parse to a
  mapping. Values parse as YAML's core schema, to JSON: `true` and
  `false` are booleans where `yes` and `on` are strings, and an unquoted
  date stays the string it was written as.
- **Body** — everything below the frontmatter. Whitespace alone does not
  count as one.

## Config

Every key the config may hold:

```yaml
version: 1

strict: <boolean>

link_format: wikilink | markdown

filename_pattern: <regexp>

ignore: [<regexp>, …]

folders:
  - path: <folder>
    description: <text>
    schema: <JSON Schema>
    extensions: [<extension>, …]
    filename_pattern: <regexp>
    body: markdown | raw | none
    additional_subfolders: <boolean>
```

Everything in force in a vault is visible in its config. The spec
defines what each key means and what its default is; `init` writes the
defaults into the config as comments ([CLI](cli.md)), so the setup is
readable in the file even before anything is set, and adopting or
changing a convention is editing a visible line.

### `version`

The config format version. Required, an integer; this document describes
version 1. A config without it was written before the format was
versioned, and is reported as one finding naming the migration, not as a
cascade of unknown keys. A
version this autofile does not understand is likewise one finding. The
check exists so a config is read under the rules it was written for, or
not read at all.

### `strict`

Asserts that nothing in the vault is ungoverned: every file falls under
a folder entry or an `ignore` pattern, and anything else is the
`coverage` finding. Without it, files outside every entry are simply not
governed at all. Strict adds to what the vault must account for; it
never changes what an entry requires. `autofile.yml` itself is always exempt —
a strict vault necessarily holds one at the root.

**Default:** `false`.

### `link_format`

How every internal link in the vault is written, frontmatter and
prose alike: `wikilink` — links are wikilinks,
`[[contacts/priya-narayan|Priya]]`; or `markdown` — links are standard
markdown links with targets relative to the note's own folder,
`[Priya](../contacts/priya-narayan)`. Each format has one syntax; see
Internal links for what each means.

**Default:** `wikilink`.

### `filename_pattern`

A regular expression every governed note's filename (extension stripped)
and every declared path segment must match in full. A declared segment
that fails it is a `config` finding. A folder entry may override it for
its own files. The vault-wide pattern binds notes and declarations;
files that are not notes answer to no pattern unless an entry's own
`filename_pattern` reaches them.

**Default:** none; names are unconstrained.

### `ignore`

Patterns for files and folders that are not the vault's concern. Each is
matched against one path segment at a time, a plain match rather than a
full one. Ignoring a folder ignores its subtree. An ignored file is not
vault content, so no rule reaches it, but it is still a file: a link to
it resolves. Declaring a path an `ignore` pattern would hide is a
`config` finding — a config cannot both govern and disown a place.

There are no always-ignored names: the conventional dotfile pattern
(`['^\.']`, hiding `.obsidian/` and `.trash/`) ships as a commented
line in `init`'s config, adopted by uncommenting it.

**Default:** none.

### `folders`

The declared folders, as a list of entries. Each entry is a set of
statements about one folder; each field constrains only what it names,
and a field left out constrains nothing. Entries do not interact: no
setting cascades from one entry to another, and where entries nest, the
most specific entry governs its subtree wholesale (see Governance).

- `path` — the folder, vault-relative and `/`-separated, with no
  leading, trailing, or repeated separators and no `..` segments;
  `.` declares the vault root itself. Required. No two entries may name
  the same path, and no two declared paths may differ only by case or
  Unicode normalization; either is a `config` finding.
- `description` — what belongs here rather than elsewhere, and how to
  file it: a filing instruction, not documentation. An entry without one
  leaves a reader unable to file there, which is advisory rather than
  invalid (see Validity).
- `schema` — JSON Schema (2020-12) that the frontmatter of notes in the
  folder must satisfy. A note with no frontmatter is checked as an empty object.
  Formats are asserted, not annotations. Autofile adds two:
  `internal-link`, a value that is entirely an internal link in the
  vault's `link_format`, and `datetime`,
  a date and time without a timezone offset — `2026-08-08T10:00`,
  seconds optional, as Obsidian writes it. Neither checks that a link
  resolves. **Default:** none; frontmatter is unconstrained.
- `extensions` — the file extensions the folder accepts, written
  lowercase and dot-less, matched case-insensitively (`photo.JPG`
  matches `jpg`). A name's extension is what follows its last dot,
  unless the name begins with that dot: `archive.tar.gz` is `gz`, and
  `.env` has none. `['*']` — the wildcard, legal only as the sole
  entry — explicitly accepts any file, extensionless included, and
  means the same as omitting the key. A file with no extension is
  otherwise accepted only where `extensions` is omitted.
  **Default:** none; any file may sit here.
- `filename_pattern` — a pattern for this folder's filenames, replacing
  the vault-wide one; full match, extension stripped, applying to every
  governed file in the entry's scope. **Default:** the vault's
  `filename_pattern`, which binds notes only.
- `body` — what the folder's notes carry below their frontmatter.
  `markdown`, the default. `raw` — content this vault does not
  interpret: its links are not checked and a serving layer does not
  transform it, so what a raw body actually is (HTML, plain text, a
  transcript) is the record's own business, declared in its fields
  where a consumer needs to know. `none` forbids a body, for folders
  holding pure structured data where prose is a sign the fields were
  skipped. **Default:** `markdown`.
- `additional_subfolders` — `false` forbids subfolders beyond those a
  more specific entry governs: a subfolder with its own entry stands on
  that entry; any other is a finding. `true`, the default, allows
  subfolders and extends this entry's statements over them.

**Default:** no entries. A config declaring no folders governs nothing,
which with `strict: false` is a valid vault with no requirements at all.

## Governance

Which entry answers for a file:

- The most specific declared path enclosing the file governs it, and
  governs it wholesale: every judgment about the file — schema,
  extensions, filenames, body, subfolders — comes from that one entry.
  Nothing is inherited from enclosing entries, ever.
- Within its scope, an entry's statements apply to what they are about:
  `schema`, `body`, and note filenames to `.md` files; `extensions` to
  every file; `additional_subfolders` to folders.
- A file no entry reaches is out of scope: neither governed nor
  forbidden, since nothing has been declared about where it sits. Under
  `strict: true` it is the `coverage` finding instead.
- `autofile.yml` is exempt: no entry or setting governs it.

## Internal links

An internal link points from a note to a note or file in the same
vault. The vault's `link_format` governs how every internal link is
written — frontmatter and prose alike — and each format has one syntax,
so a link written in the other syntax is the `link_format` finding
wherever it appears. A URL destination is external and no finding.

**Under `wikilink`** (the default), an internal link is a wikilink. In
frontmatter, a field value that is entirely a wikilink —
`"[[contacts/priya-narayan]]"`, quoted, since unquoted it is a nested
array — is a typed reference; in prose, wikilinks appear inline. A
wikilink may carry an alias or a heading —
`[[contacts/priya-narayan|Priya]]`, `[[contacts/priya-narayan#history]]`;
the link is the part before the first `|` or `#`. An internal markdown
link anywhere is the `link_format` finding.

**Under `markdown`**, an internal link is a standard markdown link with
its target relative to the note's own folder —
`[Priya](../contacts/priya-narayan)`. In frontmatter, a field value that
is entirely such a link is a typed reference, its display text playing
the alias's role; in prose they appear inline. A wikilink anywhere is
the `link_format` finding, as is a `/`-rooted destination — targets are
relative, as a URL would resolve them.

Resolution follows the syntax, and is asked one question only: does
the link reach anything (the `resolve` advisory — see Validity). A
wikilink target is matched against the vault as a path suffix: it
resolves if some file's path ends with the target's segments — as
written first, then with `.md` appended — so a bare name resolves
wherever a note by that name sits, and `[[contacts/priya-narayan]]`
wherever those segments end a path. Which of several matches a link
means is not adjudicated: `check` answers whether a link reaches
something, never which thing it reaches. A markdown target resolves as
a URL resolves: against the note's containing folder, URL-decoded, the
literal path first, then `<target>.md`. Any spelling that resolves is
legal; a folder that wants full paths requires them in its schema.

For every link: a folder does not satisfy a link; comparison normalizes
Unicode, so a name stored as NFD is reached by a link written as NFC; a
target may name any file, with its extension. Fenced code blocks and
inline code spans are not scanned: a link inside code is code. Only a
whole field value is a reference — a link inside a longer string is
prose that happens to live in a field, and an unquoted wikilink parses
as nested arrays and is not special-cased; a schema typing the field
`internal-link` is what catches that mistake. References are found at
any depth in frontmatter values. Links are checked in governed notes
only, and never in a body a folder declares `raw`.

A link that resolves to nothing is advisory — a note may be linked
before it is filed.

## Validity

A vault is valid when its config is well-formed and its governed files
satisfy the entries that answer for them.

The config is well-formed when:

- `version` is present and understood (see above — either failure is a
  single finding).
- It holds no unknown keys, every schema compiles as JSON Schema, and
  every pattern compiles as a regular expression. A rule that fails to
  compile would otherwise be indistinguishable from one that everything
  satisfies.
- Schemas compile strictly, so an unknown schema keyword is rejected
  like any other misspelled key.
- Declared paths are unique (including case and Unicode normalization),
  well-formed, not hidden by `ignore`, and match the pattern that binds
  them; an `extensions` wildcard stands alone; `link_format` is one of
  its two values.

A governed file satisfies its entry, and one thing no setting controls:

- No two governed paths differ only by case or Unicode normalization —
  the filesystems these vaults sync across hold such paths as one, and
  the sync silently keeps a single winner. Names confined to lowercase
  slugs cannot collide this way; the check exists because a vault's
  pattern can allow names that do — `collision`.

Three conditions are advisory and leave a vault valid either way:

- A folder entry without a `description` — the vault works, but an
  arriving reader cannot know how to file there — `description`.
- A link that resolves to nothing, since a note may be linked before it
  is filed — `resolve`.
- A declared path with no folder yet — `missing`. A regular file
  standing at a declared path is also `missing`, and the file answers to
  whatever else governs it.

Patterns are JavaScript `RegExp` syntax.
