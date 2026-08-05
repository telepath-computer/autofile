# CLI

`autofile` is the command-line entry point to a *vault*.

`autofile --help` prints usage and exits zero: asking for help is not an
error. It is answered wherever it appears, so `autofile validate --help` works
too. A missing or unknown command, or an argument a command cannot act on, prints
usage on standard error and exits non-zero.

## Commands

### `validate`

Checks a *vault* against the [vault rules](vault-rules.md) and reports what
breaks them. The rules are not restated here.

`validate` operates on the *vault* in the working directory. Without an
`autofile.yml` there is nothing to validate, and the command fails.

These rules follow the fields in the vault rules: a rule added there is a rule
here.

A *violation* names the file, what is wrong with it, and the *path* entry that
governs it, where there is one. A *warning* is labelled and names the *path* in
the file's place. One finding to a line, *violations* before *warnings*.

```
contacts/priya narayan.md — does not match ^[a-z0-9-]+$   (/contacts)
```

- `schema` — the *header* fails its *path*'s `schema`.
- `filename` — the filename fails its *path*'s `filename`.
- `body` — the *record* has a *body* where its *path* sets `body: false`.
- `parse` — the *record* cannot be read, or its YAML *header* does not parse.
- `config` — `autofile.yml` cannot be read, does not parse, or is not a valid
  *config*. This one concerns the *vault*'s own file, so it names neither a
  *record* nor a *path* entry.

`validate` also reports warnings: legal, but usually a mistake. They do not
make the *vault* invalid.

- `empty` — a listed *path* with nothing at it: missing, not a folder, or
  holding nothing but ignored entries. *Static files* count as contents, so a
  *path* holding only attachments does not warn. Legitimate when a *path* is
  declared before anything is filed into it, and indistinguishable from a
  mistyped path key otherwise.

Findings are reported in a deterministic order, so two runs over an unchanged
*vault* produce identical output.

`validate` exits zero when the *vault* is valid and non-zero when it is not.
Warnings do not change the exit code — a warning that fails a build is not a
warning. A valid *vault* still prints a line naming what was checked, so a run
that found nothing is distinguishable from one that found everything in order.

## Implementation

Autofile is written in TypeScript for Node.

It is a single package for now, laid out so the boundaries that would become
separate packages already exist:

- `src/vault/` — reading `autofile.yml`, deciding what is a *record*, parsing
  *records*, and checking them against the rules.
- `src/server/` — the HTTP server, built on `vault`.
- `src/cli/` — argument parsing, commands, and output, built on both.

Splitting any of them out later is a directory move rather than a refactor.
