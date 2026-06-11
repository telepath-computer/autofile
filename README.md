# Autofile

> ⚠️ **Experimental.** Early-stage software. The config schema, CLI, and
> API may change without notice between releases. Pin exact versions if
> you depend on it.

Predictable filesystem memory for agents.

Unlike a wiki, notes app, or vector database, Autofile is a strict, typed filesystem for agent memory: each top-level folder defines a record type, `VAULT.md` defines the rules, and `fslint` validates the frontmatter schema. The focus is no ambiguity on input, and effective, efficient retrieval on output. Agents can edit safely, query with normal filesystem tools, and trust the result across runs.

An Autofile vault starts simple and can be progressively enhanced with scripts, schemas, and extensions for specific workflows such as tasks, calendars, email, receipts, etc.

## Anatomy and terms

- **Autofile** is the project and installable agent skill.
- A **vault** is the typed directory that Autofile helps an agent maintain.
- `VAULT.md` is the root spec for a vault. It stays named `VAULT.md` because it describes the data structure, not the tool managing it.
- Top-level folders such as `contacts/`, `places/`, and `events/` define record types.
- A **record** is one markdown file in a typed folder, with structured frontmatter and concise body text.
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
