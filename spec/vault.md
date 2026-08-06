# Vault

A *vault* is a set of *collections*.

## Collections

A *collection* is a named group holding *records* or *blobs*. It declares:

- A name, which identifies it and is the first segment of every *identity* in
  it. Non-empty, and containing no `/`.
- A type, either `record` or `blob`. The only one that must be given.
- A human-readable title.
- A description of what belongs here rather than in another *collection*, which
  is a filing instruction rather than documentation.
- A schema, for a record *collection*, that its *records* must satisfy. JSON
  Schema 2020-12.

`format` is included in that: a property declared `format: date` must hold a
date. A *record* with no *fields* is checked as having none.

A schema that is not usable as one is refused. A misspelled keyword is legal
JSON Schema, and a rule that never runs looks exactly like one every *record*
passes.

## Records and blobs

A *record* is structured data: named *fields*, holding whatever its
*collection*'s `schema` allows.

A *blob* is bytes — an image, a PDF, a video, an archive. A *collection* holds
one kind or the other: a `schema` has nothing to say about bytes.

Both carry when they were created and when they last changed.

## Identity

Everything in a *vault* has an *identity*: a *collection* and a *key*, joined by
a slash.

```
contacts/priya-narayan
blobs/assets/site/index.html
```

The *collection* is everything before the first `/`; the *key* is everything
after it, and is a non-empty string. So `people/family/priya-narayan` is the
*key* `family/priya-narayan` in the `people` *collection*, and a *collection* on
its own is not an *identity*.

A *key* is a string rather than a path. Slashes in one are a convention that
*vaults* storing *keys* as file paths give meaning to, and what such a *vault*
will not accept is its own to say.

An *identity* has one spelling, and it is the one given: nothing folds its case,
trims it, or normalises its characters. A *vault* that cannot tell two apart
refuses the second rather than quietly answering with the first.

## References

A *reference* is a *field* value pointing at an *identity*: an object whose only
key is `$ref`, holding that *identity*. An object carrying anything alongside
`$ref` is not a *reference* but ordinary data, since a form that dropped what it
could not represent would lose it silently.

```json
"related":    [{ "$ref": "events/2026-06-02-zine-paper-chat" }],
"photo":      { "$ref": "blobs/contacts/priya-narayan.jpg" },
"filed_from": "contacts/priya-narayan"
```

`related` and `photo` are *references*. `filed_from` is a string.

A *reference* may appear at any depth in a *field*'s value.
