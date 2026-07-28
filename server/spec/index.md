# Autofile-server

A local HTTP server that exposes autofile vaults to apps. It serves the vault's records as JSON with frontmatter transformed into structured properties, and accepts writes so an app can create and update records.

The initial version covers listing records, getting a single record, and writing a record — in full (PUT) or partially (PATCH). Two discovery routes let a client find the vaults and their types without being told a name in advance, and every read route serves a built-in browser UI (`ui.md`) to requests that prefer HTML. Apps poll the read routes to stay current. Later additions: change subscriptions, querying, schema validation of writes, and write-conflict detection.

## HTTP interface

### Routes

```
GET /                                       → the configured vaults
GET /vaults/<vault>                         → a vault's record types
GET /vaults/<vault>/records/<type>          → all records of a type
GET /vaults/<vault>/records/<type>/<slug>   → one record
PUT /vaults/<vault>/records/<type>/<slug>   → create or replace one record
PATCH /vaults/<vault>/records/<type>/<slug> → partially update one record
```

Every route that touches a vault starts with the vault's name (see CLI interface). Everything after `records/` is exactly the record's vault-relative ID — the same string used in wikilinks. The `records/` segment namespaces record routes apart from other per-vault endpoints (such as the change feed, a later addition), which is necessary because record types are user-defined folder names and could otherwise collide with endpoint names.

An unknown vault name responds `404` on every route.

### Records on disk

The record `<type>/<slug>` is the file `<vault-root>/<type>/<slug>.md`. A record ID is exactly two non-empty segments; the `.md` extension is server-managed and never appears in routes — a slug ending in `.md` is rejected `400` rather than resolved to `<slug>.md.md`.

Route segments are untrusted input. After percent-decoding, `<type>` and `<slug>` are each rejected (`400`) if empty, equal to `.` or `..`, containing `/` or `\`, or beginning with `.` or `_`. In addition, the resolved target's real path must remain inside the vault root, or the request is refused — so neither traversal sequences nor symlinks inside the vault can read or write outside it.

A collection contains exactly the direct-child `*.md` files of the type folder. Files and folders beginning with `_` or `.`, non-`.md` files, and anything nested deeper are invisible to the server — reads never list them and the segment rules above keep writes out of them. This mirrors the vault convention that underscore-prefixed paths are ignored; it is structural knowledge, not schema knowledge.

### Types

#### Record

```json
{
  "id": "tasks/call-homesite-about-sublet-coverage",
  "type": "tasks",
  "properties": {
    "title": "Call Homesite about sublet coverage",
    "created_at": "2026-07-06",
    "status": "available",
    "project": "[[projects/confirm-sublet]]"
  },
  "body": "Markdown body, verbatim.",
  "mtime": "2026-07-06T18:41:03.000Z"
}
```

- `id` — the record's vault-relative path without `.md`; its stable identity.
- `type` — the top-level folder name. Derivable from `id`, included so clients don't string-split.
- `properties` — the frontmatter parsed as YAML and passed through untransformed. No coercion, no schema awareness. Wikilinks remain literal strings (`"[[projects/confirm-sublet]]"`); resolving them is the client's responsibility. Always an object: a file with no frontmatter block is a valid record with `properties: {}`, not an error. Frontmatter always stays nested here, never lifted or flattened into the payload root: frontmatter keys are user-defined, so only nesting keeps them from colliding with the server's fields (a record's frontmatter may itself contain `type`, as account and species records do).
- `body` — everything after the frontmatter, verbatim markdown.
- `mtime` — the file's stat mtime, ISO 8601.

#### Collection

```json
{
  "records": [ ... ],
  "errors": [
    { "path": "tasks/broken.md", "message": "YAML parse error: bad indentation at line 3" }
  ]
}
```

- `records` — full Record objects, bodies included: vaults are small (hundreds of records), and one fetch giving the app everything beats follow-up requests per record. An envelope rather than a bare array, so fields can be added later without breaking clients.
- `errors` — files that failed to parse, as Error objects. Present only when non-empty.

#### Error

```json
{ "path": "tasks/broken.md", "message": "YAML parse error: bad indentation at line 3" }
```

Every error response body is an Error: `message` always, `path` when the error concerns a specific file. In Collection `errors`, an entry reports a file whose frontmatter fails to parse as YAML. Deliberately not a record object: everything in `records` stays well-formed, and clients need no defensive branches. `path` is the raw vault-relative filename, `.md` included — unlike a Record `id`, because the file failed to become a record and so has no ID. Only unparseable files produce parse errors; records that parse but violate the vault schema are fslint's concern and serve normally.

### Content type and CORS

Responses are JSON, `Content-Type: application/json`, except where a `GET` negotiates to the UI shell (see below). A PUT or PATCH request body must be JSON and declare `Content-Type: application/json`, or the request is rejected `400`.

All responses include `Access-Control-Allow-Origin: *`, and `OPTIONS` preflight requests are answered, permitting `GET`, `PUT`, and `PATCH` and the `Content-Type` header. Browser-based artifacts are primary consumers, and a page calling `http://127.0.0.1:8766` is always cross-origin — without this, the flagship use case doesn't work. The policy matches fileserver; the access boundary is binding to localhost, not the origin.

