# Autofile

> ⚠️ **Experimental.** Early-stage software. The config schema, CLI, and
> API may change without notice between releases. Pin exact versions if
> you depend on it.

Predictable filesystem memory for agents.

Like a wiki, notes app, or vector database, Autofile gives agents durable memory. Unlike those systems, an Autofile vault is a strict, typed filesystem: it specifies the types of things that can be stored, where each type belongs, and the rules for how records should be filed and organized.

Autofile is designed for:

- **No ambiguity on input.** Every input should have a specific, well-defined place in the system and clear instructions for how it should be filed.
- **Efficient retrieval.** Vaults are structured to be flat, typed, and searchable through methods agents already use well: keyword search, semantic search, property matching, filenames, links, and normal filesystem traversal.
- **Native agent editing.** Agents can read, write, move, validate, and query records with ordinary filesystem tools, then trust the result across runs.
- **Progressive enhancement.** A vault can start simple, then grow through skills that bundle scripts, schemas, filing rules, and operations for specific workflows or data types such as tasks, calendars, email, receipts, and more.

## Anatomy and terms

- **Autofile** is the project and installable agent skill.
- A **vault** is the typed directory that Autofile helps an agent maintain.
- `VAULT.md` is the root spec for a vault: it defines record types, folder rules, schemas, labels, validation commands, and any extensions.
- Top-level folders such as `contacts/`, `places/`, and `events/` define record types.
- A **record** is one markdown file representing one thing, with structured frontmatter and concise body text.
- `.fslint.yml` is the machine-readable validation config kept in sync with `VAULT.md`.

## Get started

Install the autofile skill with `skills`:

```sh
npx skills add telepath-computer/autofile --skill autofile
```

Or copy it into your agent's skills directory manually:

```sh
cp -R skills/autofile ~/.agents/skills/autofile
```

Initialize a new vault by following:

```sh
skills/autofile/INSTALL.md
```

Run validation with `fslint`:

```sh
cd /path/to/vault
npx @telepath-computer/fslint@0.3.3
```

## What's here

- `skills/autofile/SKILL.md` — agent behavior for filing and retrieving from a vault.
- `skills/autofile/templates/VAULT.md` — starter vault spec.
- `skills/autofile/templates/.fslint.yml` — starter schema validation.
- `skills/autofile/INSTALL.md` — manual install instructions.
- `skills/autofile/references/vault-spec-format.md` — format reference for `VAULT.md`.
- `example/` — example vault.
- `test/` — tests for the starter template and example.

## Test

```sh
npm test
```
