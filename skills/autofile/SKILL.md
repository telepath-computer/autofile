---
name: autofile
description: Predictable filing for agents. Use when filing information that should outlive the current task, retrieving what was filed before, or creating a vault.
---

# Autofile

- A vault is a folder that Autofile is authoritative over, holding records as
  markdown files.
- Reach for it whenever information turns up that should be durable — meaning
  it should outlive the current task. Filing is proactive, not only on request.
- Reach for it again when a question could be answered by what was filed
  before.

## Before filing

- Read the vault's `autofile.yml` before writing anything, unless it is already
  in context. Its `description` fields are filing instructions, not
  documentation: they say what belongs at each path and how to file there.
- The paths it lists are the whole of what Autofile is authoritative over.
  Nothing outside them is a record.
- If the destination or meaning is unclear, ask, or leave a task to ask. Do not
  guess.

## Filing

- Search for existing records on the same subject, and on related ones, and
  read them before writing.
- Prefer updating an existing record over creating a second one about the same
  thing.
- One input often touches several records. A note that someone has moved is
  both its own record and an edit to that person's. File both.
- Write for retrieval: concise, information-dense, and structured so the next
  search finds it.
- Do not add commentary, speculation, or invented detail. Later reads treat the
  vault as true.

## Records

- A record is a markdown file: an optional YAML header for structured data,
  opened and closed by a `---` line, and an optional body after it.
- The path entry governing a record may constrain its header, its filename, and
  whether it may have a body. Follow what `autofile.yml` says for that path.
- A record's identity is its path from the vault root without the `.md`
  extension.

## References

- Reference another record by its identity in double brackets:
  `[[contacts/priya-narayan]]`.
- Reference a file the vault holds the same way, extension included:
  `[[assets/guide.pdf]]`.
- In YAML, quote a reference. Unquoted, `[[contacts/priya-narayan]]` is a
  nested array.
- Referencing a record that does not exist yet is allowed; it marks something
  worth filing later.

## Retrieval

- Read `autofile.yml` first to learn which paths hold what.
- Then choose by the question: the path for a kind of thing, the filename for
  something dated or named, a property for a known value, a reference for
  what connects, and search for everything else.

## Creating a vault

- A vault is created by writing an `autofile.yml` at the root of a folder.
- Decide its paths with the user rather than designing them alone: the paths
  and their descriptions are what every later filing decision rests on.
- Confirm it with `autofile validate`.

## Validating

- Run `autofile validate` from the vault after changing records or the config.
- Fix what it reports. A violation means the vault is invalid; a warning does
  not, but usually means something was misfiled.
