# Terms

The vocabulary of the specs. Terms are defined here; other specs use them
without redefining them.

- *Vault* — a single folder that adheres to the vault rules.
- *Config* — `autofile.yml`, at the vault root, declaring what Autofile is
  authoritative over.
- *Path* — a location the config lists, together with the rules for the records
  there.
- *Record* — a markdown file in a listed path.
- *Header* — a record's YAML frontmatter, carrying its structured data.
- *Body* — everything in a record after its header.
- *Identity* — what names a record or a file within the vault: a record's path
  without its `.md`, a file's path with its extension.
- *Reference* — an identity in double brackets.
- *Static file* — a file the vault holds that is not a record.
- *Violation* — something that breaks a vault rule, reported by `validate` and
  making the vault invalid.
- *Warning* — something legal but usually a mistake, reported by `validate`
  without making the vault invalid.
- *Skill* — the instruction set an agent follows to use a vault.
