# Autofile

> ⚠️ **Experimental.** Early-stage software. The vault format, the config
> schema, and the CLI may change without notice between releases.

Predictable filing for agents.

Autofile is a set of conventions and a CLI for agents to file information
reliably and consistently, so it can be retrieved effectively and used in
user-facing surfaces such as artifacts. Its goals:

- **Unambiguous filing.** Every input has one well-defined place to go.
- **Effective retrieval.** What was filed can be found again, by the methods
  agents already use well.
- **Works across environments.** Agents use it directly, other programs use it
  locally or over the network, and web apps fetch it to build interfaces.
- **Progressive enhancement.** Point it at a folder you already have and it
  works with minimal change; grow it until it governs everything on the
  machine.

## A vault

A vault is a folder with an `autofile.yml` at its root:

```
my-vault/
├── autofile.yml
├── contacts/
│   └── priya-narayan.md
└── events/
    └── 2026-06-03-small-machines-visit.md
```

Records are markdown. The YAML header holds structured data; `[[…]]` points at
another record.

```markdown
---
name: Priya Narayan
related: ["[[events/2026-06-03-small-machines-visit]]"]
---

Printmaker. Good person to ask about paper stock and small-run risograph shops.
```

The config says which folders hold records, and what a record in each looks
like:

```yaml
paths:
  /contacts:
    description: |
      People and organizations. One record per person or organization.
    schema:
      required: [name]
    filename: { pattern: "^[a-z0-9-]+$" }
```

`description` is written for the agent: it is what tells it when something
belongs here rather than somewhere else.

## Getting started

Give your agent the skill:

```sh
npx skills add telepath-computer/autofile
```

Then ask it to set up a vault. It works the paths out with you — what you want
to keep, where each kind belongs, what a record of each looks like — and writes
the `autofile.yml`. After that it files without being told how, and reads from
the vault when something already filed answers the question.

## The CLI

```sh
npm install -g @telepath-computer/autofile
```

`autofile validate` checks a vault against its own rules, run from inside it:

```
$ autofile validate
contacts/Bad Name.md — must match pattern "^[a-z0-9-]+$"   (/contacts)
warning: /archive — nothing at this path
/home/you/my-vault — 42 records in 3 paths, 1 violation
```

It exits non-zero when the vault is invalid. `autofile --help` lists the
commands.
