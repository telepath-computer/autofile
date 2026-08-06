# Markdown vault

A *vault* kept as a folder of markdown files. It holds the *collections*
described by [the vault spec](vault.md); this says how they are stored, and how
the folder is served as [an Autofile vault](http-api.md).

The folder and the API are two ends of one contract. Obsidian, Dropbox and
`git diff` see the folder; everything else sees the API; and the program in the
middle is what makes them the same *vault*.

## Config

A `MarkdownVault` reads its *collections* from an `autofile.yml` at the
folder's root.

Under `collections`, keyed by name, each is declared with the fields
[the model](vault.md) gives it and one this *vault* adds:

- `body` — `false` forbids a *body* on *records* here. A *body* is allowed by
  default. This one is not served: a *record* in such a *collection* simply has
  no `body`, which is all a consumer needs to see.

Unknown keys are rejected, in the *config* and in a *collection* both. So are
two *collections* whose names differ only by case, since their folders would be
one. An `autofile.yml` that cannot be read, does not parse, or does not match
this makes the *vault* unopenable.

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

A *key* becomes a path here, so this *vault* rejects any whose segments are not
names a file can have: an empty segment, `.`, or `..`. Each would resolve to
something another *key* already names, or to something outside the *vault*.

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

`put` creates whatever folders a *key* implies.

`remove` errors when nothing is at the *identity*, rather than answering
differently from `get` about the same absence. It deletes the file and then any
parent folder it leaves empty, stopping at a *collection*'s own folder
and at the *vault* root — both mean something, and an empty one is a *vault*
that has changed shape rather than one that has been tidied.

A *blob* is written as its bytes. Its `content.type` is not stored, since the
media type is the extension's to say.

## Findings

`validate` answers with *findings* rather than a verdict. A *violation* makes
the *vault* invalid; a *warning* is legal and usually a mistake, and does not.

```ts
interface Finding {
  /** What was broken. */
  rule: string;
  severity: 'violation' | 'warning';
  /** The identity at fault, where there is one. */
  id?: string;
  /** The collection at fault, where the finding is about one. */
  collection?: string;
  message: string;
}
```

None of this reaches the API. A *vault* kept some other way would have its own
list, most of which could not go wrong there at all.

- `schema` — a *record*'s *fields* fail its *collection*'s `schema`.
- `body` — the *record* has a *body* where its *collection* sets `body: false`.
- `parse` — the *record* cannot be read, or its YAML *header* does not parse.
- `config` — `autofile.yml` cannot be read, does not parse, or is not a valid
  *config*. This one concerns the *vault*'s own file, so it names neither a
  *record* nor a *collection*.
- `key` — a *key* has a segment that is empty, `.` or `..`, is not in Unicode
  NFC, holds a control character, or is too long for the filesystem.
- `collision` — two *identities* whose files differ only by case, which a
  filesystem that does not tell them apart holds as one. Checked over the whole
  *vault* rather than within a *collection*, since *records* and *blobs* share
  one tree and a *record*'s file can collide with a *blob*'s.

All of those are *violations*. One *warning*:

- `empty` — a declared *collection* with nothing in it: missing, or not a
  folder. Legitimate when a *collection* is declared before anything is filed
  into it, and indistinguishable from a mistyped name otherwise.

## Interface

The types below are this *vault*'s own. What a *record* or a *blob* looks like
to a consumer is [the API](http-api.md)'s to say; these are the shapes the
program holds in memory between the folder and the wire.

```ts
class MarkdownVault {
  /** Opens the vault rooted at `root`. */
  static open(root: string): Promise<MarkdownVault>;

  readonly root: string;
  readonly collections: { [name: string]: Collection };

  get(id: string): Promise<Record | Blob | null>;
  list(collection: string): Promise<(Record | Blob)[]>;
  put(id: string, content: Fields | globalThis.Blob): Promise<Record | Blob>;
  remove(id: string): Promise<void>;

  validate(): Promise<Finding[]>;
}

interface Record {
  type: 'record';
  id: string;
  fields: Fields;
  created: Date;
  updated: Date;
}

interface Blob {
  type: 'blob';
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

## Serving

`autofile-md serve` opens the folder and answers [the HTTP
API](http-api.md) for it, holding it open across requests.

```
autofile-md serve --host 127.0.0.1 --port 8787
```

Both are settable and those are the defaults. Binding wide is typed rather than
assumed: there is no authentication, so `--host 0.0.0.0` makes the *vault*
readable and writable by everything that can reach the machine, and that should
be the moment someone notices it.

Every response carries `Access-Control-Allow-Origin: *`, and `OPTIONS` answers
the preflight, because the point of serving JSON is a web app and it will be on
another origin. With no authentication that means any page a browser has open
can read and write the *vault* — a loopback bind does not prevent it, since
`127.0.0.1` is reachable from whatever the browser is displaying. That is a
choice this server makes rather than something the API asks for.

`autofile-md validate` reports the *findings* above. It is a command about
a folder rather than about a *vault*, which is why it is here and not in the API.

A *violation* names the *identity*, what is wrong with it, and the *collection*
that governs it. A *warning* is labelled and names the *collection* in the
*identity*'s place. One *finding* to a line, *violations* before *warnings*, in
a deterministic order, so two runs over an unchanged folder print the same
thing.

```
contacts/priya-narayan — /name: must be string   (contacts)
```

It exits zero when the *vault* is valid and non-zero when it is not. *Warnings*
do not change the exit code — a *warning* that fails a build is not a *warning*.
A valid *vault* still prints a line naming what was checked, so a run that found
nothing is distinguishable from one that found everything in order.
