/**
 * A vault kept as a folder of markdown files. Records are `.md` files in a
 * folder named for their collection; every other file in the vault is a blob,
 * whose key is its path from the vault root.
 */

import { openAsBlob } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { ValidateFunction } from 'ajv/dist/2020.js';

import { checkFields, checkKey, violation } from './checks.ts';
import { type MarkdownCollection, type VaultConfig, readConfig } from './config.ts';
import {
  InvalidContentError,
  InvalidIdentityError,
  NotFoundError,
  RecordParseError,
  UnknownCollectionError,
  WrongContentError,
} from './errors.ts';
import type { Finding } from './findings.ts';
import { splitIdentity } from './identity.ts';
import { mediaType } from './media.ts';
import type { Blob, Fields, Record } from './model.ts';
import { MARKDOWN, readFields, writeFields } from './records.ts';

export class MarkdownVault {
  readonly root: string;
  readonly collections: { [name: string]: MarkdownCollection };

  /** Each collection's compiled schema, as `open` compiled it. */
  readonly #schemas: { [name: string]: ValidateFunction };

  private constructor(root: string, config: VaultConfig) {
    this.root = root;
    this.collections = config.collections;
    this.#schemas = config.schemas;
  }

  /**
   * Opens the vault rooted at `root`, reading its `autofile.yml`, checking it,
   * and compiling each collection's schema. A vault is its config as it was
   * read: one edited underneath an open vault takes effect on the next `open`.
   */
  static async open(root: string): Promise<MarkdownVault> {
    return new MarkdownVault(root, await readConfig(root));
  }

  async get(id: string): Promise<Record | Blob | null> {
    const { collection, key } = this.#resolve(id);

    if (collection.type === 'record') {
      const file = join(this.root, collection.name, `${key}${MARKDOWN}`);
      const stats = await statFile(file);
      if (stats === null) return null;
      return await readRecord(id, file, stats);
    }

    // The partition is one rule: a `.md` file in a record collection is a
    // record, so the blob collection does not also hold it under its path.
    if (isRecordFile(this.collections, key)) return null;

    const file = join(this.root, key);
    const stats = await statFile(file);
    if (stats === null) return null;
    return await readBlob(id, key, file, stats);
  }

  async list(collection: string): Promise<(Record | Blob)[]> {
    const declared = this.collections[collection];
    if (declared === undefined) throw new UnknownCollectionError(collection);

    const items: (Record | Blob)[] = [];
    for (const { key, file, stats } of await this.#entries(declared)) {
      // A key the vault would refuse is one it does not hold: `..md` names the
      // key `.`, which `get` rejects rather than answering about. What is on
      // disk is `validate`'s to report.
      if (!isKey(key)) continue;
      const id = `${collection}/${key}`;
      items.push(
        declared.type === 'record'
          ? await readRecord(id, file, stats)
          : await readBlob(id, key, file, stats),
      );
    }
    return items;
  }