### Content negotiation

Every `GET` route serves two representations of the same resource. A request whose `Accept` header prefers `text/html` — what a browser sends when navigating to the URL — receives the UI shell, the HTML document that boots the built-in UI (`ui.md`). Everything else receives JSON.

JSON is the default: `*/*`, a missing `Accept` header, and anything that does not prefer HTML all get JSON, so existing clients are unaffected and only browsers see HTML. Negotiated responses carry `Vary: Accept`.

The shell is served with the status the request actually earned — a `GET` of a missing record returns the shell with `404`, and the UI renders its not-found state — so a page URL and its data URL never disagree about whether a thing exists. It is served at every `GET` route rather than only at `/`, which is what makes a deep link or a reload land on the right page.

Writes are unaffected: PUT and PATCH are JSON-only.

### Serving the UI

The UI's build output is served as static files under `/_ui/`, where the shell's script and style references point. The prefix cannot collide with vault data, since every record route lives under `/vaults/`, and a leading underscore already marks paths this system ignores. It is deliberately not `/assets/`: vaults have their own `assets/` directory, which `asset_path` fields point into, and one word meaning two things in one system invites exactly the confusion the route layout otherwise avoids.

### GET /

Lists the vaults the server was started with, in the order they were given on the command line.

```json
{
  "vaults": [
    { "name": "main", "path": "/home/rupert/Vault" }
  ]
}
```

`path` is the resolved absolute directory with `~` already expanded. Exposing it is consistent with the access boundary: a client that can reach this route can already read every record in the vault. An envelope rather than a bare array, matching Collection, so fields can be added later without breaking clients.

### GET /vaults/\<vault\>

Lists a vault's record types — the direct child directories of the vault root — ordered by name, each with the number of records it holds.

```json
{
  "types": [
    { "name": "contacts", "count": 3 },
    { "name": "events", "count": 3 }
  ]
}
```

Visibility matches the record routes: directories beginning with `.` or `_` are invisible, and `count` is the number of direct-child `*.md` files — the same set `GET /vaults/<vault>/records/<type>` reports across its `records` and `errors` lists, so a broken file still counts. `VAULT.md` and every other root-level file is not a type and does not appear.

An unknown vault responds `404`.

### GET /vaults/\<vault\>/records/\<type\>

Returns a Collection of every record of the given type, ordered by `id` lexically (byte-wise) — deterministic, and date-prefixed filenames (journal, events, transactions) come back in chronological order.

A type folder that does not exist responds `404`; an existing but empty type folder responds `200` with `{"records": []}`.

