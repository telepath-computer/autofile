# `VAULT.md` format

`VAULT.md` MUST use this structure:

```md
# Vault Spec

<Optional scope/description text.>

## Record types

### /

<Global vault rules, root-level conventions, and default properties. Properties listed here are available to record types unless a type says otherwise.>

Properties:
- `<field>` — optional. <meaning>

### /<path>

<Description, rules, and conventions for this record type.>

Properties:
- `<field>` — required. <meaning>
- `<field>` — optional. <meaning>
```

- Record type headings are paths, e.g. `### /`, `### /contacts`, `### /tasks/archive`.
- Use `Properties: none.` for paths without frontmatter records.
`VAULT.md` must also include these sections:

```md
## Labels

Labels are curated retrieval sets across top-level folders.

- `<label>` — <meaning / when to apply>
```

If no labels are defined:

```md
## Labels

No labels defined.
```

```md
## Extensions

Extensions define workflows, skills, or tools for specific folders or paths.

- `<path>` — skill: `<skill-name>`; <when to use>
```

Example:

```md
- `/tasks` — skill: `tasks`; use before creating, querying, closing, deferring, or reorganizing tasks.
```

If no extensions are defined:

```md
## Extensions

No extensions defined.
```

```md
## Validation

- Run: `fslint`
```

