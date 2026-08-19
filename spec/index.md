# Autofile

Autofile is a strictly typed filing system for agents. An `autofile.yml`
declares folders of a markdown vault and states what is true inside
each — what belongs there, what shape its notes take, what files it may
hold — so that
agents can file reliably and applications can trust the data. It governs
only what it declares: an existing vault adopts Autofile by declaring
one folder, and tightens by declaring more; a vault can also opt into
`strict`, where nothing is ungoverned. This repository ships the spec,
the `autofile` CLI, and the skill that instructs agents.

- [Vault](vault.md) — vault semantics: the config, notes, folder
  entries, internal links.
- [CLI](cli.md) — the `autofile` binary: `init`, `check`, and `serve`.
- [Skill](skill.md) — what the agent-facing instructions must cover.

## Distribution

The package is published as `@telepath-computer/autofile` and provides the
`autofile` binary. It requires Node 24, matching vault-server. The skill
installs with `npx skills add
telepath-computer/autofile`.

## Non-goals

- **Query tooling.** No list, get, or search commands: retrieval is the
  agent's native filesystem skillset.
- **Auto-fix.** `check` reports; it never rewrites files.
- **Schema migration.** Changing a folder's schema over existing notes
  is done by hand with `check` as the guide. A migration command is a
  possible later addition, not designed here.
- **Link adjudication.** `check` reports a link that reaches nothing.
  Which of several same-named notes a bare link meant is a question
  about writing, not about whether the vault is well-formed.
