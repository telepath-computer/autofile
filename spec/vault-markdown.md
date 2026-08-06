# Markdown vault

A *vault* kept as a folder of markdown files, implemented by `MarkdownVault`.
It holds the *collections* described by [the vault spec](vault.md); this says
how they are stored.

Files and folders whose name begins with `.` are ignored.

## Config

A `MarkdownVault` reads its *collections* from an `autofile.yml` at the
folder's root.

```ts
interface Config {
  /** The vault's collections, by name. */
  collections?: { [name: string]: Collection };
}

interface Collection {
  /** What the collection holds. */
  type: 'record' | 'blob';
  /** A human-readable name for the collection. */
  title?: string;
  /** What it contains and how to file into it. */
  description?: string;
  /** JSON Schema for the fields of records here. Record collections only. */
  schema?: object;
  /** false forbids a body on records here. A body is allowed by default. */
  body?: boolean;
}
```

Unknown keys are rejected, in the *config* and in a *collection* both. An
`autofile.yml` that cannot be read, does not parse, or does not match this
makes the *vault* unopenable.

```yaml
collections:
  contacts:
    type: record
    description: |
      People and organizations. One record per person or organization.
    schema:
      required: [name, type]
      properties:
        name: { type: string }
        type: { enum: [person, organization] }
    body: false

  events:
    type: record
    description: |
      Dated records of things that happened: meetings, calls, visits.
    schema:
      required: [title, date]
      properties:
        title: { type: string }
        date: { type: string, format: date }

  blobs:
    type: blob
    description: |
      Everything that is not a record: scans, images, downloaded documents.
```

## Collections

A record *collection* is a folder at the *vault* root, named for the
*collection*. The blob *collection* is not a folder of its own; its *keys* are
paths from the root.

Every file in the *vault* has one role. A `.md` file in a record *collection*
is a *record*; every other file is a *blob*.

A *vault* declares at most one blob *collection*, since two would claim the
same *keys* with no rule for which wins.

## Records

A record *collection*'s folder holds `.md` files. A *record*'s *key* is its
path below that folder without the `.md` extension, so
`contacts/family/priya-narayan.md` is the *key* `family/priya-narayan` in the
`contacts` *collection*.

## Fields

A *record*'s YAML *header* carries its *fields*, opened and closed by a `---`
line at the start of the file. The region below the *header* is one more of
them, named `body` — it has to be called something, and every *field* reaching
a consumer needs a name.

Both parts are optional. A *record* with nothing below the *header* has no
`body`, and whitespace alone is nothing. A *record* with no *header* has only a
`body`, or no *fields* at all.

## Blobs

A *blob*'s *key* is its path from the *vault* root, extension included, so the
file `contacts/priya-narayan.jpg` is `blobs/contacts/priya-narayan.jpg` and
`site/index.html` is `blobs/site/index.html`. A *blob* can sit anywhere,
including beside the *records* that reference it.

A *blob*'s media type is derived from its extension, because a folder of files
has nowhere to record one.

## Timestamps

A *record*'s or *blob*'s `created` is its file's ctime and `updated` is its
mtime. Neither survives a copy, a fresh clone, or every sync client, and the
alternative — writing them into the *header* — would put bookkeeping into files
people edit.

## References

`[[…]]` is this *vault*'s spelling of a *reference*. A *field* whose value is a
wikilink is a *reference* to the *identity* inside it: `[[contacts/priya-narayan]]`
becomes `{ "$ref": "contacts/priya-narayan" }`.

Only a whole value converts. A wikilink inside prose is part of that prose —
`body` is markdown, and its links are markdown's.

In YAML a wikilink must be quoted. Unquoted, `[[contacts/priya-narayan]]` is a
nested array.

Conversion runs at any depth in a value, so a list of wikilinks becomes a list
of *references*.

## Writing

`put` writes a *record*'s `body` *field* as the region below the *header* and
every other *field* as a *header* key. A *record* whose only *field* is `body`
is written with no *header*; one with no `body` *field* gets nothing below it.
*References* go back as quoted wikilinks, at any depth.

The *header* is written from the *fields* rather than merged into what was
there, so comments do not survive a write. What does survive is order: reading
keeps the *header*'s key order, so a *record* fetched, changed and written back
comes out in the order it went in.

`put` creates whatever folders a *key* implies. `remove` deletes the file and
then any parent folder it leaves empty, stopping at a *collection*'s own folder
and at the *vault* root — both mean something, and an empty one is a *vault*
that has changed shape rather than one that has been tidied.

A *blob* is written as its bytes. Its `content.type` is not stored, since the
media type is the extension's to say.

## Interface

```ts
class MarkdownVault implements Vault {
  /** Opens the vault rooted at `root`. */
  static open(root: string): Promise<MarkdownVault>;

  readonly root: string;
  readonly collections: { [name: string]: Collection };

  get(id: string): Promise<Record | Blob | null>;
  list(collection: string): Promise<(Record | Blob)[]>;
  put(id: string, content: Fields | globalThis.Blob): Promise<Record | Blob>;
  remove(id: string): Promise<void>;
}
```

`open` reads the `autofile.yml`, checks it, and compiles each *collection*'s
`schema`. A missing file, malformed YAML, an unknown key, a `schema` that is
not usable as one, or a second blob *collection* all fail here rather than on
first use, so a *vault* that opens has *collections* that answer without
reading anything further.

A *vault* is its *config* as it was read. An `autofile.yml` edited underneath an
open *vault* takes effect on the next `open`, which matters for a server holding
one across requests.

A *record* whose file cannot be read, or whose *header* does not parse, is an
error from `get` and from `list`. `null` means the *collection* holds no such
*key*, which a file that is there but broken is not.

