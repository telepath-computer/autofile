# CLI

The package provides one binary, `autofile`, with two commands:

```
autofile init [path]
autofile check [path]
```

`[path]` is the vault folder, defaulting to the current directory.
`autofile --help` — also shown on no or unknown arguments — prints usage —
a Usage line, a one-sentence description, and an aligned list of the
commands, the path argument, and the flags. `autofile --version` prints the
package version.

## `autofile init`

Creates a vault at `[path]`: writes the starter `autofile.yml` below and
creates the folder for each path it describes. Refuses to run if an
`autofile.yml` already exists; init never overwrites.

```yaml
global:
  ignore:
    pattern: '^\.'
  filenames:
    pattern: '^[a-z0-9][a-z0-9-]*$'
  assets:
    allowed: false

paths:
  datasets:
    description: |
      Standalone structured data — items that are not part of a larger
      collection: one file per dataset.
    records:
      schema:
        required: [title, description, data]
        properties:
          title:
            type: string
            description: Human-readable name of the dataset.
          description:
            type: string
            description: One-line summary of what this holds and is for.
          data:
            description: The payload — any JSON value.
          schema:
            type: object
            description: JSON Schema for the payload; when present, verify
              data against it when editing.

  assets:
    description: |
      Source material and attached files: scans, photos, downloads.
    assets:
      allowed: true

  topics:
    description: |
      Durable notes on anything worth remembering: one file per topic,
      holding what an agent should know when working on it. Update the
      existing note as the topic develops.
    records:
      schema:
        required: [title, description]
        properties:
          title:
            type: string
            description: Human-readable name of the topic.
          description:
            type: string
            description: One-line summary, written for retrieval.
```

The starter is deliberately neutral: freeform notes, bespoke data, a home
for files, and the strict global block. Typed paths — contacts, events,
whatever the vault is for — are added with the user, per
[the skill](skill.md).

## `autofile check`

Reads the config and the vault's files, and reports **findings**. A
**violation** makes the vault invalid; a **warning** is legal and usually a
mistake.

Enforcement follows the config: `parse`, `schema`, and `body` apply to
records governed by a `records` block, `asset` to files governed by an
`assets` block; a file no entry governs has nothing to violate. Ignored
files are not checked at all, but they exist: a reference to one is not
dangling. The remaining findings concern the vault as a whole.

Violations:

- `config` — `autofile.yml` cannot be read, does not parse, or is not a valid
  config (including an uncompilable schema).
- `parse` — a governed record cannot be read, its frontmatter is not
  valid YAML, or its frontmatter is not a mapping.
- `schema` — a record's frontmatter fails its governing `schema`.
- `body` — a record has a body where its governing entry sets
  `body.allowed: false`.
- `asset` — a non-record file where its governing entry sets
  `assets.allowed: false`.
- `root` — a loose file or undeclared folder at the vault root, which
  holds only `autofile.yml` and the declared folders.
- `filename` — a file's path has a segment that is empty, `.`, `..`, holds
  a control character, is not NFC, or is too long for the filesystem; or a
  segment that does not match the file's governing `filenames.pattern`.
- `collision` — two paths that differ only by case, checked across the whole
  vault.

Warnings:

- `empty` — a described path whose folder is missing or empty. Legitimate
  before anything is filed there; indistinguishable from a typo otherwise.
- `reference` — a reference, in frontmatter or body, whose target does not
  exist. Forward links are allowed, so this never fails the check.

Exit code is zero when there are no violations; warnings do not change it —
a warning that fails a build is not a warning.

## Output

Both commands report to stdout; errors that prevent a command from running
at all go to stderr. Presentation never changes content: color and bold
apply only when stdout is a terminal, and the loading state — a braille
spinner and message, shown once a command has run for 200 ms, updating in
place — is erased before the report prints. Piped or captured output is
plain text, byte-identical to a terminal run with the styling stripped, and
two runs over an unchanged vault print the same bytes.

The palette, by role — standard ANSI colors, so the user's terminal theme
decides the exact shades:

- **red** — violations: the `✗` marker and the rule prefix on its line.
- **yellow** — warnings: the `!` marker and the rule prefix on its line.
- **green** — success and creation: the `✓` marker and `init`'s created
  entries.
- **cyan** — the spinner glyph.
- **dim** — the spinner's message, and the whole summary line (the `✓`
  marker stays green).
- **bold** — file paths in findings.
- Everything else is the terminal's default color.

### `init` output

Loading state:

```
⠋ Initializing…
```

Report — what was created, folders marked with a trailing slash:

```
Initialized an Autofile vault.

  autofile.yml
  datasets/
  assets/
  topics/
```

Refusal — an `autofile.yml` already exists — is one line to stderr and a
non-zero exit.

### `check` output

Loading state, the count rising as files are read:

```
⠋ Checking… 42 files
```

Report — one line per finding: a marker (`✗` for a violation, `!` for a
warning), the file, then what is wrong, prefixed by its rule — the rule
prefix is bold or colored in a terminal to set it off from the message.
Violations before warnings, then ordered by path and rule, with the file
column aligned. A summary line ends the report:

```
✗ contacts/jules-verne.md            schema: name must be a string
✗ contacts/Author Notes.txt          asset: not a record, in a path that forbids assets
! events/2026-08-07-studio-visit.md  reference: [[contacts/mira-holt]] does not exist

2 violations · 1 warning · 68 files
```

A clean run prints only the summary, marked `✓`:

```
✓ 68 files
```

The file count is what was checked, ignored files and the config aside,
so finding nothing is distinguishable from checking nothing.
