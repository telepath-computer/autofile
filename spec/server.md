# Server

`autofile serve` exposes a *vault* over HTTP, so programs and web apps can read
and write it without touching the filesystem. It serves the *vault* it is run
in.

## Records on the wire

A *record* is JSON.

```json
{
  "id": "contacts/priya-narayan",
  "fields": {
    "name": "Priya Narayan",
    "related": [{ "$ref": "events/2026-06-02-zine-paper-chat" }],
    "body": "Printmaker. Good person to ask about paper stock.\n"
  },
  "created": "2026-06-03T09:12:44.000Z",
  "updated": "2026-08-01T14:02:11.000Z"
}
```

- `id` — the *record*'s *identity*.
- `fields` — its data, nested rather than lifted to the root, where it would
  collide with `id`, `created` and `updated`.
