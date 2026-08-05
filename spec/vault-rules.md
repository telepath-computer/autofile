# Vault rules

A *vault* is a single folder that adheres to these rules. Contents that break
them make it an invalid *vault*.

## `autofile.yml`

A *vault* must have an `autofile.yml` at its root. The *config* defines what
Autofile is authoritative over: the *paths* it lists are the *vault* as far as
Autofile is concerned, and anything else in the folder is left alone.

- `title` — optional. A human-readable name for the *vault*.
- `description` — what the *vault* is for, and what belongs in it rather than in
  another *vault*.
- `paths` — the *paths* within the *vault* and the rules for each. Keys are
  literal paths written from the *vault* root — `/contacts` — with no globbing
  or patterns.

Each entry under `paths` takes:

- `title` — optional. A human-readable name for the *path*.
- `description` — what it contains and how to file into it.
- `schema` — optional. JSON Schema for the *header* of *records* at that *path*.
- `filename` — optional. JSON Schema for a *record*'s filename at that *path*,
  without its extension.
- `body` — optional. `false` forbids a *body* on *records* at this *path*. A
  *body* is allowed by default.

Schemas are JSON Schema 2020-12. A *record* must satisfy its *path*'s `schema`,
`format` included — a property declared `format: date` must hold a date.

The *config* itself is described by
[`autofile.schema.json`](autofile.schema.json).

An entry's rules apply to the `.md` files directly at its *path*, and to
nothing else — not to other files there, and not to folders beneath it, which
need entries of their own.

```yaml
description: |
  Personal vault: people, places, events, and sources worth keeping.

paths:
  /contacts:
    description: |
      People and organizations. One record per person or organization.
    schema:
      required: [name, type]
      properties:
        name: { type: string }
        type: { enum: [person, organization] }
    filename: { pattern: "^[a-z0-9-]+$" }
    body: false

  /events:
    description: |
      Dated records of things that happened: meetings, calls, visits.
    schema:
      required: [title, date]
      properties:
        title: { type: string }
        date: { type: string, format: date }
    filename: { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$" }
```

## Records

A *record* is a markdown file with two optional parts: a YAML *header* for
structured data, and the *body*, which is everything after it. Whitespace alone
is not a *body*.

A `.md` file is a *record* if and only if its folder is listed in `paths`. A
markdown file deeper in the tree is not a *record* until its own folder is
listed.

## Static files

A *vault* may hold *static files* — images, PDFs, videos, archives. Anything in
a listed *path* can be referenced and retrieved by its *identity*.

## Referencing

A *record*'s *identity* is its path from the *vault* root, without the `.md`
extension. The file `contacts/priya-narayan.md` is the *record*
`contacts/priya-narayan`.

A *static file*'s *identity* is its path from the *vault* root, extension
included: `assets/risograph-guide.html`.

A *reference* is an *identity* in double brackets — `[[contacts/priya-narayan]]`,
`[[assets/risograph-guide.html]]`. *References* may appear in property values
and in the *body*, and each value declares itself, so a property can hold a
*reference* alongside a plain string.

In YAML a *reference* must be quoted. Unquoted, `[[contacts/priya-narayan]]` is
a nested array.