Parse failures degrade per-record, never per-collection: the vault is edited live while the server runs, and one half-saved file must not take down the whole collection (throwing) or vanish without a trace (silent omission). Broken files are reported in the Collection's `errors` list.

### GET /vaults/\<vault\>/records/\<type\>/\<slug\>

Returns the single Record whose ID is `<type>/<slug>`, or `404` if no such file exists.

For example, `GET /vaults/main/records/tasks/call-homesite-about-sublet-coverage` returns one task.

If the file exists but its frontmatter fails to parse, responds `422 Unprocessable Entity` with an Error body.

### PUT /vaults/\<vault\>/records/\<type\>/\<slug\>

Creates the record at `<type>/<slug>` or fully replaces it. Responds `201` when the record was created, `200` when it was replaced; the response body is the resulting Record, with the server-computed fields (`id`, `type`, `mtime` — the stat mtime after the write) filled in. A missing type folder is created automatically: first-record-of-a-type is a normal path, and a schema-unaware server has no basis to refuse one.

Request body:

```json
{
  "properties": { "title": "..." },
  "body": "Markdown body."
}
```

`properties` must be an object and `body` a string; both are required. Unknown top-level fields are rejected `400` — cheap typo protection in a version with no other write validation. Request bodies are accepted up to 50 MB; larger requests are rejected `413`.

`properties` is written as the record's YAML frontmatter and `body` as the markdown body. Output YAML is normalized, not byte-preserving — replacing a record may reformat quoting or key order; nothing in the vault depends on frontmatter formatting.

The file is written atomically (temp file + rename), so other readers of the vault never see a half-written record.

The initial version does not validate writes against the vault schema and does not detect write conflicts — the last write wins. Both are later additions.

### PATCH /vaults/\<vault\>/records/\<type\>/\<slug\>

Partially updates an existing record. Responds `200` with the resulting Record. PATCH is not upsert: a record that does not exist responds `404` — creation is PUT's job, and a typo'd slug must fail loudly rather than merge into nothing. If the file exists but its frontmatter fails to parse, responds `422` with an Error body: there are no properties to merge into.

Request body: `{ "properties": {...}, "body": "..." }` with both fields optional. An empty patch `{}` is a valid no-op and returns the current record.

- `body`, when present, replaces the record body wholesale.
- `properties`, when present, is shallow-merged into the existing frontmatter key by key. A key set to `null` is removed. A key's new value replaces the old value entirely — nested objects and arrays are not merged recursively. Consequence: PATCH cannot set a property to a literal YAML `null`; the vault schema never uses null values, so nothing is lost.

Everything else matches PUT: the `Content-Type: application/json` gate, `properties` must be an object and `body` a string when present, unknown top-level fields rejected `400`, the 50 MB body limit, and the atomic temp-file + rename write. The server's read-merge-write is not atomic against a concurrent direct-on-disk edit — the last write wins, the same stance the initial version takes everywhere.

## CLI interface

Published as `@telepath-computer/autofile-server` with an `autofile-server` binary, following the house pattern (`@telepath-computer/fileserver`, `fslint`).

```
autofile-server --vault <name>=<path> [--vault <name>=<path> ...] [--host <host>] [--port <port>]
```

- `--vault name=path` — registers a vault; repeatable; at least one required. The name becomes the vault's route segment (`--vault main=~/Dropbox/Vault` → `/vaults/main/...`). Startup fails with an error if the name does not match `[a-z0-9-]+` or the path does not resolve to a real directory. A leading `~` or `~/` expands to the invoking user's home directory. The directory is not otherwise inspected — no `VAULT.md` or schema file is required, consistent with the server being schema-unaware.
- `--host` — host to bind. Default `127.0.0.1`. Localhost-only by default; binding a wider address exposes the vaults with no authentication.
- `--port` — port to listen on. Default `8766` (one off from fileserver's 8765, so both sidecars run side by side without configuration).
