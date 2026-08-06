# Skill

The *skill* is the instruction set an agent follows to use a *vault* — how to
file into one, retrieve from one, and create one. It lives at
`skills/autofile/SKILL.md`.

## Authority

The *skill* derives from the [vault spec](vault.md). It is installed
away from this tree, so it may state the rules an agent needs in hand rather
than refer to them — but only those. Where the two disagree the rules win and
the *skill* has the bug.

## What it must cover

How it is organised is the *skill*'s own business; this is the content, not a
structure.

- When to reach for a *vault*: whenever information is encountered that should be
  durable, meaning it should outlive the current task. Filing is proactive
  rather than only on request.
- Reading `autofile.yml` before acting. Its descriptions are filing
  instructions rather than documentation, and this is the step most often
  skipped.
- Creating a *vault* by writing an `autofile.yml`, and confirming it with
  `autofile validate`. Its structure is decided with the user rather than
  designed by the agent alone.
- Filing: search for existing *records* first and prefer updating one over
  creating a duplicate. Fan out when one input touches several *records*.
- Choosing a *collection*, which is a filing decision for *blobs* as much as
  for *records*.
- Writing a *record*: *header* and *body*, conforming to the *collection*'s
  `schema` and `body`.
- Referencing *records* and *blobs*.
- Retrieval: by *collection*, by *field*, by *reference*, and by search.
- Validating after a change.
- What not to do: no speculation, no invented content, and asking rather than
  guessing when the destination is unclear.

## How it is written

Terse and imperative, addressed to an agent rather than a reader. It says what
to do; why the system is shaped this way belongs in the specs. It says each
thing once — a *skill* that repeats itself is one an agent can follow two ways.
