# Install

To initialize the vault:

1. Validation can be run with `fslint` via `npx`:

```sh
npx @telepath-computer/fslint
```

2. Create the target directory.
3. Copy `templates/VAULT.md` to `<target>/VAULT.md`.
4. Copy `templates/.fslint.yml` to `<target>/.fslint.yml`.
5. Create folders for each top-level folder referenced in `VAULT.md`:
  - `assets/`
  - `references/`
  - `contacts/`
  - `places/`
  - `events/`
  - `misc/`
  - `special/`
6. Create `<target>/special/now.md` with frontmatter (adding the current date):

```yaml
---
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
---
```

7. Run `fslint` from the target vault.
8. Do not overwrite existing files unless the user explicitly asks.
