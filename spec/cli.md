# CLI

The package provides one binary, `autofile`, with three commands:

```
autofile init [path]
autofile check [path]
autofile serve [path]
```

`[path]` is the vault folder, defaulting to the current directory.
`autofile --help` prints usage — a Usage line, a one-sentence description,
and an aligned list of the commands, the path argument, and the flags — to
stdout, exiting zero. No arguments, or arguments not understood, print the
same usage to stderr and exit non-zero. `autofile --version` prints the
package version.

## Output

Commands report to stdout and send errors to stderr. Color and bold apply
on each stream only when that stream is a terminal. The loading state — a
braille spinner and message, shown once a command has run for 200 ms,
updating in place — is erased before the report prints. Piped
output is plain text, byte-identical to a terminal run with the styling
stripped, and two runs over an unchanged vault print the same bytes.

An error is one line on stderr, marked with the same red `✗` a violation
carries, and a command that cannot run exits 1. The line states what is
wrong and what the command did about it:

```
✗ autofile.yml already exists; init never overwrites.
✗ autofile.yml not found; this folder is not an Autofile vault.
```

The palette, by role — standard ANSI colors, so the user's terminal theme
decides the shades:

- **red** — violations and errors: the `✗` marker, and the rule prefix on
  a finding line.
- **yellow** — warnings: the `!` marker and the rule prefix on its line.
- **green** — success and creation: the `✓` marker and the entries
  `init` reports writing.
- **cyan** — the spinner glyph, and the URL in the `serve` startup lines.
- **dim** — the spinner message; the summary line, whose `✓` stays green;
  and in the `serve` startup lines, the `vault:` and `url:` labels and
  the note count.
- **bold** — file paths in findings, and the program name in the `serve`
  startup lines.

## `autofile init`

Writes an `autofile.yml` at `[path]` and nothing else, refusing if one
already exists. It creates no folders, `[path]` included: declaring a path
describes a folder rather than requesting one.

The config it writes is [`init.yml`](init.yml), verbatim — the file in
this spec folder is the normative output, and a byte of difference is a
bug. It declares nothing. `version: 1` is its only active line; everything
else is comments — the top-level settings at their defaults, one
fully-worked `folders` entry, and a statement of the conventions in
force. The defaults are therefore visible without being asserted, and
adopting one means uncommenting a line. Folders are declared afterwards,
with the user, by editing `autofile.yml` together: `init` makes no claims
about a vault it has not seen.

Initialized anywhere — an empty folder or a full Obsidian vault — the
config checks clean with no findings at all: nothing is governed until
declared. Setting `strict: true` makes every ungoverned file a `coverage`
violation.

```
⠋ Initializing…
```

```
Initialized an Autofile vault.

  autofile.yml
```

## `autofile check`

Reads the config and the vault's files, and reports **findings**. A
**violation** makes the vault invalid; a **warning** leaves it valid but is
worth attention. A folder holding no `autofile.yml` is not a vault: that goes to
stderr and the command stops.

A finding is named after the rule it breaks, using the name the [vault
spec](vault.md) gives that rule, so the report points at what to read.
Every finding is a violation except the conditions the vault spec calls
advisory, which are warnings. Adding a rule to that spec therefore needs
no change here.

One finding is not in the vault spec: `config`, a violation when the
config cannot be read, does not parse, or is not valid. It is the only
finding reported when it occurs. A config without `version`, or with one
this autofile does not understand, is a single `config` finding naming
the migration or the version — never a cascade of unknown-key findings.

Only governed files are checked: a config declaring no folders reports
nothing. Under `strict: true`, a file no entry or `ignore` accounts for
is the `coverage` violation. `collision` names each of the two paths, and one file may
yield several findings of the same rule.

Exit code is zero when there are no violations; warnings do not change it.

`check` scales linearly with the vault, which matters because these
vaults hold tens of thousands of notes. Link targets resolve against an
index built once per run — wikilink targets against a suffix index,
markdown targets as paths — so each link costs one lookup. Scanning the
file list once per link would be quadratic, and too slow on a vault of
that size.

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

## `autofile serve`

Serves the vault over HTTP, so an application can read and write notes as
JSON.
[vault-server](https://github.com/telepath-computer/servers/blob/main/packages/vault-server/spec/server.md)
defines the protocol — the record shape, the routes, the change events —
and does the serving. Autofile declares that server's configuration from
`autofile.yml`: the vault `link_format`, the folders whose `body` is
`raw`, and a validate function that refuses any write breaking the rules
of the folder it targets.

A folder holding no `autofile.yml` is not a vault, so the server does not
start. A `config` violation stops it too, reported as one error line
carrying the config message rather than as a `check` report, since the
command produces no report of its own:

```
✗ autofile.yml: folders contacts has an unknown key "shema"
```

`--host` and `--port` are forwarded to vault-server, which decides how to
bind them ([the API](https://github.com/telepath-computer/servers/blob/main/packages/vault-server/spec/api.md)).
Given no `--port` it searches for a free one, so the `url:` line reports
the port actually bound.

On a successful start it prints three aligned lines to stdout:

```
autofile 0.2.0
vault:  /home/user/notes (1598 notes)
url:    http://127.0.0.1:4747
```

The version is the Autofile package version, and the path is the vault
root with symlinks resolved, which is the directory the server watches.
The count is the notes the server has indexed. The command runs until
interrupted, so it prints no summary and no spinner.

A path with a dot-prefixed segment is not served, so a folder declared as
`.private` is governed by `check` but not reachable here.

### Validating writes

The rules come from the folder entry that governs the path being written,
which is judged as the file the write produces, `<path>.md`. A write
breaking any rule is refused, and the error is the findings it produced:
each message with its rule prefix, joined with `; `, in the order a
`check` report gives them.

```
422 {"error": "filename_pattern: \"Jane-Doe\" does not match \"^[a-z0-9][a-z0-9-]*$\"; schema: title must be a string"}
```

Every rule the [vault spec](vault.md) defines, and whether a write is
judged against it:

| Rule | On write |
| --- | --- |
| `schema` | Applies. |
| `body` | Applies. |
| `filename_pattern` | Applies. |
| `extensions` | Applies. A record is always written as `.md`, so a folder whose `extensions` omit `md` refuses every write. |
| `link_format` | Applies. |
| `additional_subfolders` | Applies. |
| `coverage` | Applies under `strict` only, refusing a write to a path that no entry declares and no `ignore` pattern accounts for. Without `strict` the write is allowed. |
| `parse` | Cannot occur: a record arrives as JSON, so there is no frontmatter to fail parsing. |
| `collision` | Applies, against the governed paths the server holds indexed, as `check` compares them: a write whose path differs from one of those only by case or Unicode normalization is refused. |
| `resolve` | Not evaluated. It is advisory — a note may be linked before it is filed — so a write is never judged against it. |
| `missing` | Not evaluated, advisory likewise. A write beneath a declared folder that does not exist creates it, clearing the warning. |
| `config`, `description` | Not applicable. Neither judges a record: `config` judges the config file, `description` judges a folder entry. |

The config is read again whenever `autofile.yml` changes, so an edit takes
effect without a restart. An edit that produces a `config` violation is not
adopted: the config already in force stays, since a file is briefly invalid
while it is being typed. The server keeps running and reports the finding:

```
✗ autofile.yml was not reloaded: folders contacts has an unknown key "shema"
```
