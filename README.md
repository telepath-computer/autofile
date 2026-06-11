# Autofile

> ⚠️ **Experimental.** Early-stage software. The config schema, CLI, and
> API may change without notice between releases. Pin exact versions if
> you depend on it.

Predictable filesystem memory for agents.

Unlike a wiki, notes app, or vector database, a vault is a strict, typed filesystem: each top-level folder defines a record type, `VAULT.md` defines the rules, and `fslint` enforces the schema. The focus is no ambiguity on input, and effective, efficient retrieval on output. Agents can edit safely, query with normal filesystem tools, and trust the result across runs.

An autofile vault starts simple and can be progressively enhanced with scripts, schemas, and extensions for specific workflows such as tasks, calendars, email, receipts, etc.

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
- `example/` — example vault.
- `test/` — tests for the starter template and example.

## Test

```sh
npm test
```
