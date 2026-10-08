# Autofile

## Overview

Autofile is a data store for agents. It keeps information as typed records, one JSON file per record, in a folder the user owns. Each type of record has one defined place and shape, and instructions that tell an agent what belongs there. Autofile is an MCP server: agents file and retrieve records through it, and other MCP servers and interfaces read, use and show the same records.

## Records

A record is a single JSON object that holds the fields of the record and nothing else, like a row in a database table. [Types](#types) describes how a type is declared.

A record is stored in the file `<type>/<key>.json`, in the folder for its type. The file holds the record in `value`, with the times the record was created and last changed:

```json
{
  "createdAt": "2026-10-07T09:14:00Z",
  "updatedAt": "2026-10-07T09:20:00Z",
  "value": {
    "name": "Priya Narayan",
    "employer": "autofile:///organizations/acme",
    "photo": "autofile:///_blobs/9f86d081…0a08.jpg"
  }
}
```

Autofile sets `createdAt` when it creates the record and `updatedAt` whenever the record changes, as UTC times in the [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) format. The times are kept in the file because the times kept by the file system change when a file is copied. The tools that write records change only `value`.

### URIs

The URI of a record is `autofile:///<type>/<key>`: the path of its file within the [data folder](#folders), without the `.json` extension, under the scheme `autofile:`. The file `contacts/priya-narayan.json` has the URI `autofile:///contacts/priya-narayan`. Autofile serves each record as an MCP resource at that URI.

The URI has three slashes because the authority is empty. The authority is the part between `//` and the next `/`, which names a host in an `https:` URI. Autofile keeps one data folder, so there is nothing to name.

### Keys

The key of a record is the last part of its URI and the name of its file without `.json`: `priya-narayan` in `autofile:///contacts/priya-narayan`. The key is not a field in the record.

[`create_record`](#create_record) takes an optional key:

- A key given to the tool uses lowercase letters, digits and hyphens, and starts with a letter or a digit. If a record of the same type already has that key, the write is refused.
- Without a key, Autofile generates a [TID](https://atproto.com/specs/tid), the time-ordered identifier defined by AT Protocol: 13 lowercase characters, such as `3jzfcijpj2z2a`. Generated keys sort by the time the records were created.

A key cannot be changed, because changing it would change the URI of the record.

### Links

A link is a field whose value is a full URI. The schema of a type marks each link field with `"format": "uri"`, the JSON Schema format for a full URI, and a link field holds only links. A `pattern` limits a field to links into one folder:

```json
"employer": { "type": "string", "format": "uri", "pattern": "^autofile:///organizations/" }
```

A link to an `autofile:` URI always points to a record that exists, as a foreign key does in a database:

- A write is refused if the record it would store holds a link to an `autofile:` URI that is not the URI of a record.
- Deleting a record removes every link to it from other records. A link that is an item of an array is removed from the array, and any other link is removed together with its field. If a record would then no longer match its type, for example because the link is required, the delete is refused and the reply lists each such record. The delete is also refused while a record that does not match its type holds the URI of the deleted record as a string value anywhere, because the schema of its type no longer says which of its fields are links, and while any record cannot be read as JSON, because that record may hold a link. Once that record is fixed, the delete can be made again.

### Blobs

A blob is a file held in a field of a record, such as a scanned receipt or a photo. A blob is not a record: it has no type and no schema.

The schema of a type marks each blob field with `"format": "blob"`, a format Autofile defines. Code that checks records with a strict JSON Schema validator has to register this format.

```json
"scan": { "type": "string", "format": "blob" }
```

Blobs are kept in the `_blobs` folder. Each is named by the SHA-256 hash of its contents in lowercase hexadecimal, followed by the extension of the original file in lowercase, so the same file stored twice with the same extension is kept once. A blob field holds the URI of its blob, such as `autofile:///_blobs/9f86d081…0a08.pdf`. The extension gives the media type of the blob, and the file gives its size. The original file name is not kept; a type that needs it declares a field for it.

To store a file, a client writes it into a blob field with [`create_record`](#create_record) or [`update_record`](#update_record), in one of two forms:

- The absolute path of a local file, for an agent on the same machine as Autofile. Paths are accepted only over stdio; over HTTP they are refused, because the path would be read on the machine running Autofile, not the machine of the client.
- A [`data:` URI](https://www.rfc-editor.org/rfc/rfc2397) holding the contents in base64, such as `data:application/pdf;base64,JVBERi0x…`, for an artifact, a remote client or any other program that has the contents rather than a path. The blob takes the usual extension for the media type in the URI.

Autofile reads a file given by path with the permissions of the user running it, so any client connected to Autofile over stdio can store, and then read, any file that user can read.

Autofile checks the record with the path or `data:` URI still in the field. Only once the write is accepted does it store the file in `_blobs` and put the blob URI in the field, so a refused write stores nothing. A blob URI written into a blob field is kept as it is, so records can share a blob. A write is refused if a blob field holds anything other than the URI of a blob that exists, the absolute path of a file that exists, or a `data:` URI with base64 contents.

A blob can be at most 7 MiB (7,340,032 bytes). Reading a blob returns it as base64 in one MCP message, and clients built on the MCP TypeScript SDK accept messages of up to 10 MiB, which a blob of 7 MiB fits once encoded, with room for the rest of the message. A write with a larger file is refused with a message giving its size and the limit.

After each update or delete, Autofile deletes every blob that the previous version of the record held and that no record still holds. A record that matches its type holds the blobs in its blob fields. A record that does not match its type holds every blob whose URI appears in it as a string value, because the schema of its type no longer says which of its fields are blob fields. Its blobs are therefore kept until it is fixed or deleted, and are then deleted if nothing else holds them. While any record cannot be read as JSON, Autofile deletes no blobs, because that record may hold one.

## Types

A type is declared by one JSON file in the `_types` folder. The name of the file without `.json` is the name of the type and of the folder that holds its records: `_types/contacts.json` declares the type `contacts`, whose records are in `contacts/`. Autofile serves each declaration as an MCP resource, such as `autofile:///_types/contacts`.

A declaration has these fields:

- `description` says what belongs in the folder. Agents read it to choose where to file.
- `schema` is the JSON Schema that every record of the type must match. Guidance about a single field goes in the standard `description` keyword of that field.
- `titleField`, which is optional, names a top-level field of the record that holds its title, such as `name` for contacts. Clients show the title in place of the key; see [Resources](#resources). A record whose value for that field is not a string has no title.

```json
{
  "description": "People the user knows or deals with, one record per person.",
  "titleField": "name",
  "schema": {
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": { "type": "string", "description": "Full name as the person uses it." },
      "employer": { "type": "string", "format": "uri", "pattern": "^autofile:///organizations/" }
    }
  }
}
```

Schemas use JSON Schema 2020-12, the version MCP assumes when a schema does not name one. Autofile checks the `format` keyword, which JSON Schema validators skip unless configured to check it, and refuses a schema that uses a format it does not know, since that format would go unchecked. A value marked with `"format": "uri"` or `"format": "blob"` must be a string. A `$ref` in a schema may point only within that schema, so checking a record never reads another file or the network.

Type names use lowercase letters, digits and hyphens, and start with a letter. Top-level folder names that start with `_`, such as `_types` and `_blobs`, belong to Autofile, so they never clash with a type.

### Changing types

Types are created, changed and deleted through Autofile tools that do nothing else. A host that asks before running a tool therefore asks the user before each change to a type.

A change to a type is always accepted. Records that no longer match the new schema stay as they are, and the reply from the tool lists each of them with errors that say what must change. A write to a record must still produce a record that matches its type, so a record that does not match its type has to be fixed before it can be saved.

A type can be deleted only when its folder is empty. Types cannot be renamed, because renaming would change the URI of every record of the type.

## API

The API of Autofile is the set of tools and resources it exposes as an MCP server, following the [MCP specification of 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). Clients that speak an earlier version of MCP are refused. Autofile declares the `resources` capability with `subscribe` and `listChanged`.

### Instructions

Autofile describes itself to clients with the description "Typed records that agents file and retrieve, kept as JSON files in a folder the user owns." It also sends instructions for the model, which clients such as Claude Code place in the system prompt for the whole session:

> Autofile is where the user keeps durable information, as typed records. When information should outlive the current task, file it here. Call `list_types` to see the types and what belongs in each, and `get_type` for the schema of one. Search with `find_records` before creating a record, so the same thing is not filed twice. If no type fits, propose a new type to the user and create it only once they agree.
>
> Types: contacts, organizations, tasks. This list was taken when the session began; call `list_types` for types created since.

The last line names the types that exist when the client connects, without their descriptions, so the instructions stay short however many types there are. Before any type exists, it begins "Types: none yet." Not every client shows instructions to the model, so the descriptions of `find_records` and `create_record` also say that Autofile is where durable information is kept.

### Resources

Every record, type declaration and blob is an MCP resource at its URI:

| Resource | URI | `name` | `mimeType` | Contents from `resources/read` |
| --- | --- | --- | --- | --- |
| Record | `autofile:///<type>/<key>` | `<type>/<key>` | `application/json` | The file as stored, in `text` |
| Type declaration | `autofile:///_types/<type>` | `_types/<type>` | `application/json` | The file as stored, in `text` |
| Blob | `autofile:///_blobs/<hash>.<ext>` | `_blobs/<hash>.<ext>` | Given by the extension, or `application/octet-stream` when the extension is unknown | The bytes, base64-encoded, in `blob` |

MCP requires a `name` for every resource and leaves `title` optional, and clients show the `name` when there is no `title`. The `name` is the part of the URI after `autofile:///`, which is unique. A record is listed with the time it last changed, its `updatedAt` time, in `annotations.lastModified`, and, when its type has a `titleField`, with its title in `title`. A type declaration is listed with the description of the type in `description`, and a blob with its size in bytes in `size`. Entries in `resources/list` look like this:

```json
{ "uri": "autofile:///contacts/priya-narayan", "name": "contacts/priya-narayan", "title": "Priya Narayan", "mimeType": "application/json", "annotations": { "lastModified": "2026-10-07T09:20:00Z" } }
{ "uri": "autofile:///_types/contacts", "name": "_types/contacts", "mimeType": "application/json", "description": "People the user knows or deals with, one record per person." }
{ "uri": "autofile:///_blobs/9f86d081…0a08.pdf", "name": "_blobs/9f86d081…0a08.pdf", "mimeType": "application/pdf", "size": 482113 }
```

`resources/read` returns the resource as one item in `contents`. Reading a blob returns:

```json
{
  "contents": [
    { "uri": "autofile:///_blobs/9f86d081…0a08.pdf", "mimeType": "application/pdf", "blob": "JVBERi0xLjcK…" }
  ],
  "ttlMs": 0,
  "cacheScope": "private"
}
```

Reading a record or a type declaration returns the same shape, with the file as stored in `text` in place of `blob`. Reading a URI that does not exist returns the MCP error `-32602`, which MCP uses for a resource that does not exist.

`resources/list` returns every resource, ordered by URI, a page at a time. It serves clients that let a person pick a resource; agents use the [tools](#tools).

Results from `resources/list` and `resources/read` carry `ttlMs: 0` and `cacheScope: "private"`, as above: a record can change at any time and belongs to the user, so a client that needs to know of changes subscribes to them.

A client subscribes by sending `subscriptions/listen` with URIs in `resourceSubscriptions`. When a resource is created, changed or deleted, Autofile sends `notifications/resources/updated` naming the resource, the folder that holds it, such as `autofile:///tasks`, and the root, `autofile:///`. Each notice goes to the clients subscribed to exactly the URI it names. A client can therefore subscribe to a record to be told when that record changes, or to a folder or the root to be told that something in it changed, and then look again. A change to any task sends a client subscribed to the tasks folder:

```json
{ "method": "notifications/resources/updated", "params": { "uri": "autofile:///tasks" } }
```

When what `resources/list` returns changes, because a resource is created or deleted or the `title` or `description` of a resource changes, Autofile sends `notifications/resources/list_changed` to every client listening with `resourcesListChanged`.

### Tools

Each tool takes its arguments as one JSON object and returns its result as `structuredContent`, with the same JSON in a text block for clients that read only text. A call that is refused, such as a write whose result does not match its type, returns a result with `isError: true` and `errors` listing each problem as `{ "uri", "message" }`, with `uri` present when the problem concerns a particular resource, so the agent can correct the call:

```json
{
  "errors": [
    { "uri": "autofile:///tasks/3jzfcijpj2z2b", "message": "status: must be one of the allowed values" },
    { "message": "where: the operator $lt is not supported" }
  ]
}
```

#### find_records

Searches the records of one type.

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The type to search. |
| `q` | string | Words that must all appear in the string values of a record, at any depth, ignoring case. |
| `where` | object | Fields matched by value, in the [MongoDB query syntax](https://www.mongodb.com/docs/manual/tutorial/query-documents/) and with its matching rules: for an array field, a record matches if any item equals the value, and `null` matches a field that is missing. MongoDB operators such as `$lt` and `$in` are not supported yet, and a `where` that uses one is refused. They can be added later without changing this form. |
| `limit` | integer | The most results a page returns, counting records and those listed in `errors`: 50 by default, from 1 to 200. |
| `fields` | array of strings | Top-level fields to return in `value`, such as `["title", "summary"]`, so a list does not carry every field of every record. All fields when absent. `q` and `where` still apply to the whole record. |
| `cursor` | string | The `cursor` from the previous page. |

```json
{ "type": "tasks", "q": "dentist", "where": { "status": "active" }, "limit": 50 }
```

Results are ordered by URI. A page reads record files in that order until it has `limit` results, its result reaches 64 KB of JSON, or no files remain, and it always holds at least one result; the size cap keeps a page of long records, such as topics, to a reasonable share of the context of an agent, which can pass `fields` for a compact list. `cursor` is present when files remain, and the next page starts after the last file the current page read. Each record is returned as the contents of its file with its URI added in `uri`. The names `uri` and `value` follow AT Protocol. A record that does not match its type is left out of `records`, and listed in `errors` with its URI and a message when it matches `q` and `where`. A file that cannot be read as JSON is always listed in `errors`, since it cannot be searched. Code that relies on the schema therefore receives only matching records, and no record the search would find is dropped without notice.

```json
{
  "records": [
    {
      "uri": "autofile:///tasks/3jzfcijpj2z2a",
      "createdAt": "2026-10-07T09:14:00Z",
      "updatedAt": "2026-10-07T09:14:00Z",
      "value": { "title": "Book the dentist", "status": "active" }
    }
  ],
  "errors": [
    { "uri": "autofile:///tasks/3jzfcijpj2z2b", "message": "status: must be one of the allowed values" }
  ],
  "cursor": "…"
}
```

#### get_record

Returns one record, in the same shape as an item of `records` from [`find_records`](#find_records). A record that does not match its type is still returned, with what must change in `error`, so the agent can fix it with [`update_record`](#update_record). Refused if no record has the URI or the file cannot be read as JSON.

| Argument | Type | Meaning |
| --- | --- | --- |
| `uri` | string, required | The URI of the record. |

```json
{
  "uri": "autofile:///tasks/3jzfcijpj2z2b",
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
| `record` | object, required | The full record. A blob field may hold a local path or a `data:` URI, as described in [Blobs](#blobs). |

```json
{ "type": "tasks", "key": "book-the-dentist", "record": { "title": "Book the dentist", "status": "active" } }
```

#### update_record

Changes a record and returns `{ "uri": "…" }`. Refused if the result does not match its type or holds a link to a record that does not exist.

| Argument | Type | Meaning |
| --- | --- | --- |
| `uri` | string, required | The URI of the record. |
| `patch` | object, required | A [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396): fields in the patch are set, a field set to `null` is removed, nested objects are merged, and arrays are replaced whole. A blob field may hold a local path or a `data:` URI, as described in [Blobs](#blobs). |

```json
{ "uri": "autofile:///tasks/book-the-dentist", "patch": { "status": "complete" } }
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
    { "uri": "autofile:///_types/contacts", "type": "contacts", "description": "People the user knows or deals with, one record per person." }
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
  "uri": "autofile:///_types/contacts",
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
| `description` | string, required | What belongs in the folder. |
| `schema` | object, required | The JSON Schema for records of the type. |
| `titleField` | string | The field that holds the title of a record, as described in [Types](#types). |

```json
{
  "type": "contacts",
  "description": "People the user knows or deals with, one record per person.",
  "titleField": "name",
  "schema": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }
}
```

#### update_type

Replaces the description, schema or title field of a type, or any of them. A valid change is always accepted, as described in [Changing types](#changing-types); the call is refused if the type does not exist or the schema is not one Autofile accepts, as for `create_type`. Returns the URI of the declaration, and in `errors` each record that no longer matches:

```json
{
  "uri": "autofile:///_types/contacts",
  "errors": [
    { "uri": "autofile:///contacts/priya-narayan", "message": "employer: must be a full URI" }
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

Deletes a type and returns `{ "uri": "…" }`. Refused unless the folder of the type is empty.

| Argument | Type | Meaning |
| --- | --- | --- |
| `type` | string, required | The name of the type. |

## Running Autofile

### Folders

Autofile keeps its settings, its write lock and, by default, its data in `~/.autofile`:

```
~/.autofile/
  config.json   settings, written by autofile set
  write.lock    exists while an autofile process is writing
  data/         the data folder, unless the storage setting names another
```

The environment variable `AUTOFILE_HOME` names a folder to use in place of `~/.autofile`, for example to run a separate Autofile for tests.

The data folder holds a folder for each type, `_types` and `_blobs`. `autofile` creates the data folder when it starts if the folder does not exist. Autofile reads only the files it could have written: `<key>.json` with a valid key in the folder of a declared type, `<type>.json` in `_types`, and `<hash>.<ext>` in `_blobs`. It ignores every other file and folder, such as `.DS_Store` or a temporary file left by a write that stopped part way. Autofile writes every record and type declaration as UTF-8 JSON, indented with two spaces and ending with a newline, so that a file opened directly is readable. A blob file holds the original bytes.

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
| `storage` | The data folder. `set` stores its absolute path. | `~/.autofile/data` |
| `http.host` | The address `autofile serve` listens on. | `127.0.0.1` |
| `http.port` | The port `autofile serve` listens on. | `7319` |
| `http.origins` | Browser origins `autofile serve` accepts besides those on localhost, given to `set` as one or more arguments, such as `autofile set http.origins http://rubot`. | none |

`config.json` holds the settings that are set:

```json
{ "storage": "/Users/rupert/Dropbox/Autofile", "http": { "port": 2366, "origins": ["http://rubot"] } }
```

Setting `storage` moves no files, so it can name a folder that already holds records. A running `autofile` process keeps the settings it started with, so a change applies to each client once it restarts Autofile, and to `autofile serve` once it is restarted.

### Serving over HTTP

`autofile serve` runs the same MCP server over the Streamable HTTP transport of MCP 2026-07-28, at the endpoint `/mcp`: with the defaults, `http://127.0.0.1:7319/mcp`. It serves the same tools and resources as stdio, with one difference: a blob field can be given a `data:` URI but not a path, as described in [Blobs](#blobs).

Autofile does not authenticate HTTP clients, so anything that can reach its address can read and write the store. It listens on `127.0.0.1` by default, as MCP advises for a local server. As MCP requires, it checks the `Origin` header of every request, so that a website open in a browser cannot reach a local Autofile by pointing its own domain at the local machine (DNS rebinding). A request with an `Origin` header is refused with HTTP 403 unless the origin is on localhost (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, with any port) or listed in `http.origins`. Requests without an `Origin` header, which clients other than browsers send, are not affected.

### Processes

Each MCP client over stdio starts its own `autofile` process, and a running `autofile serve` is one more process; all of them share the data folder. Each process reads the files it needs on every request and keeps no records in memory, so it always sees writes made by the others.

A process holds the write lock for the whole of each write, including the link removals and blob deletions that follow from it, so writes from different processes never overlap. A write waits while another process holds the lock. If a process stops while holding the lock, the next process that needs it takes it over within 10 seconds. Each file is written to a temporary file whose name starts with `.`, and then renamed into place, so a read never sees part of a file.

A write that changes several files makes its changes in an order that keeps the store valid if the process stops partway: a blob is stored before the record that holds it, links to a record are removed before the record is deleted, and blobs that no record holds are deleted last. A process that stops partway can therefore leave links removed from a record that still exists, which deleting the record again completes, or a blob that no record holds, which only takes space.

Each process watches the data folder and sends the change notices described in [Resources](#resources) for every change: those made by the process itself, by other `autofile` processes, and outside Autofile, such as a file restored from a backup.

The rules in [Links](#links) and [Blobs](#blobs) hold while every write goes through Autofile on one machine. A sync service that brings in writes from another machine can leave a link to a deleted record, or a blob field that holds a deleted blob.
