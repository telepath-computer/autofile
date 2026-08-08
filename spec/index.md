# Autofile

Autofile is a filing convention for agents. A vault is a folder of markdown
notes with an `autofile.yml` declaring what the folders hold and what their
notes must satisfy; agents file into it and retrieve from it with the file
tools they already have. The config may govern the whole folder or a corner
of one that already exists, so an Obsidian vault can adopt it a path at a
time. This repository ships the spec, the `autofile` CLI, and the skill that
instructs agents.

- [Vault](vault.md) — vault semantics: the config, notes, internal links.
- [CLI](cli.md) — the `autofile` binary: `init` and `check`.
- [Skill](skill.md) — what the agent-facing instructions must cover.

## Distribution

The package is published as `@telepath-computer/autofile` and provides the
`autofile` binary. The skill installs with `npx skills add
telepath-computer/autofile`.

## Non-goals

- **Query tooling.** No list, get, or search commands: retrieval is the
  agent's native filesystem skillset.
- **Auto-fix.** `check` reports; it never rewrites files.
- **Schema migration.** Changing a path's schema over existing notes is
  done by hand with `check` as the guide. A migration command is a possible
  later addition, not designed here.
- **Link adjudication.** `check` reports an internal link that resolves to
  nothing. Which of several same-named notes a bare link meant is a
  question about writing, not about whether the vault is well-formed.
