# Terms

The vocabulary of the specs. Terms are defined here; other specs use them
without redefining them.

- *Vault* — a set of collections. What Autofile keeps things in, and what a
  program serves.
- *Collection* — a named group in a vault, holding records or blobs.
- *Key* — what names a record or blob within its collection.
- *Identity* — a collection and a key, joined by a slash.
- *Record* — a thing a vault holds, having an identity and fields.
- *Fields* — a record's data.
- *Blob* — bytes a vault holds, having an identity and content but no fields.
- *Reference* — a field value that points at an identity.
- *Config* — in a markdown vault, the `autofile.yml` its collections are read
  from.
- *Header* — in a markdown vault, the YAML frontmatter carrying a record's
  fields.
- *Body* — in a markdown vault, the field holding what sits below the header.
- *Finding* — in a markdown vault, something `validate` reports.
- *Violation* — a finding that makes the vault invalid.
- *Warning* — a finding that is legal but usually a mistake, and does not.
- *Back pressure* — what implementation teaches about a spec that is wrong or
  vague, carried back into the spec rather than worked around in code.
- *Skill* — the instruction set an agent follows to use a vault.
