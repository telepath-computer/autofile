# Autofile

Autofile is a set of conventions and an API for agents to file information
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
- [Vault](vault.md) — the model both contracts are written in: collections of
  records and blobs, how they are identified, and how they are referenced.
- [HTTP API](http-api.md) — the contract a vault answers, and what a vault is
  from outside.
- [Markdown vault](vault-markdown.md) — the other contract: a vault kept as a
  folder, and the command that serves it.
- [Skill](skill.md) — the instructions an agent follows to use a markdown
  vault, and what they must cover.
- [README](readme.md) — what the repository's front page must cover.

## Architecture

There is no plugin architecture and no shared vault library. What holds the
system together is [the API](http-api.md), so a second implementation is a
second program answering it rather than a package loaded into this one.

Autofile is written in TypeScript for Node, as npm workspaces under
`packages/`.

- `packages/vault-markdown` — `@autofile/vault-markdown`: the folder format, the
  server that answers the API for one, and the `autofile-md` command.

## Distribution

Autofile is published under the `@autofile` scope. `@autofile/vault-markdown`
provides `autofile-md`, which serves and checks a folder.

Further implementations follow the same shape: `@autofile/vault-sqlite` would
provide `autofile-sqlite`. Anyone outside the scope publishes their own name and
nothing breaks, since these are separate programs rather than plugins.

`autofile` is left unclaimed. A client that talks to a served *vault* over the
API is the obvious thing to call it, and that is what agents would use, but
nothing is written and nothing depends on it.

The skill is installed into an agent's skills directory with
`npx skills add telepath-computer/autofile`.
