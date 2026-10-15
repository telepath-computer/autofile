# Autofile implementation

This document records the implementation decisions for Autofile, as specified in [index.md](index.md): the stack, the libraries, how link and blob fields are found, the boundaries between parts of the code, and what the tests must cover. Anything it does not state is left to whoever builds Autofile.

## Stack

- TypeScript, as ES modules, on Node 24 or later. Tests use `node:test`.
- Autofile is published to npm as `@telepath-computer/autofile`, which provides the `autofile` command.

## Libraries

| Library | Used for |
| --- | --- |
| `@modelcontextprotocol/server` | The MCP server. This is version 2 of the MCP TypeScript SDK, which implements MCP 2026-07-28. |
| `@hyperjump/json-schema` and `@hyperjump/json-schema-errors` | Checking records against JSON Schema 2020-12, with readable messages saying why a record does not match, and reporting `format` annotations, which Autofile uses to find link and blob fields. Both are pinned to exact versions while the annotations API is marked experimental. |
| `mingo` | Matching `where` in `find_records` with the rules of MongoDB. |
| `chokidar` | Watching the data folder. |
| `proper-lockfile` | The write lock. Node has no built-in file lock, and the packages that provide one compile native code when they are installed; proper-lockfile is plain JavaScript. |

## Finding link and blob fields

Checking links, removing them, and copying blob files all need the location of each link and blob in a record. A schema can place those fields anywhere: in nested objects, in array items, or behind `$ref` or `anyOf`.

JSON Schema 2020-12 treats `format` as an annotation, which a validator can report for each value it applies to. Autofile asks hyperjump for the values in a record annotated with `"format": "uri"` or `"format": "blob"`, and gets their locations as JSON Pointers, such as `/employer` or `/attendees/0/contact`. Schemas are used as written; nothing is added to them.

The `blob` format accepts the URI of a blob and also the two forms a client writes, an absolute path and a `data:` URI. The blob fields of a record being written can therefore be found before any file is stored. After storing the files, Autofile checks that every blob field holds a blob URI.

Hyperjump annotates only a record that matches its schema, as the standard requires, and throws an error for any other record. For a record that does not match its type, Autofile searches the record for the URI as a string value instead, as [Links](index.md#links) and [Blobs](index.md#blobs) describe.

## Boundaries

The code is divided so that Autofile can later run as a daemon or as a remote service without being rewritten:

- The store, which reads and writes the data folder, takes and returns plain JSON and knows nothing of MCP.
- The MCP server is built by a function that knows nothing of the transport or the watcher. Serving over stdio, a socket or HTTP changes only how that function is called.
- Each process runs one watcher, shared by all of its clients. Every change notice comes from the watcher, including notices for writes the process made itself.

## Tests

- Protocol tests use MCP 2026-07-28.
- Store tests include several processes writing to one store at once.
- The built `autofile` command is tested over stdio, and `autofile serve` over HTTP.
