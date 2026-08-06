# CLI

`autofile` is the command-line entry point to a *vault*.

`autofile --help` prints usage and exits zero: asking for help is not an
error. It is answered wherever it appears, so `autofile validate --help` works
too. A missing or unknown command, or an argument a command cannot act on, prints
usage on standard error and exits non-zero.

## Commands

### `validate`

Checks a *vault* against the [vault spec](vault.md) and reports what
breaks them. The rules are not restated here.

`validate` operates on the *vault* in the working directory. Without an
`autofile.yml` there is nothing to validate, and the command fails.

These rules follow the fields in the vault spec: a rule added there is a rule
here.

A *violation* names the *identity*, what is wrong with it, and the *collection*
that governs it. A *warning* is labelled and names the *collection* in the
*identity*'s place. One finding to a line, *violations* before *warnings*.

```
contacts/priya-narayan — /name: must be string   (contacts)
```

- `schema` — a *record*'s *fields* fail its *collection*'s `schema`.
- `body` — the *record* has a *body* where its *collection* sets `body: false`.
- `parse` — the *record* cannot be read, or its YAML *header* does not parse.
- `config` — `autofile.yml` cannot be read, does not parse, or is not a valid
  *config*. This one concerns the *vault*'s own file, so it names neither a
  *record* nor a *collection*.

`validate` also reports warnings: legal, but usually a mistake. They do not
make the *vault* invalid.

- `empty` — a declared *collection* with nothing in it: missing, not a folder,
  or holding nothing but ignored entries. Legitimate when a *collection* is
  declared before anything is filed into it, and indistinguishable from a
  mistyped name otherwise.

Findings are reported in a deterministic order, so two runs over an unchanged
*vault* produce identical output.

`validate` exits zero when the *vault* is valid and non-zero when it is not.
Warnings do not change the exit code — a warning that fails a build is not a
warning. A valid *vault* still prints a line naming what was checked, so a run
that found nothing is distinguishable from one that found everything in order.
