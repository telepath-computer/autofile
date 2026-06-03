---
name: vault
description: Durable filesystem memory for agents. Use when creating, editing, filing, querying, or reorganizing a markdown vault.
---

# Vault

- A vault is durable filesystem memory.
- Use the vault as the source of truth whenever storing or retrieving information that should outlive the current task.
- The vault has a strict path-based filing system. Each top-level folder defines its own filing rules, schema, and conventions.

## Filing

- If multiple vaults are available, choose the vault by reading each relevant `VAULT.md`; file in the vault whose scope matches the information.
- Read the selected vault's `VAULT.md` spec before filing, unless it is already in context.
- Clarify what the input is and what may be meaningful to the user later.
- Search for existing records for the same thing and related things; read them before writing.
- File in the appropriate typed location(s): a new record, an update to existing record(s), or both.
  - Example: a journal entry says a person now lives in a new country; file the journal entry and update that person's contact record.
- Use content, properties, labels, and wikilinks to make the information retrievable later.
- If the destination, schema, or meaning is unclear, ask or create a follow-up task for the user instead of guessing.
- Do not add commentary, speculation, or invented information. Paraphrase only to preserve meaning; future reads will treat the vault as source of truth.
- Write concise, information-dense records optimized for fast writes and accurate future retrieval. Do not optimize for human browsing; users will usually read synthesized views, not raw vault files.

## Records

- A record is one markdown file representing one thing: a person, event, task, subject, source, or state surface.
- The folder gives the record its type; follow that folder's schema.
- Use frontmatter for structured properties and the body for concise context, links, and retrieval cues.
- Unless specified otherwise, prefer updating an existing record over creating a duplicate.

## Path resolution

- A record's vault-relative file path is its stable ID.
- Path fields use these resolution rules:
  - `/path/to/file` — absolute filesystem path.
  - `~/path/to/file` — home-relative filesystem path.
  - `relative/path` — vault-relative path.
  - `https://...` — URL; use only in URL fields.
- Prefer vault-relative paths when the file is owned by the vault.
- Non-path identifiers may use explicit system prefixes, e.g. `television:01KT...`.

## Install

- To initialize a new vault, follow `INSTALL.md`.

## `VAULT.md`

- Every vault must have a root `VAULT.md`.
- `VAULT.md` is the canonical spec for the vault; agents must follow it exactly.
- `VAULT.md` defines top-level folder rules with path headings such as `### /contacts`; nested folders may define states or sub-conventions.
- `VAULT.md` may include optional scope/description text at the top; use it when choosing between multiple vaults.
- See `references/vault-spec-format.md` before creating or changing a vault spec.
- `VAULT.md` is canonical. `.fslint.yml` enforces the schema. Keep them in sync.
- If `VAULT.md` and `.fslint.yml` conflict, stop and ask or create a follow-up task; do not guess.

## Record types

- The root `VAULT.md` defines the vault's record types, folder rules, schemas, and field names. Treat it as strict.
- Do not infer record types or folder meanings from other vaults.
- Run the validation commands listed in `VAULT.md` after edits.

## Labels

- Labels are curated retrieval sets across record types.
- Use labels as a retrieval path when searching the vault.
- Apply relevant labels to records when they improve future retrieval.
- Use labels for user-relevant groupings that are not redundant with folder, field, wikilink, or obvious text search retrieval.
- Before adding a new label, review the existing label list. Add a label only if it is distinct from existing labels and likely to support future retrieval.
- When adding a new label, update the vault's label list or schema if one exists.

## Assets

- Store vault-owned source material and attached files in `assets/`, regardless of format.
- Assets may be PDFs, images, audio, HTML, markdown, data files, or any other file the vault record should preserve, index, or point to. By contrast, record bodies are for concise agent-authored context, links, and retrieval cues.
- When an asset is the source or subject of a record, reference it in frontmatter using the vault's configured asset field.

## Retrieval

- Read `VAULT.md` to identify relevant folders, properties, labels, and extensions before searching.
- Choose retrieval strategies based on the question: folder/type, filename/date, frontmatter properties, labels, wikilinks/backlinks, body text, or assets.
- Use extensions for specialized queries, such as task lifecycle queries.

## Extensions

- Some record types have specific workflows beyond general vault filing, such as task lifecycle or calendar synchronization.
- The vault `VAULT.md` lists any extensions and their associated skills or tools.
- When an extension exists for a record type, read and follow the associated skill before creating, editing, querying, or changing lifecycle for that type.
