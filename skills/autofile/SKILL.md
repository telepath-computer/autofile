---
name: autofile
description: Predictable filing for agents. Use when filing information that should outlive the current task, retrieving what was filed, or creating a vault.
---

# Autofile

A vault is a folder of markdown records governed by an `autofile.yml` at its
root. File into it and retrieve from it with your ordinary file tools.

## General rules

- File proactively, not only on request. Whenever information turns up that
  should outlive the current task or might be needed for retrieval later,
  preserve all of it — never drop durable information.
- Read `autofile.yml` before acting. Path descriptions are filing
  instructions: what belongs in each scope and how to file it.
- Write references as the full vault-relative path: records without the
  `.md` extension (`[[contacts/priya-narayan]]` or
  `[label](contacts/priya-narayan)`), any other file with its extension.
  Quote wikilinks in YAML. Bare slugs (`[[priya-narayan]]`) never resolve.
  Referencing a record that does not exist yet is allowed — it marks
  something to file later.
- Create a vault with `autofile init`. Decide its paths with the user, not
  alone.
- Run `autofile check` after any change. This is a MUST, not a suggestion.
  A violation means the vault is broken, not untidy — fix it.
- Do not speculate or invent content. When the destination is unclear, ask
  rather than guess.

## Sequences

Before either sequence, read the config, unless it is already in context.

Every step is mandatory: follow a sequence in full, never sample it.

### Filing

1. Identify the durable information in the input — everything that outlives
   the current task or might be needed for retrieval later gets preserved.
2. Search for existing records on the same subject and related ones; read
   them before writing.
3. Choose paths: the most specific description that fits; the broadest only
   when nothing narrower does.
4. Write: a new record, an update to existing records, or both — one input
   may touch several. Reference related records; file non-record files at
   their described paths.
5. Run `autofile check` and fix what it reports. Never skip this step.

### Retrieval

1. Choose the strategy by the question: the path for a kind of thing, the
   filename for something named or dated, a field for a known value,
   references for what connects, and search for the rest.
2. Read the records found and follow their references onward.
