# Autofile

Autofile makes it easy for agents to store information in a structured, unambiguous way, and makes that information available to the services and interfaces that want to use it and show it.

Autofile is designed for:

- **No ambiguity on input.** Every kind of information has one defined place and type, with clear instructions for how it is filed.
- **Efficient retrieval.** Agents find what they need by keyword search, by matching on typed properties, and by following links between records.
- **Shared access.** Agents and programs use the same records, types and attachments through MCP or the library.

Autofile is an [MCP](https://modelcontextprotocol.io) server and a library. Agents use its tools and resources; programs can embed the same store through the `Autofile` class.

## Install

Autofile needs Node.js 24 or later.

```sh
npm install -g @telepath-computer/autofile
```

This installs the `autofile` command.

## Connect an agent

An MCP client starts Autofile itself by running `autofile`, and talks to it over stdio. For Claude Code:

```sh
claude mcp add autofile --scope user -- autofile
```

For another client, add an MCP server whose command is `autofile`, with no arguments.

Autofile starts with no types. Ask your agent to file something: it proposes a type, such as `contact` with the fields a contact needs, and creates it once you agree. It then files records of that type, and finds them again by search, by field value, or by following links between records.

## Choose a store

Autofile uses a default store until the `storage` setting selects another. Changing that setting moves no records and takes effect when clients restart Autofile. See [storage configuration](spec/storage.md#folders) for the current implementation and [Commands](spec/index.md#commands) for other settings.

## Serve over HTTP

For clients that connect over HTTP, such as a web page, run:

```sh
autofile serve
```

This serves the same tools and resources at `http://127.0.0.1:7319/mcp` until stopped. Autofile does not authenticate HTTP clients: anything that can reach the address can read and change every record. It therefore listens only on this machine by default, and accepts requests from web pages only when they are served from this machine. [Serving over HTTP](spec/index.md#serving-over-http) explains how to change the address, the port, and the web pages it accepts.

## Use as a library

Install the package in your project with `npm install @telepath-computer/autofile`, then import the ES module:

```js
import { Autofile } from "@telepath-computer/autofile";

const store = new Autofile({ folder: "./records" });
try {
  const { records } = await store.records.find({ q: "dentist" });
  for (const record of records) console.log(record.title ?? record.uri);
} finally {
  await store.close();
}
```

The `folder` option is the path of a store in the current implementation; [Storage](spec/storage.md) describes its format. Importing starts no server or watcher, and construction does no I/O. The first operation initializes the store if needed. [Library API](spec/index.md#library-api) covers writing records, declaring types, blobs, change subscriptions and errors.

Record addresses use `autofile:///records/<type>/<key>`, type declarations use `autofile:///types/<name>`, and attachments use `autofile:///blobs/<hash>.<ext>`. Read and write through these addresses rather than opening stored files.

Upload an attachment before writing the record that holds it. `blobs.put(bytes, mediaType)` takes a `Uint8Array` and returns an address; put that address in a field marked `"format": "blob"` in the type schema. For an open store with a `document` type that declares `title` and `attachment` fields:

```js
const uri = await store.blobs.put(new TextEncoder().encode("Meeting notes"), "text/plain");
await store.records.create("document", { title: "Meeting notes", attachment: uri });
```

Attachments have no size limit. `blobs.stream(uri)` reads a large one without loading it into memory. MCP clients read attachments of up to 7 MiB with `resources/read`; a larger one is downloaded from `autofile serve` over HTTP, or read from the local file path that Autofile gives over stdio.

Records may share an attachment address. MCP clients use `upload_blob` with base64 bytes and a media type, or an absolute local file path over stdio, then put the returned address in the record. Record writes accept neither data URIs nor local paths in blob fields.

## Specification

[spec/index.md](spec/index.md) describes records, types, links, attachments, the MCP tools and resources, and the commands. [Storage](spec/storage.md) specifies the on-disk format, and [Implementation](spec/implementation.md) describes the code.

## Development

```sh
npm install
npm test
```

`npm test` builds Autofile and runs the tests.
