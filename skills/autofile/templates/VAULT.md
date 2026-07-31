# Vault Spec

## Record types

### /

Global vault rules and default properties. Every markdown record lives in a typed top-level folder; root markdown files are limited to `VAULT.md`. Properties listed here apply to every markdown record unless a path says otherwise.

Properties:
- `related` — optional. Inline array of wikilinks to related records, e.g. `related: ["[[contacts/person]]", "[[events/2026-06-02-zine-paper-chat]]"]`.

### /references

External works and sources worth remembering, such as articles, papers, books, videos, websites, posts, and datasets. Use one record per source. Save a local copy with `asset_path` when useful; use `url` for the canonical remote source.

Additional properties:
- `title` — required. Source title.
- `type` — optional. Source type, e.g. `article`, `book`, `video`, `paper`, `website`, `post`, or `dataset`.
- `url` — optional. Canonical source URL.
- `author` — optional. Inline array of author names, or wikilinks where the author has a contact record.
- `date` — optional. Publication or source date as `YYYY-MM-DD` when known.
- `publisher` — optional. Publisher or organization.
- `asset_path` — optional. Local path to saved source material.

### /contacts

People and organizations. Use one record per person or organization. Filename is a kebab-case slug.

Additional properties:
- `name` — required. Person or organization name.
- `type` — required. `person` or `organization`.
- `aliases` — optional. Inline array of alternate names.
- `email` — optional. Email address.
- `phone` — optional. Phone number.
- `website` — optional. Website or primary URL.

### /places

Geographic places and map-like locations. Use one record per place. Filename is a kebab-case slug.

Additional properties:
- `name` — required. Place name.
- `type` — required. `region`, `restaurant`, `bar`, `cafe`, `shop`, or `point-of-interest`.
- `parent` — optional. Wikilink to the containing place or region.
- `address` — optional. Street address.
- `gps` — optional. Inline array `[latitude, longitude]`.
- `website` — optional. Website or primary URL.

### /events

Dated records of real-world happenings: meetings, calls, conversations, visits, appointments, decisions, and other things that happened at a specific time or on a specific date.

Additional properties:
- `title` — required. Event title.
- `date` — required. ISO date string (`YYYY-MM-DD`) when the event happened.
- `participants` — optional. Inline array of wikilinks to contact records, or plain names where there is no record.
- `location` — optional. Wikilink to a place record, or plain text where there is no record.

### /context

Durable subject records that do not fit a more specific top-level folder. Cluster context around subject matter rather than keeping scraps. Before filing in `/context`, verify no more specific top-level folder applies.

Additional properties:
- `title` — optional. Subject title.
- `url` — optional. External source, working artifact, or canonical URL for the subject.
- `asset_path` — optional. Local path to source material or attached file.

## Validation

- Run: `fslint` from the vault root after edits. If not installed, use `npx @telepath-computer/fslint`.
