# Skill

The skill is the instruction set an agent follows to use a vault. It lives
at `skills/autofile/SKILL.md`, where `npx skills add` reads it. It derives
from the spec: it may restate the rules an agent needs in hand, but where
the two disagree, the spec wins and the skill has the bug.

It is written terse and imperative, addressed to an agent, each rule stated
once. It says what to do; why the system is shaped this way belongs here.

## What it must cover

- When to file: whenever information turns up that should outlive the
  current task or might be needed for retrieval later. Filing is
  proactive, not only on request.
- That the config states what is governed, and is read before acting:
  each folder entry's description is a filing instruction. Notes and
  files go into declared folders per those descriptions; a path no entry
  covers is not the agent's to file into — when nothing fits, ask, and
  declare a folder with the user rather than inventing one.
- Creating a vault with `autofile init`, and that its folders are then
  declared with the user by editing `autofile.yml` together.
- That `autofile serve` puts the vault behind an HTTP API — for building
  an application over it, not for filing, which stays ordinary file
  writes. vault-server defines the protocol and ships a separate skill
  for it.
- Conforming to the config: the conventions in force — `link_format`,
  `filename_pattern`, an entry's `extensions`, `schema`, and the rest —
  are read from `autofile.yml` and followed as written, not recalled
  from memory. One practice on top of conformance: write references
  with full vault paths, since a bare name matches any note with that
  name, so filing a second one changes which note the link reaches
  without changing the link; and referencing a note that does not exist yet is
  allowed — it marks something to file later.
- That findings in notes the agent did not touch are the user's to
  triage, not the agent's to silently rewrite.
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
3. Choose the destination: the folder entry whose description fits
   most specifically, the broadest only when nothing narrower does.
   When nothing fits, ask.
4. Write: a new note, an update to existing notes, or both — one
   input may touch several. Reference related notes; file other files
   where their folder's description says.
5. Run `autofile check` and resolve what it reports, asking the user
   where a fix needs information the agent does not have.

Retrieval:

1. Choose the strategy by the question: the folder for a kind of
   thing, the filename for something named or dated, a field for a
   known value, references for what connects, and search for the rest.
2. Read the notes found and follow their references onward.
