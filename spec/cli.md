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

Both commands report to stdout; errors that stop a command before it runs
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

The config it writes declares nothing and documents the format in comments
— a path entry with a description, and each setting an entry may carry. A
vault initialized this way checks clean, empty or not.

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
finding reported when it fires.

Only governed files are checked, so a config declaring nothing reports
nothing — except `strict`, which reports files no path declared.
`collision` names each of the two paths, and one file may yield several
findings of the same rule.

Exit code is zero when there are no violations; warnings do not change it.

```
⠋ Checking… 42 files
```

The report is one line per finding: a marker (`✗` violation, `!` warning),
the file, then what is wrong, prefixed by its rule. Violations before
warnings, then ordered by path, rule, and message. The file column is
aligned; a `config` finding names no file and leaves it empty.

```
✗ contacts/jules-verne.md            schema: title must be a string
✗ contacts/Author Notes.txt          extensions: .txt is not among the extensions this path holds
! events/2026-08-07-studio-visit.md  internal_links.resolve: [[contacts/mira-holt]] does not exist

2 violations · 1 warning · 68 files
```

A `config` finding stands alone, its file column empty and nothing counted:

```
✗  config: paths./contacts: unknown key "shema"

1 violation · 0 files
```

A clean run prints only the summary, marked `✓`:

```
✓ 68 files
```

The count is the governed files. Files walked only to resolve link targets
are not counted.
