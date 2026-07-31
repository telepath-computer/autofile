# Autofile

> ⚠️ **Experimental.** Early-stage software. The config schema, CLI, and
> API may change without notice between releases. Pin exact versions if
> you depend on it.

Predictable filing for agents.

Like a wiki, notes app, or database, Autofile gives agents a durable place to file information. Its characteristic shape is flat files with strict typing: an Autofile vault specifies the types of things that can be stored, where each type belongs, and the rules for how records should be filed and organized.

Autofile is designed for:

- **No ambiguity on input.** Every input should have a specific, well-defined place in the system and clear instructions for how it should be filed.
- **Efficient retrieval.** Vaults are structured to be flat, typed, and searchable through methods agents already use well: keyword search, semantic search, property matching, filenames, links, and normal filesystem traversal.
- **Native agent editing.** Agents can read, write, move, validate, and query records with ordinary filesystem tools, then trust the result across runs.
- **Progressive enhancement.** A vault can start simple, then grow through skills that bundle scripts, schemas, filing rules, and operations for specific workflows or data types such as tasks, calendars, email, receipts, and more.

## How it works

An Autofile vault is just a directory, but it is not an unstructured notes folder. The root `VAULT.md` is the contract: it describes what kinds of records exist, which folders own them, which frontmatter fields they use, and how validation works.

A small vault might look like this:

```txt
my-vault/
├── VAULT.md              # the filing spec agents must follow
├── .fslint.yml           # machine-readable validation for the spec
├── contacts/
│   └── priya-narayan.md  # one person or organization
├── places/
│   └── blue-kettle-cafe.md
├── events/
│   └── 2026-06-03-small-machines-visit.md
├── references/
│   └── risograph-printing-guide.md
├── context/
│   └── desk-lamp-repair.md
└── _assets/
    └── risograph-guide.html
```

Each top-level folder is a record type. Each markdown file is one record: one person, place, event, source, task, or subject. The folder tells the agent what kind of thing it is; `VAULT.md` tells the agent how to file it; `.fslint.yml` gives the vault a validation gate.

Because the filing system is plain files, agents can use the tools they are already good at: read a spec, grep for names, follow links, match frontmatter properties, move files, edit markdown, and run validation. The structure keeps writes predictable without hiding retrieval behind a proprietary app or opaque database.

## Get started

Install the autofile skill with `skills`:

```sh
npx skills add telepath-computer/autofile
```

Or copy it into your agent's skills directory manually:

```sh
cp -R skills/autofile ~/.agents/skills/autofile
```

Initialize a new vault by following the Vault setup section in `skills/autofile/SKILL.md`: copy `templates/` into the target directory.

Run validation with `fslint`:

```sh
cd /path/to/vault
npx @telepath-computer/fslint
```

## Server

`server/` holds [`@telepath-computer/autofile-server`](server/spec/index.md), a local HTTP server that exposes vaults to apps: it serves records as JSON with frontmatter transformed into structured properties, and accepts writes so an app can create and update records. `server/spec/index.md` is the full interface spec.

```sh
npm install
npm run build --workspace server
node server/dist/src/cli.js --vault main=/path/to/vault
```

Or put the binary on your PATH with `npm link --workspace server`, then `autofile-server --vault main=/path/to/vault`.

## Test

```sh
npm test
```
