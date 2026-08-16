# Autofile

> ⚠️ **Experimental.** Early-stage software; the config format and CLI may
> change without notice. Pin exact versions if you depend on it.

Predictable filing for agents.

Autofile is a place for agents to file durable information, optimized for
hands-off input and retrieval. Data is stored in a *vault*: a folder of
markdown notes and other files, governed by an `autofile.yml` that says what
each folder holds and what its notes must satisfy. Its categories and
conventions are customized per user.

The config can govern a whole folder or one corner of a folder you already
have, so an existing Obsidian vault adopts it a path at a time — nothing
you have not declared is Autofile's business.

Autofile is designed for:

- **No ambiguity on input.** What you declare has a specific, well-defined
  place and clear instructions for how it is filed.
- **Efficient retrieval.** What you have typed is searchable by the
  methods agents already use well: keyword search, property matching,
  filenames, links, and normal filesystem traversal.
- **Plain files, no lock-in.** A vault is an ordinary folder: Obsidian
  opens it, Dropbox syncs it, git diffs it, any file server serves it.

## Get started

Install the CLI, then write a config in a folder of your choice and check
it:

```sh
npm install -g @telepath-computer/autofile

cd my-vault
autofile init
autofile check
```

`init` writes an `autofile.yml` that declares nothing and documents the
format in comments, so the first `check` passes whether the folder is
empty or holds twenty thousand notes. `check` validates the vault —
findings one per line, non-zero exit on violations.

Then install the skill, so an agent can file and retrieve on your behalf:

```sh
npx skills add telepath-computer/autofile
```

Shape the vault with your agent: the paths and their descriptions are the
filing system, so decide them together.

## The config

Declare the folders you want governed. Each says what belongs there, and
may add rules the notes must satisfy:

```yaml
version: 1

folders:
  - path: contacts
    description: |
      People and organizations. One note per person or organization.
    schema:
      required: [title, kind]
      properties:
        title: { type: string }
        kind: { enum: [person, organization] }
    body: none

  - path: daily-notes
    description: |
      One note per day.
    filename_pattern: '^\d{4}-\d{2}-\d{2}$'
```

Descriptions are filing instructions, not documentation — they are what an
agent reads to decide where something goes. Rules are optional. A folder entry
governs its subtree; a more specific entry replaces it wholesale, with no
settings inherited or merged.

Add `strict: true` when the config completely describes the vault, and any
file outside a declared path becomes a violation.

### Property types

Obsidian's property types map onto ordinary JSON Schema, with two formats
Autofile adds:

| Property | Schema |
| --- | --- |
| Text | `type: string` |
| List | `type: array`, `items: { type: string }` |
| Number | `type: number` |
| Checkbox | `type: boolean` |
| Date | `type: string, format: date` |
| Date & time | `type: string, format: datetime` |
| A link | `type: string, format: internal-link` |

`datetime` exists because JSON Schema's own `date-time` demands a timezone
offset that Obsidian does not write; `internal-link` types a link, and
`check` separately reports the ones pointing at nothing.

## Spec

[`spec/index.md`](https://github.com/telepath-computer/autofile/blob/main/spec/index.md)
is authoritative: the vault format, the CLI, and what the skill must cover.
