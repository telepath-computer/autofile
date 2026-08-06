# Vault

A *vault* is a set of *collections*. Contents that break these rules make it an
invalid *vault*.

## Collections

A *collection* is a named group holding *records* or *blobs*. It gathers what is
filed the same way: one `schema`, and one account of what belongs there rather
than somewhere else.

A *collection*'s name contains no `/`, and does not begin with `.`.

A *collection* may declare a `schema` for the *fields* of its *records*. It is
JSON Schema 2020-12, `format` included — a property declared `format: date`
must hold a date. A *record* with no *fields* is checked as having none.

A `schema` that is not usable as a schema makes the *vault* invalid, rather
than a *collection* whose rules silently never apply. A misspelled keyword
counts: it is legal JSON Schema, and it is a rule that would never fire.

## Records

A *record* has an *identity* and *fields*. *Fields* are its data — names to
values, with no shape imposed beyond its *collection*'s `schema`.

## Blobs

A *blob* is bytes the *vault* holds: an image, a PDF, a video, an archive. It
has an *identity* and content, and no *fields* — nothing about it is structured,
which is why a *collection* holds one kind or the other rather than both.

## Identity

An *identity* is a *collection* and a *key*, joined by a slash.

```
contacts/priya-narayan
blobs/assets/site/index.html
```

The first segment is the *collection*; everything after it is the *key*. A
*key* may itself contain slashes, so `people/family/priya-narayan` is the key
`family/priya-narayan` in the `people` *collection*.

An *identity* has one spelling: no leading `/`, and no `.` or `..` segments.

## References

A *reference* is a *field* value pointing at an *identity*.

```ts
interface Reference {
  $ref: string;
}
```

```json
"related":    [{ "$ref": "events/2026-06-02-zine-paper-chat" }],
"photo":      { "$ref": "blobs/contacts/priya-narayan.jpg" },
"filed_from": "contacts/priya-narayan"
```

`related` and `photo` are *references*. `filed_from` is a string.

A *reference* may appear at any depth in a *field*'s value, as `related` shows.

## Interface

```ts
interface Vault {
  /** The vault's collections, by name. */
  collections: { [name: string]: Collection };

  /** The record or blob at an identity, or null if its collection has no such key. */
  get(id: string): Promise<Record | Blob | null>;
  /** A collection's items, ordered bytewise by key. */
  list(collection: string): Promise<(Record | Blob)[]>;
  /** Creates or replaces a record or blob. */
  put(id: string, content: Fields | globalThis.Blob): Promise<Record | Blob>;
  remove(id: string): Promise<void>;
}

interface Collection {
  /** What the collection holds. */
  type: 'record' | 'blob';
  name: string;
  /** A human-readable name for the collection. */
  title?: string;
  /** What it contains and how to file into it. */
  description?: string;
  /** JSON Schema for the fields of records here. Record collections only. */
  schema?: object;
}

interface Record {
  type: 'record';
  /** The record's identity. */
  id: string;
  fields: Fields;
  created: Date;
  updated: Date;
}

interface Blob {
  type: 'blob';
  /** The blob's identity. */
  id: string;
  created: Date;
  updated: Date;
  /** The bytes: `size`, `type` for the media type, `stream()`, `arrayBuffer()`. */
  content: globalThis.Blob;
}

interface Fields {
  [name: string]: unknown;
}
```

## Errors

Naming a *collection* the *vault* does not declare is an error from every
operation. It is a different thing from an absent *record*, and reporting both
as absence would make a misspelled *collection* look like ordinary emptiness.

With that separated, absence is unambiguous: `get` answers `null` when the
*collection* is real and holds no such *key*, and `list` answers `[]` when the
*collection* is real and empty.

`put` validates a *record*'s *fields* against its *collection*'s `schema` and
rejects one that fails, by the same check `validate` runs — a *vault* can still
come to hold *records* the API would have refused, since a *vault* may be
written to directly, but nothing gets in that way through here. It is also an
error to `put` the wrong kind of content for a *collection*, or to name an
*identity* that is not spelled as one.

`remove` is an error when there is nothing at the *identity*.

Errors are distinguishable without reading their messages. A consumer maps them
onto its own vocabulary — an HTTP status, an exit code — and each of these is a
different answer.
