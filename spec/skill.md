# Skill

The *skill* is the instruction set an agent follows to use [a markdown
vault](vault-markdown.md) — how to file into one, retrieve from one, and create
one. It lives at `skills/autofile/SKILL.md`, at the repository root, where
`npx skills add` reads it.

It belongs to the implementation rather than to [the model](vault.md), because
what an agent has to know is concrete: where the *config* is, what a *record*
looks like as a file, how a *reference* is spelled. A *vault* kept some other
way would need its own.

## Authority

The *skill* derives from the specs. It is installed away from this tree, so it
may state the rules an agent needs in hand rather than refer to them — but only
those. Where the two disagree the specs win and the *skill* has the bug.

## What it must cover

How it is organised is the *skill*'s own business; this is the content, not a
structure.

The agent works the folder directly, with the file tools it already has. It
does not go through the API, and nothing needs to be running.

- When to reach for a *vault*: whenever information is encountered that should
  be durable, meaning it should outlive the current task. Filing is proactive
  rather than only on request.
- Reading the `autofile.yml` at the folder's root before acting. Its
  *collections* are what exists and their descriptions are filing instructions
  rather than documentation, and this is the step most often skipped.
- Creating a *vault* by writing an `autofile.yml`, and confirming it with
  `autofile-md validate`. Its structure is decided with the user rather than
  designed by the agent alone.
- Filing: search for existing *records* first and prefer updating one over
  creating a duplicate. Fan out when one input touches several *records*.
- Choosing a *collection*, which is a filing decision for *blobs* as much as
  for *records*.
- Writing a *record*: a `.md` file in the *collection*'s folder, its `---`
  *header* carrying the *fields* its `schema` requires, and the *body* below —
  or no *body*, where the *collection* sets `body: false`.
- Where a *blob* goes: any path under the folder, addressed through the blob
  *collection*, including beside the *record* that references it.
- Referencing: `[[collection/key]]`, quoted in YAML, and what a *reference* may
  point at.
- Retrieval: by *collection*, by *field*, by *reference*, and by search.
- Running `autofile-md validate` after a change, and that a *violation* means
  the *vault* is broken rather than untidy.
- What not to do: no speculation, no invented content, and asking rather than
  guessing when the destination is unclear.

## How it is written

Terse and imperative, addressed to an agent rather than a reader. It says what
to do; why the system is shaped this way belongs in the specs. It says each
thing once — a *skill* that repeats itself is one an agent can follow two ways.
