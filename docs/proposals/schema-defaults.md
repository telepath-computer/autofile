# Schema defaults and extension

Deferred design. Not in `spec/vault-rules.md`, which currently puts `filename`
on each path entry and shares nothing between them.

## The problem

Every path entry states its own rules. Two kinds of rule are the same across
most of a vault: a naming convention ("filenames are snake_case") and
properties every record carries ("everything has a `created` date"). Repeating
those in each entry is the duplication that `.fslint.yml` had, where every
scope re-included a `<<: *global_properties` anchor.

## `defaults`

A top-level key holding entry fields. Every path extends it unless it says
otherwise.

```yaml
defaults:
  filename: { pattern: "^[a-z0-9_]+$" }
  schema:
    required: [created]
    properties:
      created: { type: string, format: date }

paths:
  /contacts:
    schema:
      required: [name]
      properties:
        name: { type: string }
```

Fields compose in two different ways, and the difference matters:

- `filename` and `body` are **replaced wholesale**. A path that sets one loses
  the default entirely.
- `schema` **composes** — a path's effective schema is
  `allOf: [defaults.schema, path.schema]`. A record must satisfy both, so
  `/contacts` above requires `created` and `name`.

Composing via `allOf` means nothing has to be merged by hand: no unioning of
`properties`, no concatenating `required`, no conflict rules. A standard
validator does the work.

## Opting out

`extends: null` on a path takes the defaults away. `extends: <name>` inherits
from a named block instead, which needs somewhere to define named blocks —
unresolved, and not worth resolving until something needs it.

## The strictness trap

`allOf` and `additionalProperties: false` interact badly. Each subschema is
evaluated independently, so a base with `additionalProperties: false` rejects
every property an extending schema adds — and with the `allOf` implicit, the
rejection has nothing visible to blame it on.

Either use `unevaluatedProperties: false` for strictness, which is draft
2019-09 and later, or forbid `additionalProperties` in `defaults.schema`.
Whichever way, the config has to pin a JSON Schema dialect rather than leaving
it to the validator, or strictness becomes folklore.

## Alternatives considered

**A `/` path entry carrying the defaults.** Rejected: under the vault rules `/`
is a location, meaning the vault root folder and the records directly in it.
Using it to mean "defaults everywhere" is a second mechanism wearing the same
notation.

**JSON Schema's own composition, exposed directly** — `$defs` at the config
root with paths writing `allOf` and `$ref` themselves. Honest and needs no new
vocabulary, but it puts the plumbing in every entry and only solves the schema
half, leaving `filename` still repeated.
