# Skill

The skill is the instruction set an agent follows to use a vault. It lives
at `skills/autofile/SKILL.md`, where `npx skills add` reads it. It derives
from the spec: it may restate the rules an agent needs in hand, but where
the two disagree, the spec wins and the skill has the bug.

It is written terse and imperative, addressed to an agent, each rule stated
once. It says what to do; why the system is shaped this way belongs here.

## What it must cover

- When to reach for a vault: whenever information turns up that should
  outlive the current task or might be needed for retrieval later. Filing
  is proactive, not only on request.
- That a config may govern only part of a vault. Paths it does not declare
  are not the agent's to file into.
- Creating a vault with `autofile init`, and that its paths are then
  decided with the user by editing `autofile.yml` together.
- How internal links are written: the path to the note without the `.md`
  extension, quoted in YAML. A bare name resolves but may match more than
  one note, so an agent writes enough path to be unambiguous. Linking a
  note that does not exist yet is allowed.
- That findings in notes the agent did not touch are the user's to triage,
  not the agent's to silently rewrite.
- No speculation and no invented content.

## Sequences

The skill gives filing and retrieval as numbered steps, states ahead of
both that the config is read first unless already in context, and makes
plain that every step is mandatory.

Filing:

1. Identify the durable information in the input; all of it gets
   preserved.
2. Search for existing notes on the same subject and related ones; read
   them before writing.
3. Choose paths: the most specific description that fits, the broadest only
   when nothing narrower does. When nothing fits, ask.
4. Write: a new note, an update to existing notes, or both — one input may
   touch several. Link related notes; file other files at their described
   paths.
5. Run `autofile check` and fix what it reports.

Retrieval:

1. Choose the strategy by the question: the path for a kind of thing, the
   filename for something named or dated, a field for a known value, links
   for what connects, and search for the rest.
2. Read the notes found and follow their links onward.
