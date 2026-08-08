---
name: autofile
description: Predictable filing for agents. Use when filing information that should outlive the current task, retrieving what was filed, or creating a vault.
---

# Autofile

A vault is a folder governed by an `autofile.yml` at its root. A note is a
markdown file in it. File into a vault and retrieve from it with your ordinary
file tools.

## Rules

- File proactively, not only on request: whenever information turns up that
  should outlive the current task or might be needed for retrieval later.
- The config may govern only part of the vault. File only into a declared path
  that carries a `description`, which says what belongs there and how to file
  it. A declared path without one scopes rules rather than inviting filing, and
  an undeclared path is not yours to file into.
- Write an internal link as the path to the note without the `.md` extension —
  `[[contacts/priya-narayan]]` or `[label](contacts/priya-narayan)`. Other
  files keep their extension. Quote wikilinks in YAML.
- A link matches on path suffix, nearest note winning, so a bare name resolves
  but may match more than one note. Write enough path to be unambiguous.
- Linking a note that does not exist yet is allowed — it marks something to
  file later.
- Create a vault with `autofile init`, then decide its paths with the user by
  editing `autofile.yml` together.
- Fix findings in notes you wrote or changed. Findings in notes you did not
  touch are the user's to triage — report them, do not silently rewrite them.
- Do not speculate or invent content.

## Sequences

Before either sequence, read `autofile.yml`, unless it is already in context.

Every step is mandatory: follow a sequence in full, never sample it.

### Filing

1. Identify the durable information in the input; all of it gets preserved.
2. Search for existing notes on the same subject and related ones; read them
   before writing.
3. Choose paths: the most specific description that fits, the broadest only
   when nothing narrower does. When nothing fits, ask.
4. Write: a new note, an update to existing notes, or both — one input may
   touch several. Link related notes; file other files at their described
   paths.
5. Run `autofile check` and fix what it reports.

### Retrieval

1. Choose the strategy by the question: the path for a kind of thing, the
   filename for something named or dated, a field for a known value, links for
   what connects, and search for the rest.
2. Read the notes found and follow their links onward.
