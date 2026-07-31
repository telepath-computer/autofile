---
name: autofile
description: Predictable filing system for agents. Use when creating, editing, filing, querying, or reorganizing a markdown vault.
---

# Autofile

- A vault is a durable filesystem filing system.
- Use the vault as the source of truth whenever filing or retrieving information that should outlive the current task.
- The vault has a strict path-based filing system. Each top-level folder defines its own filing rules, schema, and conventions.

## Filing

- If multiple vaults are available, choose the vault by reading each relevant `VAULT.md`; file in the vault whose scope matches the information.
- Read the selected vault's `VAULT.md` spec before filing, unless it is already in context.
- Clarify what the input is and what may be meaningful to the user later.
- Search for existing records for the same thing and related things; read them before writing.
- File in the appropriate typed location(s): a new record, an update to existing record(s), or both.
  - Example: a journal entry says a person now lives in a new country; file the journal entry and update that person's contact record.
- Use content, properties, and wikilinks to make the information retrievable later.
- If the destination, schema, or meaning is unclear, ask or create a follow-up task for the user instead of guessing.
- Do not add commentary, speculation, or invented information. Paraphrase only to preserve meaning; future reads will treat the vault as source of truth.
- Write concise, information-dense records optimized for fast writes and accurate future retrieval. Do not optimize for human browsing; users will usually read synthesized views, not raw vault files.

## Records

- A record is one markdown file representing one thing: a person, event, task, subject, or source.
- The folder gives the record its type; follow that folder's schema.
- Use frontmatter for structured properties and the body for concise context, links, and retrieval cues.
- Dates use `YYYY-MM-DD`; use full timestamps only when the time is materially important.
- Unless specified otherwise, prefer updating an existing record over creating a duplicate.

## Path resolution

- A record's vault-relative file path is its stable ID.
- Record references use wikilinks: the full vault-relative path without the `.md` extension, e.g. `[[contacts/priya-narayan]]`. Do not use bare slugs like `[[priya-narayan]]`.
- Always quote wikilinks in frontmatter — unquoted, `[[contacts/priya-narayan]]` is a nested array to YAML, not a link.
- Path fields that point at files rather than records use these resolution rules:
  - `/path/to/file` — absolute filesystem path.
  - `~/path/to/file` — home-relative filesystem path.
  - `relative/path` — vault-relative path.
  - `https://...` — URL; use only in URL fields.
- Prefer vault-relative paths when the file is owned by the vault.
- Non-path identifiers may use explicit system prefixes, e.g. `television:01KT...`.

## Vault setup

- To initialize a vault, copy the full contents of this skill's `templates/` into the target directory. If a folder `VAULT.md` names does not exist, create it when needed.
- Adjust the record types with the user as needed, keeping `VAULT.md` and `.fslint.yml` in sync with any changes.
- Do not overwrite existing files unless the user explicitly asks.
- Validate from the vault root: `npx @telepath-computer/fslint`.

## `VAULT.md`

- Every vault must have a root `VAULT.md`.
- `VAULT.md` is the canonical spec for the vault; agents must follow it exactly.
- Record types live under `## Record types` with path headings: `### /` for global rules and default properties, `### /<path>` per record type; nested paths may define sub-conventions. Typed sections list `Additional properties:` beyond the global set.
- Other sections are the vault's own: scope/description text at the top helps choose between multiple vaults; a `## Validation` section lists the commands to run after edits.
- `templates/VAULT.md` in this skill is the canonical example of the format.
- `VAULT.md` is canonical. `.fslint.yml` enforces the schema. Keep them in sync.
- If `VAULT.md` and `.fslint.yml` conflict, stop and ask or create a follow-up task; do not guess.

## Record types

- The root `VAULT.md` defines the vault's record types, folder rules, schemas, and field names. Treat it as strict.
- Do not infer record types or folder meanings from other vaults.
- A record type's spec may name a skill for that type; read and follow it before creating, editing, querying, or changing lifecycle for that type.
- Run the validation commands listed in `VAULT.md` after edits.

## Assets

- Store vault-owned source material and attached files in `_assets/`, regardless of format.
- Files and folders starting with `_` are ignored by the filing system and exempt from vault rules.
- Assets may be PDFs, images, audio, HTML, markdown, data files, or any other file the vault record should preserve, index, or point to. By contrast, record bodies are for concise agent-authored context, links, and retrieval cues.
- When an asset is the source or subject of a record, reference it in frontmatter using the vault's configured asset field.

## Retrieval

- Read `VAULT.md` to identify relevant folders, properties, and skills before searching.
- Choose retrieval strategies based on the question: folder/type, filename/date, frontmatter properties, wikilinks/backlinks, body text, or assets.
