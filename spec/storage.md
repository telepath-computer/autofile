# Autofile storage

This specification defines the on-disk format and behavior of the folder-based Autofile store: where data is kept, how it may be read and edited, and what happens during concurrent writes or interruptions. It is part of the Autofile specification alongside the [public interfaces](index.md). [Implementation](implementation.md) describes the code that implements it.

## Ownership

The data folder and its files belong to the user. They are ordinary files that can be read, backed up, copied, synchronized and edited with other programs. Autofile reads current data on each request rather than keeping a private copy of the records.

Programs using the library, MCP tools or HTTP interface work with records and types. They do not need this storage format. Programs that read or change the files directly must follow this specification and are responsible for keeping the data valid.

## Folders

`new Autofile({ folder })` takes the path of a data folder. Construction resolves the path without doing I/O. The first operation that needs the store creates the folder if necessary; concurrent operations wait for that setup.

The command keeps settings, the write lock and default data in `~/.autofile`:

```
~/.autofile/
  config.json   settings written by autofile set
  write.lock    exists while an Autofile process is writing
  data/         default data folder
```

`AUTOFILE_HOME` selects a different home directory. The CLI `storage` setting names the data folder and is saved as an absolute path. It defaults to `data` under the Autofile home. Changing it moves no files and applies when Autofile restarts.

`config.json` holds the settings that are set:

```json
{ "storage": "/Users/alex/Documents/Autofile", "http": { "port": 8080, "origins": ["https://app.example.com"] } }
```

The write lock remains under the Autofile home even when the data folder is elsewhere. Processes sharing a data folder must share that lock location. Library instances use the same `AUTOFILE_HOME` rule for their lock.

The data folder contains:

| Stored value | Location | Public address |
| --- | --- | --- |
| Record | `<type>/<key>.json` | `autofile:///<type>/<key>` |
| Type declaration | `_types/<type>.json` | `autofile:///_types/<type>` |
| Attachment | `_blobs/<hash>.<ext>` | `autofile:///_blobs/<hash>.<ext>` |

Type names and record keys follow the rules in [Types](index.md#types) and [Keys](index.md#keys). The `_types` and `_blobs` directories are reserved for Autofile.

These public addresses are unchanged from 0.3.0, so existing records and schemas need no migration. Clients keep and reuse them as opaque identifiers. The correspondence between addresses and locations in this table belongs to this storage implementation; other implementations need not use it.

## Stored values

Record files contain exactly `createdAt`, `updatedAt` and `value`. The value is a JSON object. Both timestamps are valid UTC times ending in `Z`, with whole seconds or three fractional digits:

```json
{
  "createdAt": "2026-10-07T09:14:00Z",
  "updatedAt": "2026-10-07T09:20:00Z",
  "value": { "name": "Priya Narayan" }
}
```

A type file contains only `description`, `schema` and optional `titleField`, as defined in [Types](index.md#types). Autofile writes both kinds of file as UTF-8 JSON without a byte-order mark, with two-space indentation and a final newline. Readers accept other JSON formatting. Record and type identity, record titles and validation problems are added when the class returns public values; they are not stored in these files. Resource JSON is serialized separately from the public values and does not preserve the stored text.

Blob files contain the original attachment bytes. Autofile names them using the 64-character lowercase hexadecimal SHA-256 hash of the bytes and, when known, a lowercase extension derived from the media type. The extension contains only letters, digits, underscores and hyphens; it is omitted when unknown. Equal contents with the same extension share one stored blob. Blob reads infer the media type from the extension, falling back to `application/octet-stream`. The current opaque attachment identifier is this filename; callers of the public interfaces must not interpret it.

Autofile recognizes only regular files in these locations with valid type names, record keys or blob names. Other entries, including temporary files, `.DS_Store`, symlinks and special files, are not records, declarations or stored attachments. Type deletion nevertheless requires the type directory to be empty or absent. Every entry blocks deletion, including unreadable records and unrelated files or directories. A non-directory entry at the type directory path also blocks deletion. The declaration is preserved and the refusal says "type still has stored data".

## Reads and direct edits

Each request reads the files it needs. Invalid JSON, invalid UTF-8 and malformed record envelopes become record or type problems without exposing the path. Queries and type updates report individual record read failures in their results; other unexpected storage failures throw a generic `Error` without the path or operating-system error. A value that does not match its schema can still be returned as an `AutofileRecord` with public `problems`.

Direct edits must preserve the record envelope, valid timestamps and the shape declared by the type. Writers outside Autofile are responsible for maintaining links and attachment references. Reads report storage and schema problems as specified in the [Library API](index.md#library-api); they do not check whether linked records or attachments still exist. Record writes perform those existence checks.

Recognized record and type changes made by other processes, direct edits or restored backups produce the same public change notices as writes through Autofile. A notice asks the client to read again and does not promise that the current value is valid. Changes to attachment files do not produce public notices.

Synchronizing files from another machine does not participate in the local write lock. Concurrent synchronized changes can overwrite one another or leave missing references. Copying a store while writes are in progress may capture different stages of a write that affects several files.

## Writes and recovery

A process holds the write lock for each complete write, including attachment uploads, link removal and blob cleanup. A competing write waits. A lock left by a stopped process can be taken over within 10 seconds. Each record, declaration or attachment is written to a temporary file whose name starts with `.`, then renamed into place, so readers see a complete value.

An upload stores the attachment before returning its URI; writing a record that holds it is a separate operation. Writes that affect several records remove incoming links before deleting a record and delete unheld blobs last. There is no transaction across several files. Interruption may leave removed links to a record that still exists, or unheld blobs taking space. Retrying deletion completes the former; unheld blobs are not listed as resources.

Attachment cleanup follows [Blobs](index.md#blobs) and considers only attachments the changed or deleted record previously held; it does not scan the blob folder for unused uploads. A record that cannot be read prevents cleanup, because Autofile cannot determine which attachments it holds. A record that does not match its schema conservatively holds every attachment URI string in its value.
