# Autofile

Autofile is a filing convention for agents. A vault is a folder of markdown
files governed by one config file at its root; agents file into it and
retrieve from it with the file tools they already have. This repository
ships the spec, the `autofile` CLI, and the skill that instructs agents.

- [Vault](vault.md) — vault semantics: the config, records, references.
- [CLI](cli.md) — the `autofile` binary: `init` and `check`.
- [Skill](skill.md) — what the agent-facing instructions must cover.

## Distribution

The package is published as `@telepath-computer/autofile` and provides the
`autofile` binary. The skill installs with `npx skills add
telepath-computer/autofile`.

## Non-goals

- **Query tooling.** No list, get, or search commands. Retrieval is the
  agent's native filesystem skillset; tooling it would duplicate what agents
  already do well.
- **Auto-fix.** `check` reports; it never rewrites files.
- **Schema migration.** Changing a path's schema over existing records is
  done by hand with `check` as the guide. A migration command is a possible
  later addition, not designed here.
