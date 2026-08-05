# Skill

The *skill* is the instruction set an agent follows to use a *vault* — how to
file into one, retrieve from one, and create one. It lives at
`skills/autofile/SKILL.md`.

## Authority

The *skill* derives from the [vault rules](vault-rules.md) and does not restate
them. Where it needs a rule it refers to the rules; where the two disagree the
rules win and the *skill* has the bug. Restating invites drift, and a drifted
*skill* is worse than a silent one, because an agent follows it without checking.

## Required coverage

- When to reach for a *vault*: whenever information is encountered that should be
  durable, meaning it should outlive the current task. Filing is proactive
  rather than only on request.
- Finding the *vault*. The *skill* addresses a single *vault*, which the agent is
  assumed to know how to reach. Choosing between several is not covered.
- Reading `autofile.yml` before acting. Its descriptions are filing
  instructions rather than documentation, and this is the step most often
  skipped.
- Creating a *vault* by writing an `autofile.yml`, and confirming it with
  `autofile validate`. Its structure is decided with the user rather than
  designed by the agent alone.
- Filing: search for existing *records* first and prefer updating one over
  creating a duplicate. Fan out when one input touches several *records*.
- Writing a *record*: *header* and *body*, conforming to the *path*'s
  `schema`, `filename` and `body`.
- Referencing *records* and *static files*.
- Retrieval: by *path*, by property, by *reference*, and by search.
- Validating after a change.
- What not to do: no speculation, no invented content, and asking rather than
  guessing when the destination is unclear.

## How it is written

Terse and imperative, addressed to an agent rather than a reader. It says what
to do; why the system is shaped this way belongs in the specs.
