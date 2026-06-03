# Vault Spec

## Record types

### /

Global vault rules and default properties. Every markdown record lives in a typed top-level folder unless explicitly allowed here. Root markdown files are limited to `VAULT.md`. Properties listed here apply to every markdown record unless a path says otherwise. Use vault-relative file paths as stable IDs for records.

Properties:
- `created` — required. ISO date string (`YYYY-MM-DD`) when the record was created.
- `updated` — required. ISO date string (`YYYY-MM-DD`) when the record was last materially updated; same as `created` on creation.
- `labels` — optional. Inline array of label slugs from `## Labels`, e.g. `labels: [design, idea]`. Omit when empty.
- `related` — optional. Inline array of vault-relative record paths for important relationships, e.g. `related: [contacts/person.md, tasks/project.md]`.

### /references

External works and sources worth remembering, such as articles, papers, books, videos, websites, posts, and datasets. Use one record per source. Save a local copy with `asset_path` when useful; use `url` for the canonical remote source.

Properties:
- `title` — required. Source title.
- `type` — optional. Source type, e.g. `article`, `book`, `video`, `paper`, `website`, `post`, or `dataset`.
- `url` — optional. Canonical source URL.
- `author` — optional. Inline array of author names or vault-relative record paths.
- `date` — optional. Publication or source date as `YYYY-MM-DD` when known.
- `published_in` — optional. Publication, venue, or container.
- `publisher` — optional. Publisher or organization.
- `doi` — optional. DOI for citation lookup.
- `isbn` — optional. ISBN for books.
- `accessed` — optional. ISO date string (`YYYY-MM-DD`) when the source was accessed.
- `asset_path` — optional. Local path to saved source material.


### /contacts

People and organizations. Use one record per person or organization. Filename is a kebab-case slug.

Properties:
- `name` — required. Person or organization name.
- `type` — required. `person` or `organization`.
- `aliases` — optional. Inline array of alternate names.
- `email` — optional. Email address.
- `phone` — optional. Phone number.
- `website` — optional. Website or primary URL.

### /places

Geographic places and map-like locations. Use one record per place. Filename is a kebab-case slug.

Properties:
- `name` — required. Place name.
- `type` — required. `region`, `restaurant`, `bar`, `cafe`, `shop`, or `point-of-interest`.
- `parent` — optional. Containing place or region as a vault-relative path.
- `address` — optional. Street address.
- `gps` — optional. Inline array `[latitude, longitude]`.
- `website` — optional. Website or primary URL.

### /events

Dated records of real-world happenings: meetings, calls, conversations, visits, appointments, decisions, and other things that happened at a specific time or on a specific date.

Properties:
- `title` — required. Event title.
- `date` — required. ISO date string (`YYYY-MM-DD`) when the event happened.
- `participants` — optional. Inline array of vault-relative contact paths or names.
- `location` — optional. Place, venue, or context.

### /misc

Durable subject records that do not fit a more specific top-level folder. Use one record per subject. Before filing in `/misc`, verify no more specific top-level folder applies.

Properties:
- `title` — required. Subject title.
- `asset_path` — optional. Local path to source material or attached file.
- `url` — optional. External source, working artifact, or canonical URL for the subject.

### /special

Special singleton records for vault and agent operating state. This is a closed folder: only files with their own `/special/...` subsection are allowed. Do not use as a general notes folder. Each special file defines its own purpose, structure, and additional properties if needed.

#### /special/now.md

Current high-level status, standing context, active constraints, and pointers to important current records. Agents may read this for orientation before planning or answering context-heavy questions. This is not a task list, log, or scratchpad.

## Labels

Labels are curated retrieval sets across top-level folders.

No labels defined.

## Extensions

Extensions define workflows, skills, or tools for specific folders or paths.

No extensions defined.

## Validation

- `fslint` — run from vault root after edits.