  async put(id: string, content: Fields | globalThis.Blob): Promise<Record | Blob> {
    const { collection, key } = this.#resolve(id);

    // What the collection holds decides how the content is read, so content of
    // the other kind is refused rather than guessed at.
    const bytes = content instanceof globalThis.Blob;
    if (bytes !== (collection.type === 'blob')) {
      throw new WrongContentError(id, collection.type);
    }

    // The rules `validate` reports on, run before anything is written: a `put`
    // that accepted what `validate` calls a violation would leave a vault that
    // fails its own check.
    const findings = [
      ...checkKey(collection.name, key, collection.type === 'record' ? MARKDOWN : ''),
      ...(collection.type === 'record'
        ? checkFields(collection, key, content as Fields, this.#schemas[collection.name])
        : []),
    ];
    if (findings.length > 0) throw new InvalidContentError(id, findings);

    if (collection.type === 'record') {
      const file = join(this.root, collection.name, `${key}${MARKDOWN}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, writeFields(content as Fields));
      // The answer is what the vault now holds rather than what it was handed,
      // so `put` and a `get` after it say the same thing.
      return await readRecord(id, file, await stat(file));
    }

    // A `.md` file in a record collection is a record, so the blob collection
    // cannot file one there: `get` would answer null for what was just written.
    if (isRecordFile(this.collections, key)) {
      throw new InvalidIdentityError(id, "its key is a record's file");
    }

    const file = join(this.root, key);
    await mkdir(dirname(file), { recursive: true });
    // The media type is the extension's to say, so `content.type` is not stored.
    await writeFile(file, new Uint8Array(await (content as globalThis.Blob).arrayBuffer()));
    return await readBlob(id, key, file, await stat(file));
  }

  async remove(id: string): Promise<void> {
    const { collection, key } = this.#resolve(id);

    // A `.md` file in a record collection is a record, so the blob collection
    // does not hold it: there is nothing at this identity to remove.
    if (collection.type === 'blob' && isRecordFile(this.collections, key)) {
      throw new NotFoundError(id);
    }

    const file =
      collection.type === 'record'
        ? join(this.root, collection.name, `${key}${MARKDOWN}`)
        : join(this.root, key);

    // Removing what is not there is an error, rather than answering differently
    // from `get` about the same absence.
    if ((await statFile(file)) === null) throw new NotFoundError(id);
    await unlink(file);

    // Then any parent folder the file leaves empty, stopping at a collection's
    // own folder and at the vault root — both mean something, and an empty one
    // is a vault that has changed shape rather than one that has been tidied.
    let folder = dirname(file);
    while (folder !== this.root && !this.#isCollectionFolder(folder)) {
      try {
        await rmdir(folder);
      } catch {
        // Not empty, gone already, or not ours to remove: either way there is
        // nothing above it to prune.
        return;
      }
      folder = dirname(folder);
    }
  }

  async validate(): Promise<Finding[]> {
    const violations: Finding[] = [];
    const warnings: Finding[] = [];

    // Bytewise by name, so the config's key order never shows through and two
    // runs over an unchanged folder answer the same thing.
    const declared = Object.values(this.collections).sort((a, b) =>
      compareBytewise(a.name, b.name),
    );

    // Every collection is walked before anything is reported, because a
    // collision is over the whole vault: records and blobs share one tree, so a
    // record's file can collide with a blob's.
    const found = new Map<string, { key: string; file: string; stats: Stats }[]>();
    for (const collection of declared) found.set(collection.name, await this.#entries(collection));
    const collided = collisions(this.collections, found);

    for (const collection of declared) {
      const name = collection.name;
      const entries = found.get(name) ?? [];

      if (entries.length === 0) {
        // Legitimate when a collection is declared before anything is filed
        // into it, and indistinguishable from a mistyped name otherwise.
        warnings.push({
          rule: 'empty',
          severity: 'warning',
          collection: name,
          message: 'nothing is filed into it',
        });
        continue;
      }

      for (const { key, file } of entries) {
        violations.push(...checkKey(name, key, collection.type === 'record' ? MARKDOWN : ''));

        const others = collided.get(`${name}/${key}`);
        if (others !== undefined) {
          const which = others.map((other) => `'${other}'`).join(', ');
          violations.push(
            violation('collision', name, key, `its file differs only by case from ${which}`),
          );
        }

        if (collection.type === 'blob') continue;

        let fields: Fields;
        try {
          fields = readFields(await readFile(file, 'utf8'));
        } catch (cause) {
          // A record that could not be read has no fields to check against the
          // rest of the rules, so this is the whole story about it.
          violations.push(violation('parse', name, key, describe(cause)));
          continue;
        }
        violations.push(...checkFields(collection, key, fields, this.#schemas[name]));
      }
    }

    // Violations first: grouping keeps what must be fixed — the findings a
    // caller's verdict turns on — from being read past, and interleaving would
    // mean inventing an order across two already-ordered lists.
    return [...violations, ...warnings];
  }

  /**
   * Every file a collection holds, as its key and the file it is in, ordered
   * bytewise by key so the answer depends on the vault alone and not on the
   * order the filesystem walked it in.
   *
   * Keys the vault would refuse are among them: `list` leaves those out and
   * `validate` reports them, and neither could if they were dropped here.
   */
  async #entries(
    declared: MarkdownCollection,
  ): Promise<{ key: string; file: string; stats: Stats }[]> {
    // A record collection is a folder at the vault root; the blob collection is
    // not a folder of its own, and its keys are paths from the root.
    const folder = declared.type === 'record' ? join(this.root, declared.name) : this.root;
    const found: { key: string; file: string; stats: Stats }[] = [];

    for (const { path, stats } of await walk(folder)) {
      const file = join(folder, path);
      if (declared.type === 'record') {
        if (!path.endsWith(MARKDOWN)) continue;
        found.push({ key: path.slice(0, -MARKDOWN.length), file, stats });
      } else {
        // The partition is one rule: a `.md` file in a record collection is a
        // record, so the blob collection does not also hold it under its path.
        if (isRecordFile(this.collections, path)) continue;
        found.push({ key: path, file, stats });
      }
    }

    found.sort((a, b) => compareBytewise(a.key, b.key));
    return found;
  }

  /**
   * Whether a folder is a record collection's own. The blob collection has
   * none — its keys are paths from the root — so a folder sharing its name is
   * an ordinary folder.
   */
  #isCollectionFolder(folder: string): boolean {
    return dirname(folder) === this.root && this.collections[basename(folder)]?.type === 'record';
  }

  /**
   * The collection an identity names and the key within it. Throws rather than
   * answering with absence: a misspelled identity and a misspelled collection
   * are each a different answer from a key the collection does not hold.
   */
  #resolve(id: string): { collection: MarkdownCollection; key: string } {
    const split = splitIdentity(id);
    if (split === null) {
      throw new InvalidIdentityError(id, 'it is not a collection and a key joined by a slash');
    }

    // A key becomes a path here, so a segment that is not a name a file can
    // have is refused: each would resolve to something another key already
    // names, or to something outside the vault.
    if (!isKey(split.key)) {
      throw new InvalidIdentityError(id, 'a segment of its key is not a name a file can have');
    }

    const collection = this.collections[split.collection];
    if (collection === undefined) throw new UnknownCollectionError(split.collection);

    return { collection, key: split.key };
  }
}

/**
 * The identities whose files differ from another's only by case, each mapped to
 * the others it would be one file with on a filesystem that does not tell them
 * apart. An identity with no such twin is not in the map at all.
 *
 * What is folded is the file each identity claims rather than its key: a
 * record's is its key under its collection's folder with `.md` on the end, a
 * blob's is its key from the root. So the whole vault is one namespace here,
 * which is the one the filesystem holds it in.
 */
function collisions(
  collections: { [name: string]: MarkdownCollection },
  entries: Map<string, { key: string }[]>,
): Map<string, string[]> {
  const folded = new Map<string, string[]>();
  for (const [name, found] of entries) {
    const record = collections[name]?.type === 'record';
    for (const { key } of found) {
      const fold = (record ? `${name}/${key}${MARKDOWN}` : key).toLowerCase();
      folded.set(fold, [...(folded.get(fold) ?? []), `${name}/${key}`]);
    }
  }

  const collided = new Map<string, string[]>();
  for (const group of folded.values()) {
    if (group.length < 2) continue;
    for (const id of group) collided.set(id, group.filter((other) => other !== id));
  }
  return collided;
}

/**
 * Whether a key is one this vault can hold. A key becomes a path here, so no
 * segment may be empty, `.` or `..` — each would resolve to something another
 * key already names, or to something outside the vault.
 */
function isKey(key: string): boolean {
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function readRecord(id: string, file: string, stats: Stats): Promise<Record> {
  let fields: Fields;
  try {
    fields = readFields(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new RecordParseError(id, describe(cause));
  }
  return { type: 'record', id, fields, created: stats.ctime, updated: stats.mtime };
}

async function readBlob(id: string, key: string, file: string, stats: Stats): Promise<Blob> {
  return {
    type: 'blob',
    id,
    created: stats.ctime,
    updated: stats.mtime,
    content: await openAsBlob(file, { type: mediaType(key) }),
  };
}

/**
 * Every file under a folder, as paths relative to it. A folder that is not
 * there, or is not a folder, holds no files: a declared collection need not
 * exist, and saying so is `validate`'s job rather than this one's.
 *
 * What is not a file is left out — a folder, a socket, a symlink to a folder —
 * so what comes back is what a record or a blob can be read from.
 */
async function walk(folder: string): Promise<{ path: string; stats: Stats }[]> {
  let entries;
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw cause;
  }

  const found: { path: string; stats: Stats }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const file = join(entry.parentPath, entry.name);
    // Symlinks are followed wherever they lead, so what they point at decides.
    const stats = await statFile(file);
    if (stats === null) continue;
    // Keys are spelled with slashes whatever the platform writes paths with.
    found.push({ path: relative(folder, file).split(sep).join('/'), stats });
  }
  return found;
}

/**
 * Whether a path from the vault root is a record's file: a `.md` file inside
 * the folder of a record collection. A file at the root is in no collection's
 * folder, so it is not one.
 */
function isRecordFile(collections: { [name: string]: MarkdownCollection }, path: string): boolean {
  const slash = path.indexOf('/');
  if (slash === -1 || !path.endsWith(MARKDOWN)) return false;
  return collections[path.slice(0, slash)]?.type === 'record';
}

/** A file's stats, or null when there is no file there — absent, or not one. */
async function statFile(path: string): Promise<Stats | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats : null;
  } catch (cause) {
    // ENOTDIR is a key whose folders are a file: nothing is there either.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw cause;
  }
}

/**
 * Orders two keys byte by byte, so what a listing answers depends on the vault
 * alone and not on the locale it ran in.
 */
function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
