# Autofile

## Overview

Autofile is a data store for agents. It keeps information as typed records with values, titles and stable addresses. Each type of record has one defined place and shape, and instructions that tell an agent what belongs there. Autofile provides a library for programs to embed and an MCP server for agents to file and retrieve records. The command and the MCP server use the same `Autofile` class as programs that import the package.

## Storage independence

The tools, resources, HTTP interface and library describe records, types and changes. They must not depend on how those values are stored. Replacing the storage implementation with SQLite or another database must leave those interfaces unchanged. Clients treat record, type and attachment addresses as opaque: they keep and reuse them without deriving storage details from them. An address may resemble a storage path, but clients must not use that resemblance to locate or interpret stored data.

The current implementation stores data in a folder. [Storage](storage.md) specifies that format, including ownership, direct edits, synchronization, locking and recovery. [Implementation](implementation.md) describes the code and libraries that implement these specifications.

## Records

A record has a JSON object as its value, like a row in a database table. [Types](#types) describes how a type is declared.

A record has a type, a key, a URI, and the times it was created and last changed. Its fields are held in `value`:

```json
{
  "uri": "autofile:///contact/priya-narayan",
  "type": "contact",
  "key": "priya-narayan",
  "createdAt": "2026-10-07T09:14:00Z",
  "updatedAt": "2026-10-07T09:20:00Z",
  "value": {
    "name": "Priya Narayan",
    "employer": "autofile:///organization/acme",
    "photo": "autofile:///_blobs/9f86d081…0a08.jpg"
  }
}
```

Autofile sets `createdAt` when it creates the record and `updatedAt` when it writes an updated record value, as UTC times in the [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) format. These are record timestamps, independent of how the store persists the record. The tools that write records change only `value`.

### URIs

The URI of a record is `autofile:///<type>/<key>`. For example, the contact with key `priya-narayan` has the URI `autofile:///contact/priya-narayan`. The type and key together identify one record within a store. The URI does not identify a storage location. Autofile serves each record as an MCP resource at that URI.

The URI has three slashes because the authority is empty. Addresses are scoped to one store; the URI does not name a server or a store.

### Keys

The key of a record is the last part of its URI: `priya-narayan` in `autofile:///contact/priya-narayan`. The key is separate from the fields in `value`.

[`create_record`](#create_record) takes an optional key:

- A key given to the tool uses lowercase letters, digits and hyphens, and starts with a letter or a digit. If a record of the same type already has that key, the write is refused.
- Without a key, Autofile generates a [TID](https://atproto.com/specs/tid), the time-ordered identifier defined by AT Protocol: 13 lowercase characters, such as `3jzfcijpj2z2a`. Generated keys sort by the time the records were created.

A key cannot be changed, because changing it would change the URI of the record.

### Links

A link is a field whose value is a full URI. The schema of a type marks each link field with `"format": "uri"`, the JSON Schema format for a full URI, and a link field holds only links. A `pattern` limits a field to links to records of one type:

```json
"employer": { "type": "string", "format": "uri", "pattern": "^autofile:///organization/" }
```

A link to an `autofile:` URI always points to a record that exists, as a foreign key does in a database:

- A write is refused if the record it would store holds a link to an `autofile:` URI that is not the URI of a record.
- Deleting a record removes every link to it from other records. A link that is an item of an array is removed from the array, and any other link is removed together with its field. If a record would then no longer match its type, for example because the link is required, the delete is refused and the reply lists each such record. The delete is also refused while a record that does not match its type holds the URI of the deleted record as a string value anywhere, because the schema of its type no longer says which of its fields are links, and while any record cannot be read, because that record may hold a link. Once that record is fixed, the delete can be made again.

### Blobs

A blob is an attachment held in a field of a record, such as a scanned receipt or a photo. It consists of bytes and a media type. A blob is not a record: it has no record type or schema.

The schema of a type marks each blob field with `"format": "blob"`, a format Autofile defines. Code that checks records with a strict JSON Schema validator has to register this format.

```json
"scan": { "type": "string", "format": "blob" }
```

A blob field holds an opaque URI of the form `autofile:///_blobs/<hash>.<ext>`, such as `autofile:///_blobs/9f86d081…0a08.pdf` (abbreviated here). The extension is omitted when unknown. Clients use the returned URI to read the attachment without interpreting its identifier. A type that needs an attachment name declares a field for it.

Clients upload attachment bytes before writing a record. The library method `blobs.put(bytes, mediaType)` and the MCP tool [`upload_blob`](#upload_blob) return the attachment URI. The client puts that URI in a blob field when it creates or updates a record. Equal contents may share one stored attachment. Autofile may normalize the declared media type and uses `application/octet-stream` when reading media types it does not recognize.

A blob field accepts only the URI of an attachment that exists. Any record may hold that URI, including several records at once. Record writes accept neither data URIs nor local paths in blob fields. Schema constraints apply to the actual attachment URI, so a field constrained to end in `.pdf` accepts an uploaded PDF address.

The library accepts bytes as a `Uint8Array`. The MCP upload tool accepts base64 bytes and a media type. A media type has a type and subtype, such as `application/pdf`, without parameters. Over stdio the upload tool also accepts an absolute local file path, which the adapter reads before passing bytes to the library. The path is interpreted on the machine running Autofile, with the permissions of that process. HTTP refuses this input. The library never opens a caller-supplied attachment path.

Uploading and writing a record are separate operations. A refused record write leaves the uploaded attachment available for a later attempt.

A blob can be at most 7 MiB (7,340,032 bytes). Reading a blob returns it as base64 in one MCP message, and clients built on the MCP TypeScript SDK accept messages of up to 10 MiB, which a blob of 7 MiB fits once encoded, with room for the rest of the message. A larger attachment is refused with a message giving its size and the limit.

Clients keep the URI returned by an upload or read it from a record that holds the attachment. There is no blob enumeration. Library callers read one with `blobs.get(uri)`; MCP clients read its URI with `resources/read`.

After each update or delete, Autofile deletes every blob that the previous version of the record held and that no record still holds. A record that matches its type holds the blobs in its blob fields. A record that does not match its type holds every blob whose URI appears in it as a string value, because the schema of its type no longer says which of its fields are blob fields. Its blobs are therefore kept until it is fixed or deleted, and are then deleted if nothing else holds them. While any record cannot be read, Autofile deletes no blobs, because that record may hold one.

Cleanup of uploads that no record has held is deferred; those uploads remain stored.

## Types

A type has a name and a declaration that describes its records. The URI of a declaration is `autofile:///_types/<type>`, such as `autofile:///_types/contact`. Autofile serves each declaration as an MCP resource.

A declaration has these fields:

- `description` says what records belong to the type. Agents read it to choose where to file.
- `schema` is the JSON Schema that every record of the type must match. Guidance about a single field goes in the standard `description` keyword of that field.
- `titleField`, which is optional, names a top-level field of the record that holds its title, such as `name` for a contact. Clients show the title in place of the key; see [Resources](#resources). A record whose value for that field is not a string has no title.

```json
{
  "description": "People the user knows or deals with, one record per person.",
  "titleField": "name",
  "schema": {
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": { "type": "string", "description": "Full name as the person uses it." },
      "employer": { "type": "string", "format": "uri", "pattern": "^autofile:///organization/" }
    }
  }
}
```

Schemas use JSON Schema 2020-12, the version MCP assumes when a schema does not name one. Autofile checks the `format` keyword, which JSON Schema validators skip unless configured to check it, and refuses a schema that uses a format it does not know, since that format would go unchecked. A value marked with `"format": "uri"` or `"format": "blob"` must be a string. A `$ref` in a schema may point only within that schema, so checking a record needs no external schema.

Type names use lowercase letters, digits and hyphens, and start with a letter. The `_types` and `_blobs` address prefixes therefore never clash with record types.

### Changing types

Through MCP, types are created, changed and deleted through Autofile tools that do nothing else. A host that asks before running a tool therefore asks the user before each change to a type.

A valid change to a type is always accepted. Records that no longer match the new schema stay as they are, and the reply from the tool lists each of them with errors that say what must change. A write to a record must still produce a record that matches its type, so a record that does not match its type has to be fixed before it can be saved.

A type can be deleted only when it has no stored data. Unreadable records and other stored data block deletion so they retain their type declaration. Types cannot be renamed, because renaming would change the URI of every record of the type.

## API

Autofile provides the library interface below and a set of tools and resources as an MCP server, following the [MCP specification of 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). Clients that speak an earlier version of MCP are refused. Autofile declares the `resources` capability with `subscribe` and `listChanged`.

### Library API

The ES module package `@telepath-computer/autofile` exports `Autofile` and `AutofileError`, together with their TypeScript types. Importing it starts no server or watcher. The `autofile` command remains available.

`new Autofile({ folder })` opens a store using the current implementation. `folder` is a path, as described in [Storage](storage.md#folders). Construction does no I/O. The first operation initializes the store if needed, and concurrent operations wait for that setup. Record, type and attachment operations expose no storage paths or handles.

The class provides these asynchronous methods:

| Method | Result |
| --- | --- |
| `records.find(query?)` | A `RecordQueryResult`: `records`, `unreadable`, and an optional `cursor`. |
| `records.get(uri)` | An `AutofileRecord`, or `undefined` when the record or its type does not exist. A readable record is returned even when its value no longer matches the schema. |
| `records.create(type, value, options?)` | The complete new `AutofileRecord`. `options.key` supplies a key; otherwise one is generated. |
| `records.update(uri, patch)` | The complete updated `AutofileRecord`. The patch follows [JSON Merge Patch](#update_record). |
| `records.delete(uri)` | No value. Applies the existing [link](#links) and [blob](#blobs) removal rules. |
| `types.list()` | Every valid `TypeDeclaration`, ordered by name. |
| `types.get(name)` | A `TypeDeclaration`, or `undefined` when absent. |
| `types.create(name, definition)` | The new `TypeDeclaration`. |
| `types.update(name, changes)` | The updated `TypeDeclaration`. Accepts any subset of the definition; `titleField: null` removes the title field. Existing records stay as they are; `problems` reports records that cannot be read or do not match the new schema. |
| `types.delete(name)` | No value. Refused while the type has stored data. |
| `blobs.put(bytes, mediaType)` | The attachment URI as a string. `bytes` is a `Uint8Array`; `mediaType` is a string such as `application/pdf`. Copies the bytes before asynchronous work, applies the size limit, and stores them for use in records. |
| `blobs.get(uri)` | `{ bytes: Uint8Array, mimeType: string }`, or `undefined` when the attachment is absent or its contents cannot be accepted. |
| `watch(onChange, options?)` | A function returning a promise that stops this subscription. |
| `close()` | No value. Stops the watcher and all subscriptions; the instance cannot be used afterwards. Calling it again is harmless. |

`AutofileRecord` contains `uri`, `type`, `key`, `createdAt`, `updatedAt`, `value`, and optional `title` and `problems`. The title is the string at the field named by `titleField` in the type declaration. `problems` is an array of `AutofileProblem` values when a readable record does not match its type. Each problem has a `message` and an optional `uri`. Records that match their type omit `problems`.

`TypeDefinition` contains the fields in [Types](#types): `description`, `schema`, and optional `titleField`. `TypeDeclaration` adds `type` and `uri`. The declaration returned by `types.update` also has optional `problems`, with a record URI for each problem found when checking existing records against the updated type. `TypeChanges` permits partial updates and removal of `titleField` with `null`. JSON values use the exported `JsonObject`, `JsonValue`, and `JsonPrimitive` types.

Record values, update patches and schemas must contain only plain JSON data: objects with enumerable data properties, dense arrays, strings, booleans, null and finite numbers. Values that JSON serialization would change or drop are refused before schema validation or writing. These include `NaN`, infinities, negative zero, `undefined`, functions, symbols, bigint, sparse arrays, custom objects and circular references. Accessors and custom serialization are not called. Record writes, type writes and schema preparation copy their inputs before asynchronous work, so later changes by the caller do not alter the result.

`RecordQuery` has the same optional `type`, `q`, `where`, `fields`, `limit`, and `cursor` options as [`find_records`](#find_records). With no query it searches every declared type. `type` may name one type or an array; an empty array selects none, and duplicate names have no effect. `where` matches only `value`, so a record field named `type` is distinct from the query option. Results are ordered by complete URI across all selected types. Selecting fields changes only `value`; it does not remove `title` or other record information. `unreadable` lists `{ uri, message }` for records that could not be read and matching records that do not match their schema, using the same rules as the MCP tool `errors` list.

Refused operations throw `AutofileError`, whose `problems` array gives each reason as `{ message, uri? }`. This includes invalid arguments, unacceptable schemas, refused writes and writes to missing records or types. Unexpected storage failures throw `Error`, with a message about the failed operation and no physical storage details. Missing reads return `undefined` as listed above.

Upload bytes with `blobs.put`, then supply the returned URI in a record field, as described in [Blobs](#blobs). Record methods accept existing attachment URIs, including those held by other records.

`watch` starts change monitoring on first use and shares it between subscriptions on the instance. It resolves once monitoring is ready. The callback receives an array of `ChangeEvent` values, each with a record or type `uri` and a `kind` of `"created"`, `"changed"`, or `"deleted"`. Events include writes through the class and changes made by other writers. A notice asks the caller to read again; it does not guarantee that the current value is valid. Changes close together may share a callback. A record created and removed before monitoring observes it may send none. Unsubscribing leaves other subscriptions active. Call `close` to release monitoring when finished.

The optional `WatchOptions` argument accepts `onError(error: Error)`. Monitoring failures are reported without storage details. A failure to refresh type information reports an error and still delivers the observed changes, including unrelated records in the same batch. An error thrown by a change callback is passed to the error callback for that subscription. Failure to start monitoring rejects the `watch` call. Change callbacks may return promises.

The asynchronous static method `Autofile.prepareSchema(schema)` returns a `PreparedSchema`, or throws `AutofileError` for a schema Autofile cannot accept. Its asynchronous `validate(value)` returns an empty array on success, otherwise an array of messages. Its `formatFields(value, format)` reports the locations of fields marked `uri` or `blob` in a schema-valid value. Preparation needs no store; `validate(value)` checks whether the value matches the schema, not whether linked records or blobs exist. Record writes perform those existence checks.

### Instructions

Autofile describes itself to clients with the description "Typed records that agents file and retrieve." It also sends instructions for the model, which clients such as Claude Code place in the system prompt for the whole session:

> Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.
>
> Types: contact, organization, task. This list was taken when the session began; call `list_types` for types created since.

The last line names the types that exist when the client connects, without their descriptions, so the instructions stay short however many types there are. Before any type exists, it begins "Types: none yet." Not every client shows instructions to the model, so the descriptions of `find_records` and `create_record` also say that Autofile is where durable information is kept.

### Resources

Records and type declarations are listed as MCP resources:

| Resource | URI | `name` | `mimeType` | Contents from `resources/read` |
| --- | --- | --- | --- | --- |
| Record | `autofile:///<type>/<key>` | `<type>: <key>` | `application/json` | The complete `AutofileRecord`, serialized in `text` |
| Type declaration | `autofile:///_types/<type>` | `Type: <type>` | `application/json` | The complete `TypeDeclaration`, serialized in `text` |

MCP requires a `name` for every resource and leaves `title` optional. Clients show the name when there is no title. A record with a string in its declared title field is listed with that title. A type is listed with its description. Listings contain no sizes or modification times; record timestamps are part of the record itself. Entries in `resources/list` look like this:

```json
{ "uri": "autofile:///contact/priya-narayan", "name": "contact: priya-narayan", "title": "Priya Narayan", "mimeType": "application/json" }
{ "uri": "autofile:///_types/contact", "name": "Type: contact", "mimeType": "application/json", "description": "People the user knows or deals with, one record per person." }
```

`resources/list` returns records and types, ordered by URI, a page at a time. It includes readable records that do not match their schema. It serves clients that let a person pick a resource; agents use the [tools](#tools). Blobs are never listed, whether or not a record holds them. A client gets an attachment URI from an upload or a record and reads it with `resources/read`:

```json
{
  "contents": [
    { "uri": "autofile:///_blobs/9f86d081…0a08.pdf", "mimeType": "application/pdf", "blob": "JVBERi0xLjcK…" }
  ],
  "ttlMs": 0,
  "cacheScope": "private"
}
```

Reading a record or type returns the same shape with `text` in place of `blob`. The text is JSON made from the public value, with object keys sorted at every depth, two-space indentation and a final newline. Array order is preserved. A record includes its identity, timestamps, value, optional title and any validation problems. A missing resource, or a record or type that cannot be returned as a readable value, produces MCP error `-32602`. Unexpected storage failures produce a protocol error.

Results from `resources/list` and `resources/read` carry `ttlMs: 0` and `cacheScope: "private"`: a record can change at any time and belongs to the user, so a client that needs to know of changes subscribes to them.

A client subscribes by sending `subscriptions/listen` with record or type URIs in `resourceSubscriptions`. When a record or type is created, changed or deleted, Autofile sends `notifications/resources/updated` to clients subscribed to that exact URI. There are no parent, folder or root resources. For a changed task:

```json
{ "method": "notifications/resources/updated", "params": { "uri": "autofile:///task/book-the-dentist" } }
```

When what `resources/list` returns changes, because a record or type is created or deleted or a title or description changes, Autofile sends `notifications/resources/list_changed` to every client listening with `resourcesListChanged`.

### Tools

Each tool takes its arguments as one JSON object and returns its result as `structuredContent`, with the same JSON in a text block for clients that read only text. A call that is refused, such as a write whose result does not match its type, returns a result with `isError: true` and `errors` listing each problem as `{ "uri", "message" }`, with `uri` present when the problem concerns a particular resource, so the agent can correct the call:

```json
{
  "errors": [
    { "uri": "autofile:///task/3jzfcijpj2z2b", "message": "status: must be one of the allowed values" },
    { "message": "where: the operator $lt is not supported" }
  ]
}
```

#### find_records

Searches records across all types, one type, or selected types.

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string or array of strings | The type or types to search. All declared types when absent; an empty array selects none. |
| `q` | string | Words that must all appear in the string values of a record, at any depth, ignoring case. |
| `where` | object | Fields in the record `value` matched by value, in the [MongoDB query syntax](https://www.mongodb.com/docs/manual/tutorial/query-documents/) and with its matching rules: for an array field, a record matches if any item equals the value, and `null` matches a field that is missing. MongoDB operators such as `$lt` and `$in` are not supported yet, and a `where` that uses one is refused. They can be added later without changing this form. |
| `limit` | integer | The most results a page returns, counting records and those listed in `errors`: 50 by default, from 1 to 200. |
| `fields` | array of strings | Top-level fields to return in `value`, such as `["title", "status"]`, so a list does not carry every field of every record. All fields when absent. `q` and `where` still apply to the whole record. |
| `cursor` | string | The `cursor` from the previous page. |

```json
{ "type": "task", "q": "dentist", "where": { "status": "active" }, "limit": 50 }
```

`where` applies by field name in every selected type. A `null` match also includes records whose type has no such field. Record information such as the type is selected through its own option, independently of fields in `value`.

Results are ordered by URI across the selected types. A page considers records in that order until it has `limit` results, its result reaches 64 KB of JSON, or no records remain. The size cap never prevents the first result; it keeps a page of long records to a reasonable share of the context of an agent, which can pass `fields` for a compact list. `cursor` is present when records remain, and the next page starts after the last record the current page considered. Each record is returned with `uri`, `createdAt`, `updatedAt`, `value`, and its title in `title` when the type declares a title field with a string value. The title remains present when `fields` omits that value field. The names `uri` and `value` follow AT Protocol. A record that does not match its type is left out of `records`, and listed in `errors` with its URI and a message when it matches `q` and `where`. A record that cannot be read is always listed in `errors`, since it cannot be searched. Code that relies on the schema therefore receives only matching records, and no record the search would find is dropped without notice.

```json
{
  "records": [
    {
      "uri": "autofile:///task/3jzfcijpj2z2a",
      "title": "Book the dentist",
      "createdAt": "2026-10-07T09:14:00Z",
      "updatedAt": "2026-10-07T09:14:00Z",
      "value": { "title": "Book the dentist", "status": "active" }
    }
  ],
  "errors": [
    { "uri": "autofile:///task/3jzfcijpj2z2b", "message": "status: must be one of the allowed values" }
  ],
  "cursor": "…"
}
```

#### get_record

Returns one record, in the same shape as an item of `records` from [`find_records`](#find_records). A record that does not match its type is still returned, with what must change in `error`, so the agent can fix it with [`update_record`](#update_record). Refused if no record has the URI or the record cannot be read.

| Argument | Type | Meaning |
| --- | --- | --- |
| `uri` | string, required | The URI of the record. |

```json
{
  "uri": "autofile:///task/3jzfcijpj2z2b",
  "title": "Call the bank",
  "createdAt": "2026-10-07T09:14:00Z",
  "updatedAt": "2026-10-07T09:14:00Z",
  "value": { "title": "Call the bank", "status": "waiting" },
  "error": "status: must be one of the allowed values"
}
```

#### create_record

Creates a record and returns `{ "uri": "…" }`. Refused if the record does not match its type, holds a link to a record that does not exist, or the key is taken.

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The type of the record. |
| `key` | string | The key, as described in [Keys](#keys). Generated when absent. |
| `record` | object, required | The full record. Blob fields hold existing attachment URIs, obtained through [`upload_blob`](#upload_blob) or another record. |

```json
{ "type": "task", "key": "book-the-dentist", "record": { "title": "Book the dentist", "status": "active" } }
```

#### update_record

Changes a record and returns `{ "uri": "…" }`. Refused if the result does not match its type or holds a link to a record that does not exist.

| Argument | Type | Meaning |
| --- | --- | --- |
| `uri` | string, required | The URI of the record. |
| `patch` | object, required | A [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396): fields in the patch are set, a field set to `null` is removed, nested objects are merged, and arrays are replaced whole. Blob fields hold existing attachment URIs, as described in [Blobs](#blobs). |

```json
{ "uri": "autofile:///task/book-the-dentist", "patch": { "status": "complete" } }
```

#### upload_blob

Uploads attachment bytes and returns `{ "uri": "…" }`. Use that URI in a blob field when creating or updating a record. Uploading the same bytes with the same media type returns the same URI.

| Argument | Type | Meaning |
| --- | --- | --- |
| `base64` | string | The bytes encoded as base64, without a data URI prefix. Requires `mediaType`. |
| `mediaType` | string | The media type, such as `application/pdf`. Required with `base64`; with `path`, overrides the media type inferred from the file extension. |
| `path` | string | An absolute path to a regular local file. Accepted only over stdio. |

Supply exactly one of `base64` and `path`. A path with an unknown extension uses `application/octet-stream` unless `mediaType` is given. Invalid base64, unreadable files, HTTP path inputs and attachments over the [size limit](#blobs) are refused.

```json
{ "base64": "SGVsbG8=", "mediaType": "text/plain" }
```

#### delete_record

Deletes a record, removes the links to it from other records, and returns `{ "uri": "…" }`. Refused if removing the links would leave a record that does not match its type, as described in [Links](#links).

| Argument | Type | Meaning |
| --- | --- | --- |
| `uri` | string, required | The URI of the record. |

Autofile does not detect record writes made at the same time: the last write wins.

#### list_types

Returns every type, ordered by name, with the URI of its declaration and its description. Takes no arguments.

```json
{
  "types": [
    { "uri": "autofile:///_types/contact", "type": "contact", "description": "People the user knows or deals with, one record per person." }
  ]
}
```

#### get_type

Returns the declaration of a type with its URI added. Refused if the type does not exist.

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The name of the type. |

```json
{
  "uri": "autofile:///_types/contact",
  "description": "People the user knows or deals with, one record per person.",
  "titleField": "name",
  "schema": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }
}
```

#### create_type

Declares a type and returns `{ "uri": "autofile:///_types/<type>" }`. Refused if the type exists, the name breaks the rule in [Types](#types), or the schema is not one Autofile accepts, as described in [Types](#types).

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The name of the type. |
| `description` | string, required | What records belong to the type. |
| `schema` | object, required | The JSON Schema for records of the type. |
| `titleField` | string | The field that holds the title of a record, as described in [Types](#types). |

```json
{
  "type": "contact",
  "description": "People the user knows or deals with, one record per person.",
  "titleField": "name",
  "schema": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }
}
```

#### update_type

Replaces the description, schema or title field of a type, or any of them. A valid change is always accepted, as described in [Changing types](#changing-types); the call is refused if the type does not exist or the schema is not one Autofile accepts, as for `create_type`. Returns the URI of the declaration, and in `errors` each record that cannot be read or no longer matches:

```json
{
  "uri": "autofile:///_types/contact",
  "errors": [
    { "uri": "autofile:///contact/priya-narayan", "message": "employer: must be a full URI" }
  ]
}
```

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The name of the type. |
| `description` | string | The new description. |
| `schema` | object | The new JSON Schema. |
| `titleField` | string or null | The new title field; `null` removes it. |

#### delete_type

Deletes a type and returns `{ "uri": "…" }`. Refused while the type has stored data, as described in [Changing types](#changing-types).

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The name of the type. |

## Running Autofile

### Commands

| Command | Effect |
| --- | --- |
| `autofile` | Runs the MCP server over stdio. MCP clients start Autofile with this command. |
| `autofile serve [--host <host>] [--port <port>]` | Runs the MCP server over HTTP until stopped, as described in [Serving over HTTP](#serving-over-http). The options override the `http.host` and `http.port` settings for that run. |
| `autofile set <setting> <value>` | Sets a setting. |
| `autofile get <setting>` | Prints the value of a setting, or its default when it is not set. |
| `autofile unset <setting>` | Removes a setting, so its default applies again. |

The settings:

| Setting | Value | Default |
| --- | --- | --- |
| `storage` | Selects the store. See [storage settings](storage.md#folders). | See [Storage](storage.md#folders). |
| `http.host` | The address `autofile serve` listens on. | `127.0.0.1` |
| `http.port` | The port `autofile serve` listens on. | `7319` |
| `http.origins` | Browser origins `autofile serve` accepts besides those on localhost, given to `set` as one or more arguments, such as `autofile set http.origins https://app.example.com`. | none |

Changing `storage` selects a store without moving records. A running process keeps the settings it started with, so a change applies after it restarts.

### Serving over HTTP

`autofile serve` runs the same MCP server over the Streamable HTTP transport of MCP 2026-07-28, at the endpoint `/mcp`: with the defaults, `http://127.0.0.1:7319/mcp`. It serves the same tools and resources as stdio.

Autofile does not authenticate HTTP clients, so anything that can reach its address can read and write the store. It listens on `127.0.0.1` by default, as MCP advises for a local server. As MCP requires, it checks the `Origin` header of every request, so that a website open in a browser cannot reach a local Autofile by pointing its own domain at the local machine (DNS rebinding). A request with an `Origin` header is refused with HTTP 403 unless the origin is on localhost (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, with any port) or listed in `http.origins`. Requests without an `Origin` header, which clients other than browsers send, are not affected. Autofile also refuses with HTTP 403 a request whose `Host` header names a host other than `localhost`, `127.0.0.1`, `[::1]` or the host of an origin in `http.origins`, whatever the port, so a request that reaches Autofile through a rebound domain name is refused even without an `Origin` header.

### Processes

Each MCP client over stdio starts its own `autofile` process, and a running `autofile serve` is one more process. Processes using the same store see current records on each request. Writes are serialized, including the link removals and attachment cleanup they require. A record read never returns a partially written value.

Each MCP server monitors changes and sends the notices described in [Resources](#resources). A notice tells a client to look again. Changes close together may share a notice; once changes stop, every observed change has been followed by a notice.

The rules in [Links](#links) and [Blobs](#blobs) apply to writes through Autofile. Other writers can leave invalid values or missing references. Reads expose validation problems so callers can repair records. The on-disk format and rules for editing, synchronization and recovery are in [Storage](storage.md).
