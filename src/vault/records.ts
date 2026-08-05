import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { VaultConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { MARKDOWN, compareBytewise, isHidden, isMissing, toPrefix } from './paths.ts';

interface RecordIdentity {
  /** The record's path from the vault root, without its `.md`. */
  identity: string;
  /** The key of the path entry that governs it, as the config writes it. */
  path: string;
}

/**
 * A record found in a listed path. A record whose header does not parse is
 * still a record — it carries the finding instead of its content, so callers
 * report it rather than losing sight of the file.
 *
 * `header` and `body` are absent rather than empty when the record has neither,
 * since both parts are optional and the rules turn on which are present.
 */
export type VaultRecord =
  | (RecordIdentity & { status: 'parsed'; header?: unknown; body?: string })
  | (RecordIdentity & { status: 'violation'; finding: Finding });

/**
 * Finds every record in the vault at `root`, in a deterministic order: sorted
 * by identity, byte by byte, so the config's key order never shows through and
 * two runs over an unchanged vault agree.
 *
 * Comparing identities rather than filenames is what puts `notes/a` before
 * `notes/a.b`; the `.md` suffix would sort the shorter name second.
 */
export async function findRecords(root: string, config: VaultConfig): Promise<VaultRecord[]> {
  const records: VaultRecord[] = [];
  for (const path of Object.keys(config.paths ?? {})) {
    records.push(...(await findRecordsAt(root, path)));
  }

  return records.sort((a, b) => compareBytewise(a.identity, b.identity));
}

/**
 * The records directly at one listed path. A path with nothing on disk yields
 * none: the vault rules do not require a listed path to exist, and reporting
 * the absence is the `empty` warning's job, not this one's.
 */
async function findRecordsAt(root: string, path: string): Promise<VaultRecord[]> {
  const prefix = toPrefix(path);
  if (prefix === undefined) return [];

  const folder = join(root, prefix);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    // A listed path that is a file rather than a folder throws ENOTDIR here, and
    // it means what an absent one means: no records. Anything else is a folder
    // that is there and cannot be read, which is not this function's to swallow.
    if (isMissing(error)) return [];
    throw error;
  }

  const records: VaultRecord[] = [];
  for (const name of names) {
    // A name that is nothing but the extension begins with a dot, so ignoring
    // hidden names is also what keeps a `.` or `..` out of the identity below.
    // With the prefix already read as one, the identity needs no second check.
    if (!name.endsWith(MARKDOWN) || isHidden(name)) continue;

    const identity = `${prefix}/${name.slice(0, -MARKDOWN.length)}`;

    let source: string;
    try {
      source = await readFile(join(folder, name), 'utf8');
    } catch (error) {
      // The vault is edited live, so a record that vanished mid-walk is skipped
      // rather than reported against a file that is no longer there.
      if (isMissing(error)) continue;
      records.push(violation(identity, path, error));
      continue;
    }
    records.push(toRecord(identity, path, source));
  }

  return records;
}

/** A record that is there but yields no content: it cannot be read, or its
 * header does not parse. Both are the same finding to a reader of the report. */
function violation(identity: string, path: string, error: unknown): VaultRecord {
  return {
    identity,
    path,
    status: 'violation',
    finding: {
      rule: 'parse',
      severity: 'violation',
      file: `${identity}${MARKDOWN}`,
      path,
      message: errorMessage(error),
    },
  };
}

/** Splits a record's source into its header and body, both optional. */
function toRecord(identity: string, path: string, source: string): VaultRecord {
  const { header, body } = split(source);

  let parsed: unknown;
  if (header !== undefined) {
    try {
      parsed = parse(header);
    } catch (error) {
      return violation(identity, path, error);
    }
  }

  const record: Extract<VaultRecord, { status: 'parsed' }> = { identity, path, status: 'parsed' };
  // An empty header parses to null and carries no structured data, so it counts
  // as no header at all.
  if (parsed !== null && parsed !== undefined) record.header = parsed;
  // Whitespace alone is not a body.
  if (body.trim() !== '') record.body = body;
  return record;
}

const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*(\r?\n|$)/m;

/**
 * A header runs from an opening `---` line to the next `---` line; everything
 * after that is the body, verbatim. Without a closing fence there is no header
 * and the whole file is the body, because a body may legitimately open with a
 * `---` thematic break.
 */
function split(source: string): { header?: string; body: string } {
  const opening = OPENING_FENCE.exec(source);
  if (opening === null) return { body: source };

  const rest = source.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  if (closing === null) return { body: source };

  return {
    header: rest.slice(0, closing.index),
    body: rest.slice(closing.index + closing[0].length),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
