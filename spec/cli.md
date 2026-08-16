# CLI

The package provides one binary, `autofile`, with two commands:

```
autofile init [path]
autofile check [path]
```

`[path]` is the vault folder, defaulting to the current directory.
`autofile --help` prints usage — a Usage line, a one-sentence description,
and an aligned list of the commands, the path argument, and the flags — to
stdout, exiting zero. No arguments, or arguments not understood, print the
same usage to stderr and exit non-zero. `autofile --version` prints the
package version.

## Output

Commands report to stdout; errors that stop a command before it runs
go to stderr. Color and bold apply only when stdout is a terminal, and the
loading state — a braille spinner and message, shown once a command has run
for 200 ms, updating in place — is erased before the report prints. Piped
output is plain text, byte-identical to a terminal run with the styling
stripped, and two runs over an unchanged vault print the same bytes.

The palette, by role — standard ANSI colors, so the user's terminal theme
decides the shades:

- **red** — violations: the `✗` marker and the rule prefix on its line.
- **yellow** — warnings: the `!` marker and the rule prefix on its line.
- **green** — success and creation: the `✓` marker and `init`'s created
  entries.
- **cyan** — the spinner glyph.
- **dim** — the spinner's message, and the summary line (its `✓` stays
  green).
- **bold** — file paths in findings.

## `autofile init`

Writes an `autofile.yml` at `[path]` and nothing else, refusing if one
already exists. It creates no folders, `[path]` included: declaring a path
describes a folder rather than requesting one.

The config it writes is [`init.yml`](init.yml), verbatim — the file in
this spec folder is the normative output, and a byte of difference is a
bug. It declares nothing: `version: 1` is its only active line, and
everything else — the top-level settings at their defaults, one
fully-worked `folders` entry, a statement of the conventions in force —
is comments, so the defaults are visible without being asserted and
adopting one is uncommenting a line. Folders are then declared with the
user by editing `autofile.yml` together — `init` makes no claims about
a vault it has not seen.

Initialized anywhere — an empty folder or a full Obsidian vault — the
config checks clean with no findings at all: nothing is governed until
declared. Setting `strict: true` turns every ungoverned file into the
`coverage` worklist.

```
⠋ Initializing…
```

```
Initialized an Autofile vault.

  autofile.yml
```

Refusal is one line to stderr and a non-zero exit.

## `autofile check`

Reads the config and the vault's files, and reports **findings**. A
**violation** makes the vault invalid; a **warning** is legal and usually a
mistake. A folder holding no `autofile.yml` is not a vault: that goes to
stderr and the command stops.

A finding takes the name the [vault spec](vault.md) gives the rule it
breaks, so a report says which rule to go and read. All are violations,
except the conditions Validity calls advisory, which warn. A rule added to
the spec needs nothing added here.

One finding stands outside the vault spec: `config`, a violation when the
config cannot be read, does not parse, or is not valid, and the only
finding reported when it fires. A config without `version`, or with one
this autofile does not understand, is a single `config` finding naming
the migration or the version — never a cascade of unknown-key findings.

Only governed files are checked: a config declaring no folders reports
nothing. Under `strict: true`, a file no entry or `ignore` accounts for
is the `coverage` violation. `collision` names each of the two paths, and one file may
yield several findings of the same rule.

Exit code is zero when there are no violations; warnings do not change it.

`check` scales linearly with the vault, because the vaults it is for
hold tens of thousands of notes. Link targets resolve against an index
built once per run — wikilink targets against a suffix index, markdown
targets as paths — so each link is a lookup. Scanning the file list per
link is quadratic and rules the tool out of its own headline case.

```
⠋ Checking… 42 files
```

The report is one line per finding: a marker (`✗` violation, `!` warning),
the file, then what is wrong, prefixed by its rule. Violations before
warnings, then ordered by path, rule, and message. The file column is
aligned.

```
✗ contacts/author-notes.txt          extensions: txt is not among the extensions this folder accepts
✗ contacts/jules-verne.md            schema: title must be a string
! events/2026-08-07-studio-visit.md  resolve: [[contacts/mira-holt]] does not exist

2 violations · 1 warning · 68 files
```

A `config` finding names `autofile.yml`, and its message names the place
inside it — a top-level key, or a folder entry named by its path, and
any setting dotted onto it:

```
✗ autofile.yml  config: folders contacts has an unknown key "shema"

1 violation · 0 files
```

A clean run prints only the summary, marked `✓`:

```
✓ 68 files
```

The count is the governed files — everything an entry accounts for,
plus `coverage` failures under `strict`. Ignored and out-of-scope files
are walked only as link targets and are not counted.
