# HTTP API

The contract a *vault* answers over HTTP. It is what a *vault* is from outside:
programs, agents and web apps read and write one without knowing how it is
stored, and anything that answers this is an Autofile *vault*.

[The markdown vault](vault-markdown.md) is one implementation. Another, in any
language, is a different program answering the same requests.

## Routes

An *identity* is already a path, so the URL space is the *identity* space.

```
GET    /                the vault
GET    /{collection}    a collection's items
GET    /{identity}      a record or a blob
PUT    /{identity}      create or replace
DELETE /{identity}      remove
```

`HEAD` is answered wherever `GET` is, with the same headers and no body.
Anything else is `405`.

One segment is a *collection*; two or more is an *identity*. A *key* may contain
slashes, so `GET /blobs/assets/site/index.html` is the *blob*
`assets/site/index.html`.

A *key* may hold characters a URL path cannot carry literally, which a request
percent-encodes: `GET /contacts/priya%20narayan` is the *key* `priya narayan`.
Most *keys* need none of this, and a path of plain segments decodes to itself.

Where there is encoding, the path is split on `/` first and each segment decoded
after, then the segments are joined back into the *identity*. Decoding the whole
path first would let `%2F` invent a boundary that was not in the request, and
decoding after the *identity* was checked would let `%2e%2e` pass a check it
becomes `..` just too late for. A segment still holding a `/` once decoded names
nothing and is refused.

There is no `POST`. `POST` is for when the server chooses the *identity*, and
these are chosen by whoever files: a slug, a date-prefixed name, a path within a
site. Nothing here would know what to call a *record* it was handed.

## Reading

`GET /` is the *vault*'s *collections*, so one call tells a client what it is
talking to and an agent where things belong. Each carries what
[the model](vault.md) gives a *collection* and nothing else — a *vault* that
declares more for its own purposes keeps it.

```json
{
  "collections": [
    {
      "name": "contacts",
      "type": "record",
      "title": "Contacts",
      "description": "People and organizations. One record per person or organization.\n",
      "schema": { "required": ["name"], "properties": { "name": { "type": "string" } } }
    },
    {
      "name": "blobs",
      "type": "blob",
      "description": "Everything that is not a record.\n"
    }
  ]
}
```

`GET /{collection}` is its items, in *key* order.

```json
{
  "items": [
    {
      "type": "record",
      "id": "contacts/priya-narayan",
      "fields": {
        "name": "Priya Narayan",
        "related": [{ "$ref": "events/2026-06-02-zine-paper-chat" }],
        "photo": { "$ref": "blobs/contacts/priya-narayan.jpg" },
        "body": "Printmaker. Good person to ask about paper stock.\n"
      },
      "created": "2026-06-03T09:12:44.000Z",
      "updated": "2026-08-01T14:02:11.000Z"
    }
  ]
}
```

`GET` on a *record* is that object on its own. `GET` on a *blob* is its bytes,
with `Content-Type` from its media type and `Content-Length` from its size —
so `GET /blobs/assets/site/index.html` loads in a browser and the relative links
inside it resolve to sibling *identities*.

A *blob* has no JSON representation. Listings carry what is known about one, and
asking about a single *blob* means asking for it.

## Writing

`PUT` on a *record* takes its *fields* as the body, and answers with the
*record*.

```
PUT /contacts/priya-narayan
Content-Type: application/json

{ "name": "Priya Narayan", "body": "Printmaker.\n" }
```

`PUT` on a *blob* takes its bytes. What a *collection* holds decides how a body
is read, not `Content-Type` — otherwise a `.json` file could never be a *blob* —
and a *blob*'s media type comes from its *key*, so `Content-Type` on the way in
is only ever confirming what the extension already says.

`PUT` answers `200` whether or not anything was there. Distinguishing a create
from a replace would only report a clobbering after it happened, which is not
something a client can act on; refusing one in the first place is
`If-None-Match: *`, and that waits until overwriting is a real problem.

`DELETE` answers `204`, or `404` when nothing was there — the same answer a
`GET` on that *identity* would give.

## Status

A *vault* refuses things for different reasons, and they are different answers
rather than one.

- `404` — the *collection* holds no such *key*. Also when the *collection* is
  not declared at all, with a body that says so: a misspelled *collection* and
  an empty shelf are both nothing found, and only one of them is a typo.
- `400` — the *identity* is not spelled as one.
- `405` — a method these routes do not use.
- `415` — the body is the wrong kind for the *collection*.
- `422` — the *record*'s *fields* fail its *collection*'s `schema`, with the
  reasons as the body. The request was understood and refused, which is not the
  same as malformed.
- `500` — the *vault* holds something it cannot represent. The *vault* is broken
  rather than the request, and how to find out where is the *vault*'s own
  business.
