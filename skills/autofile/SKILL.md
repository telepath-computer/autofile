---
name: autofile
description: Predictable filing for agents. Use when filing information that should outlive the current task, retrieving what was filed, or creating a vault.
---

# Autofile

`autofile.yml` is the vault's complete contract: there is no `VAULT.md` or
`.fslint.yml` to look for, and `autofile check` is what validates.

A vault is a folder governed by an `autofile.yml` at its root. A note is a
markdown file in it. File into a vault and retrieve from it with your ordinary
file tools.

## Rules

- File proactively, not only on request: whenever information turns up that
  should outlive the current task or might be needed for retrieval later.
- Read `autofile.yml` as the map of what is governed. File only into a declared
  folder whose `description` says the information belongs there; territory no
  entry covers is not yours to file into. When nothing fits, ask, and declare a
  folder with the user instead of inventing one.
- Follow the conventions in `autofile.yml` as written: `link_format`,
  `filename_pattern`, and each folder entry's `extensions`, `schema`, `body`,
  and `additional_subfolders`. Do not recall or assume them from another vault.
- Write references with full vault paths, even where a shorter link resolves,
  so their meaning does not drift as the vault grows. Linking a note that does
  not exist yet is allowed — it marks something to file later. Do not link a
  folder or a prose path; keep those as plain text.
- Create a vault with `autofile init`, then declare its folders with the user by
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
3. Choose the destination: the most specific folder description that fits, the broadest only
   when nothing narrower does. When nothing fits, ask.
4. Write: a new note, an update to existing notes, or both — one input may
   touch several. Reference related notes; file other files where their
   folder's description says.
5. Run `autofile check` and fix what it reports, warnings included. Never
   invent content to do so: file a real missing note, correct its link, or ask
   the user when the needed information is unavailable.

### Retrieval

1. Choose the strategy by the question: the folder for a kind of thing, the
   filename for something named or dated, a field for a known value, links for
   what connects, and search for the rest.
2. Read the notes found and follow their links onward.
