# Typed record vault

A proposal, not the shipped contract. Written 2026-07 and superseded in its
specifics — the vault declares folders rather than collections, records are
markdown, and links follow the vault's link format — but retained for the
question it poses and does not settle: where a record's files live, and how a
record refers to them.

Autofile currently aims to work with existing Obsidian vaults by governing
Markdown files, frontmatter, folders, and native links. That format supports
adoption now, but it should not determine Autofile's long-term structure.

This proposal describes an intended direction: Autofile storing typed
records in collections and exposing them through vaultserver. Two storage
layouts remain under consideration: record packages with adjacent assets, and
named record files referring to a vault-level blob store. This proposal does
not yet select either layout for implementation.

## Vault structure

An `autofile.yml` defines the vault's collections. Each collection also defines
the type of record it contains. Collection names are local to the vault and
need no namespace.

```yaml
collections:
  contacts:
    description: A person or organization.
    path: /contacts
    schema:
      type: object
      required: [name]
      properties:
        name:
          type: string
        email:
          type: string

  documents:
    description: A document and the files that comprise it.
    path: /documents
    schema:
      type: object
      required: [title]
      properties:
        title:
          type: string

  datasets:
    description: Structured information without a dedicated type.
    path: /datasets
    schema:
      type: object
      required: [title, data]
      properties:
        title:
          type: string
        data: {}
```

A collection defines its records' meaning and value shape and stores them at a
declared path. The collection name is also the record type. A record in
`contacts` is therefore a contact record.

The collection name and record key form the API identity. The path determines
where the collection is stored. Applications should address records through
their collection and key rather than depend on the physical path.

People may extend a vault by adding local collections. Changing the vault
structure is an explicit configuration change; agents must not create a
collection without authority.

## Storage alternatives

The logical record model permits two storage models. They differ in where
assets live and how records refer to them.

### Alternative A: record packages

Each record is a directory named by its key. Its structured value is stored as
`index.json`; files owned by the record sit beside it.

```text
contacts/
  alice/
    index.json
    portrait.jpg
  bob/
    index.json
```

The record value is JSON-compatible. A package may also contain Markdown when
prose is better stored as a separate document.

Both records and assets are resources within the same hierarchy. Structured
values use an explicit reference object so Autofile can find and validate
dependencies without relying on field schemas or interpreting arbitrary
strings:

```json
{
  "name": "Alice",
  "portrait": {
    "$type": "ref",
    "uri": "./portrait.jpg"
  },
  "manager": {
    "$type": "ref",
    "uri": "../bob"
  }
}
```

The target determines what the reference resolves to. `./portrait.jpg` is a
file; `../bob` is a record. One reference form covers both.

Vaultserver exposes the package hierarchy directly:

```text
/contacts/alice               record JSON
/contacts/alice/portrait.jpg  image bytes
/contacts/bob                 record JSON
```

Grouping a record with its files gives those files a clear owner. The complete
record can be moved, exported, or deleted as one directory, and references
within the package remain valid. References from other records must be checked
or rewritten when the package moves.

### Alternative B: named records and vault-level blobs

Each record is one file named by its key. Binary content lives in one
content-addressed blob store for the vault.

```text
vault/
  autofile.yml
  blobs/
    bafkreibjfgx2gpr...
  contacts/
    alice.json
    bob.json
  documents/
    printer-manual.json
```

The record files may use JSON or YAML while representing the same
JSON-compatible values. JSON corresponds directly to the API value; YAML is
more convenient for multiline text. Serialization is separate from the
collection and blob model.

Record references use an explicit reference value based on collection and key:

```json
{
  "name": "Alice",
  "manager": {
    "$type": "ref",
    "uri": "contacts/bob"
  }
}
```

Blob references use a separate tagged value:

```json
{
  "title": "Printer manual",
  "file": {
    "$type": "blob",
    "uri": "blobs/bafkreibjfgx2gpr..."
  }
}
```

The distinction is intentional. A record reference identifies a mutable
logical record. A blob reference identifies bytes in the vault's blob store.
Vaultserver resolves the URI and supplies the media type and size when serving
the bytes; the record does not duplicate that derived metadata.

This representation takes inspiration from AT Protocol's distinction between
records and blobs but does not reproduce its wire format. An integration can
translate an Autofile blob into an AT blob by resolving it and producing the
required CID, MIME type, and size.

Autofile can find every dependency by traversing the record value. Moving or
exporting a record copies its record file and referenced blobs into the
destination vault. The same blob may be referenced by several records, and a
blob can be removed only when no record in the vault references it.

### Shared material

Under either model, information with independent identity or several consumers
should have its own record. A printer manual used by several records is a
`documents` record. Consumers link to that record rather than treating its PDF
as an anonymous shared asset.

### Rendering links

A reference identifies a resource but does not prescribe its presentation.
A consumer resolves the reference and uses the target record's collection to
select a renderer. The same record may be shown as a page, card, table row,
editor, or inline preview.

Links inside Markdown remain Markdown links because they are part of Markdown
syntax. Autofile may normalize them to the same internal reference model when
parsing the document.

## Datasets

`datasets` is the general collection for durable structured information that
does not belong to a more specific collection. Its `data` field may contain any
JSON-compatible value; it need not be an array or table and does not require
its own schema.

```json
{
  "title": "Launch readiness",
  "data": {
    "score": 0.8,
    "risks": ["Support coverage"]
  }
}
```

If several records begin to share stable meaning and consumers depend on their
shape, that information should be promoted to a named collection.

## Views

A view describes how a consumer presents or queries records. It does not own a
second copy of the domain data it displays. A checklist backed by task records
is therefore a view over those records. A standalone checklist that has no
dedicated collection may be stored as a dataset.

Artifact is a presentation term for something a consumer renders, not a
record type or storage boundary.

## Validation and agent behavior

Autofile validates each record against its collection schema. It also checks
the selected storage layout and traverses explicit references to validate their
targets and collect the record's dependencies.

Before writing, an agent must read `autofile.yml` and relevant existing
records. It must use an existing collection where one fits, must not invent
missing information, and must run `autofile check` after every change. Creating
or changing collections requires explicit authority.
