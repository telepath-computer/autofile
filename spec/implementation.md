# Autofile implementation

This document records the code structure, libraries and tests that implement the [public interfaces](index.md) and the [storage specification](storage.md). It explains how schema annotations are used and where each part of the implementation belongs.

## Stack

- TypeScript, as ES modules, on Node 24 or later. Tests use `node:test`.
- Autofile is published to npm as `@telepath-computer/autofile`, which provides the `autofile` command and the ES module library entry point `dist/index.js`, with declarations at `dist/index.d.ts`. Package `exports` maps `.` to those files; importing the package starts no server or watcher.

## Libraries

| Library | Used for |
| --- | --- |
| `@modelcontextprotocol/server` | The MCP server. This is version 2 of the MCP TypeScript SDK, which implements MCP 2026-07-28. |
| `@hyperjump/json-schema` and `@hyperjump/json-schema-errors` | Checking records against JSON Schema 2020-12, with readable messages saying why a record does not match, and reporting `format` annotations, which Autofile uses to find link and blob fields. Both are pinned to exact versions while the annotations API is marked experimental. |
| `mingo` | Matching `where` in `find_records` with the rules of MongoDB. |
| `chokidar` | Watching the data folder. |
| `proper-lockfile` | The write lock. Node has no built-in file lock, and the packages that provide one compile native code when they are installed; proper-lockfile is plain JavaScript. |

## Finding link and blob fields

Checking links and attachments, and removing them, all need the location of each link and blob in a record. A schema can place those fields anywhere: in nested objects, in array items, or behind `$ref` or `anyOf`.

JSON Schema 2020-12 treats `format` as an annotation, which a validator can report for each value it applies to. Autofile asks hyperjump for the values in a record annotated with `"format": "uri"` or `"format": "blob"`, and gets their locations as JSON Pointers, such as `/employer` or `/attendees/0/contact`. Schemas are used as written; nothing is added to them.

The `blob` format recognizes attachment URIs. Record writes validate the value as supplied, then use the annotations to check that every attachment exists. Uploads are separate operations, so schema validation never has to interpret temporary byte inputs or choose which fields to convert.

Hyperjump annotates only a record that matches its schema, as the standard requires, and throws an error for any other record. For a record that does not match its type, Autofile searches the record for the URI as a string value instead, as [Links](index.md#links) and [Blobs](index.md#blobs) describe.

## Boundaries

The `Autofile` class is the store implementation. The command, MCP server and library callers all use it:

- `store.ts` implements `Autofile` and owns record and type operations, blob uploads and reads, initialization, coordination of writes and watcher lifetime. It enforces [Storage](storage.md). Schema and blob helpers support the class; adapters have no second path to stored data.
- `index.ts` exports the class, `AutofileError`, and the supporting TypeScript types. It imports no CLI or MCP server module.
- The MCP tool adapter translates class results into the existing tool shapes and converts `AutofileError.problems` into refusals. Class records include `type` and `key`; MCP records keep their existing fields and gain `title`. Searches support an absent type or a list of types on both interfaces.
- The resource adapter derives listings from public records and types. It reads attachments only through `blobs.stat` and `blobs.get`, and reads the bytes only of attachments within the inline limit. For a larger one it builds the error from `blobs.stat`: over HTTP with the relative blob URL, over stdio with the local path. Records and declarations are serialized from their public values with recursively sorted keys, two-space indentation and a final newline. No private snapshot metadata, symbols or file enumeration crosses the class boundary.
- The filesystem watcher is private implementation support. The class shares one watcher between subscribers and exposes `watch(onChange, { onError })`. The MCP notification adapter subscribes through that method, compares record and type metadata, and supplies exact resource and list-change notices. It performs focused reads after the initial scan.
- The MCP server is built independently of its transport. The CLI constructs the class for stdio or HTTP and closes it on shutdown. The upload adapter passes decoded base64 bytes and a media type to `blobs.put`, and streams an absolute local file path supplied over stdio to `blobs.putStream`, so a file of any size is stored without being held in memory. HTTP refuses paths. Record tools pass values to the class without attachment conversion.
- The HTTP server routes `/mcp` to the MCP transport and `/blobs/<hash>.<ext>` to a blob handler, after the same `Origin` and `Host` checks. The handler uses `blobs.stat` for the headers and `blobs.stream` for the body, so memory use does not grow with the size of the blob.

## Tests

- Protocol tests use MCP 2026-07-28.
- Library tests import the package entry point and cover lazy setup, record and type operations, cross-type queries, typed refusals, attachment uploads, shared references and cleanup, public validation problems and watch errors, schema preparation, subscriptions and closing.
- Store tests retain the existing integrity cases through the same adapters, including several processes writing to one store at once.
- MCP tests cover titles on records and optional or multiple search types, public resource serialization, no blob enumeration, transport-specific attachment inputs, and notifications for record and type addresses only.
- Blob tests cover attachments larger than the inline limit: creating and updating records that hold them through the library and MCP tools, the error over stdio and HTTP, the HTTP route with whole and partial downloads, `HEAD`, 404, 416, caching headers and the `Origin` and `Host` checks, and read-only blob files.
- The built `autofile` command is tested over stdio, and `autofile serve` over HTTP.
