# Autofile

> ⚠️ **Experimental.** Early-stage software; the config format and CLI may
> change without notice. Pin exact versions if you depend on it.

Predictable filing for agents.

Autofile is a place for agents to file durable information, optimized for
hands-off input and retrieval. Data is stored in a *vault*: a folder of
markdown files and assets, with a flat hierarchy and strict types,
governed by config. Its categories and conventions are customized per
user.

Autofile is designed for:

- **No ambiguity on input.** Every input has a specific, well-defined
  place and clear instructions for how it is filed.
- **Efficient retrieval.** Vaults are flat, typed, and searchable by the
  methods agents already use well: keyword search, property matching,
  filenames, links, and normal filesystem traversal.
- **Plain files, no lock-in.** A vault is an ordinary folder: Obsidian
  opens it, Dropbox syncs it, git diffs it, any file server serves it.

A vault looks like this:

```txt
my-vault/
├── autofile.yml            # the config: paths, descriptions, schemas
├── contacts/
│   └── priya-narayan.md    # a record: one file, one thing
├── datasets/
│   └── reading-list.md     # standalone structured data
├── assets/
│   └── risograph-guide.pdf # non-record files, in their sanctioned home
└── topics/
    └── desk-lamp-repair.md # durable notes on anything worth remembering
```

Records are markdown with YAML frontmatter, validated against the config's
JSON Schemas. Wikilinks — `[[contacts/priya-narayan]]` — connect records,
and check reports the dangling ones.

## Get started

Install the CLI, then create a vault in a folder of your choice and check
it:

```sh
npm install -g @telepath-computer/autofile

cd my-vault
autofile init
autofile check
```

`init` writes a starter `autofile.yml` and its folders; `check` validates
the vault — findings one per line, non-zero exit on violations.

Then install the skill, so an agent can file and retrieve on your behalf:

```sh
npx skills add telepath-computer/autofile
```

Shape the vault with your agent: the paths and their descriptions are the
filing system, so decide them together.

## Spec

[`spec/index.md`](spec/index.md) is authoritative: the vault format, the
CLI, and what the skill must cover.
