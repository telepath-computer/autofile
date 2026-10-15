# Autofile

Autofile makes it easy for agents to store information in a structured, unambiguous way, and makes that information available to the services and interfaces that want to use it and show it.

Autofile is designed for:

- **No ambiguity on input.** Every kind of information has one defined place and type, with clear instructions for how it is filed.
- **Efficient retrieval.** Agents find what they need by keyword search, by matching on typed properties, and by following links between records.
- **Plain files, no lock-in.** Records are JSON files you own, and any agent, MCP server or interface can read, use and show them.

Autofile is an [MCP](https://modelcontextprotocol.io) server. Agents use it through the tools and resources it serves.

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

## Where records are kept

Autofile keeps records in `~/.autofile/data`, as one JSON file per record in a folder for each type:

```
~/.autofile/data/
  _types/contact.json          the declaration of the type contact
  contact/priya-narayan.json   a record of that type
  _blobs/9f86d081…0a08.pdf     a file stored with a record
```

The files are plain JSON, so you can read them, back them up, or edit them by hand. To keep them in another folder:

```sh
autofile set storage ~/Documents/Autofile
```

Setting `storage` moves no files. Clients use the new folder the next time they start Autofile, and `autofile serve` once it is restarted. [Commands](spec/index.md#commands) lists the other settings.

## Serve over HTTP

For clients that connect over HTTP, such as a web page, run:

```sh
autofile serve
```

This serves the same tools and resources at `http://127.0.0.1:7319/mcp` until stopped. Autofile does not authenticate HTTP clients: anything that can reach the address can read and change every record. It therefore listens only on this machine by default, and accepts requests from web pages only when they are served from this machine. [Serving over HTTP](spec/index.md#serving-over-http) explains how to change the address, the port, and the web pages it accepts.

## Specification

[spec/index.md](spec/index.md) describes Autofile in full: records, types, links, stored files, the MCP tools and resources, and the commands.

## Development

```sh
npm install
npm test
```

`npm test` builds Autofile and runs the tests.
