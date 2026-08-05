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
- [Vault rules](vault-rules.md) — what a vault is: its `autofile.yml` config,
  what counts as a record, the files it holds alongside them, and how records
  and files are referenced.
- [CLI](cli.md) — the `autofile` command: how it finds a vault, what
  `validate` reports, and how the code is laid out.
- [Skill](skill.md) — the instructions an agent follows to use a vault, and
  what they must cover.
- [README](readme.md) — what the repository's front page must cover.

## Distribution

Autofile is published as `@telepath-computer/autofile`, which provides the
`autofile` binary.

The skill is installed into an agent's skills directory with
`npx skills add telepath-computer/autofile`.
