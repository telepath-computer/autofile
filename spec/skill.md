# Skill

The skill is the instruction set an agent follows to use a vault. It lives at
`skills/autofile/SKILL.md`, where `npx skills add` reads it. It derives from
the spec: it may restate the rules an agent needs in hand, but where the two
disagree, the spec wins and the skill has the bug.

## General rules

It must cover:

- When to reach for a vault: whenever information turns up that should
  outlive the current task or might be needed for retrieval later. Filing is
  proactive, not only on request, and preserves all durable information —
  dropping it is the failure mode the vault exists to prevent.
- Reading `autofile.yml` before acting — descriptions are filing
  instructions.
- Creating a vault with `autofile init`, deciding its paths with the user
  rather than alone.
- How references are written: the full vault-relative path, records
  without the `.md` extension, quoted in YAML. Bare slugs never resolve;
  referencing a record that does not exist yet is allowed.
- That running `autofile check` after any change is a must, not a
  suggestion, and that a violation means the vault is broken rather than
  untidy.
- What not to do: no speculation, no invented content; ask rather than guess
  when the destination is unclear.

## Sequences

The skill specifies the two interactions as sequences, each with its own
steps. It must state, ahead of both sequences and on its own line: before
either, read the config, unless it is already in context. It must also
make plain that every step is mandatory — a sequence is followed in full,
not sampled.

Filing:

1. Identify the durable information in the input — everything that
   outlives the current task or might be needed for retrieval later gets
   preserved.
2. Search for existing records on the same subject and related ones; read
   them before writing.
3. Choose paths: the most specific description that fits; the broadest
   only when nothing narrower does.
4. Write: a new record, an update to existing records, or both — one input
   may touch several. Reference related records; file non-record files at
   their described paths.
5. Run `autofile check` and fix what it reports. Never skip this step.

Retrieval:

1. Choose the strategy by the question: the path for a kind of thing, the
   filename for something named or dated, a field for a known value,
   references for what connects, and search for the rest.
2. Read the records found and follow their references onward.
