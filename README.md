# Vault

> ⚠️ **Experimental.** Early-stage software. The config schema, CLI, and
> API may change without notice between releases. Pin exact versions if
> you depend on it.

Portable filesystem memory for agents.

Unlike a wiki, notes app, or vector database, a vault is a strict, typed filesystem: each top-level folder defines a record type, `VAULT.md` defines the rules, and `fslint` enforces the schema. The focus is no ambiguity on input, and effective, efficient retrieval on output. Agents can edit safely, query with normal filesystem tools, and trust the result across runs.

A vault starts simple and can be progressively enhanced with scripts, schemas, and extensions for specific workflows such as tasks, calendars, email, receipts, etc.

## Get started

Copy the vault skill into your agent's skills directory:

```sh
cp -R skills/vault ~/.agents/skills/vault
```

Initialize a new vault by following:

```sh
skills/vault/INSTALL.md
```

Run validation with `fslint`:

```sh
cd /path/to/vault
npx @telepath-computer/fslint
```

## What's here

- `skills/vault/SKILL.md` — agent behavior for filing and retrieving from a vault.
- `skills/vault/templates/VAULT.md` — starter vault spec.
- `skills/vault/templates/.fslint.yml` — starter schema validation.
- `skills/vault/INSTALL.md` — manual install instructions.
- `example/` — example vault.
- `test/` — tests for the starter template and example.

## Test

```sh
npm test
```
