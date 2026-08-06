# Autofile

Autofile is a set of conventions and a CLI for agents to file information
reliably and consistently, so it can be retrieved effectively and used in
user-facing surfaces such as artifacts.

Its goals:

- **Unambiguous filing.** Every input has one well-defined place to go.
- **Effective retrieval.** What was filed can be found again, by the methods
  agents already use well.
- **Works across environments.** Agents use it directly, other programs use it
  locally or over the network, and web apps fetch it to build interfaces.
- **Progressive enhancement.** Point it at a folder you already have and it
  works with minimal change; grow it until it governs everything on the
  machine.

## Specification

- [Spec policy](policy.md) — how these documents are written, and what
  makes something a spec.
- [Terms](terms.md) — the vocabulary the specs are written in.
- [Vault](vault.md) — what a vault is: its collections of records and blobs,
  how they are identified and referenced, and the interface over them.
- [Markdown vault](vault-markdown.md) — how a vault kept as markdown files is
  stored.
- [CLI](cli.md) — the `autofile` command: how it finds a vault and what
  `validate` reports.
- [Server](server.md) — `autofile serve`, and what a vault looks like over
  HTTP.
- [Skill](skill.md) — the instructions an agent follows to use a vault, and
  what they must cover.
- [README](readme.md) — what the repository's front page must cover.

## Architecture

Autofile is written in TypeScript for Node, as npm workspaces under
`packages/`. Each directory is named for its package without the scope.

- `packages/core` — `@autofile/core`: the model and the interface a *vault*
  implementation provides — *collections*, *records*, *blobs*, *references*,
  findings — and the little logic that is not storage-specific, such as
  splitting an *identity*. Nothing here knows what markdown is, and nothing
  here does I/O.
- `packages/vault-markdown` — `@autofile/vault-markdown`: `MarkdownVault`.
  Files, frontmatter, and folders on disk, and the only place the storage
  format is visible.
- `packages/cli` — `@autofile/cli`: argument parsing, commands, and output.

The dependency direction is enforced by the build rather than by convention:
`core` depends on nothing here, and cannot import from the others.

## Distribution

Autofile is published under the `@autofile` scope. `@autofile/cli` provides the
`autofile` binary and is what you install.

The skill is installed into an agent's skills directory with
`npx skills add telepath-computer/autofile`.
