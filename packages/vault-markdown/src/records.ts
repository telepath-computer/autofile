/**
 * Turning a record's file into its fields: the YAML header, the body below it,
 * and the wikilinks in the header that are references.
 */

import type { Fields } from '@autofile/core';
import { isReference } from '@autofile/core';
import { parse, stringify } from 'yaml';

/** The extension that makes a file in a record collection a record. */
export const MARKDOWN = '.md';

/** The name of the field holding what sits below the header. */
export const BODY = 'body';

const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*(\r?\n|$)/m;

/**
 * The fields a record's file carries. Both parts are optional: a file with no
 * header has only a `body`, and one with nothing below the header has no
 * `body`.
 *
 * Throws when the header is there and yields no fields — the caller says which
 * record it was reading.
 */
export function readFields(source: string): Fields {
  const { header, body } = split(source);

  const fields: Fields = {};

  if (header !== undefined) {
    let document: unknown;
    try {
      document = parse(header);
    } catch (cause) {
      throw new Error(
        `its header does not parse as YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // An empty header parses to null and carries no fields, so it counts as no
    // header at all.
    if (document !== null && document !== undefined) {
      if (typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('its header is not a mapping, so it names no fields');
      }
      // The header's key order is kept, so a record fetched, changed and
      // written back comes out in the order it went in.
      for (const [name, value] of Object.entries(document)) fields[name] = dereference(value);
    }
  }

  // Whitespace alone is nothing. The body is not dereferenced: it is markdown,
  // and its links are markdown's.
  if (body.trim() !== '') fields[BODY] = body;

  return fields;
}

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

/**
 * The file a record's fields are written to: the header from every field but
 * `body`, and `body` as the region below it. The inverse of `readFields`, so a
 * record fetched, left alone and written back comes out byte for byte as it
 * went in.
 *
 * A record whose only field is `body` is written with no header, since a header
 * with no keys carries nothing; one with no `body` gets nothing below it.
 */
export function writeFields(fields: Fields): string {
  const header: Fields = {};
  let body = '';

  // The header's key order is the fields', and `body` is lifted out of it
  // wherever it sat: the region below the header is where it goes.
  for (const [name, value] of Object.entries(fields)) {
    if (name === BODY) body = value as string;
    else header[name] = enreference(value);
  }

  if (Object.keys(header).length === 0) return body;
  // Wrapping would rewrite a long value into lines it did not arrive in, so a
  // record written back would no longer match the one that was read.
  return `---\n${stringify(header, { lineWidth: 0 })}---\n${body}`;
}

/**
 * A whole value spelled `[[…]]` is a reference to the identity inside it. Only
 * a whole value converts, so a wikilink inside prose stays part of that prose,
 * and the brackets inside a wikilink are the identity's rather than a second
 * link's.
 */
const WIKILINK = /^\[\[([^[\]]+)\]\]$/;

/** Converts every wikilink in a field's value, at any depth. */
function dereference(value: unknown): unknown {
  if (typeof value === 'string') {
    const id = WIKILINK.exec(value)?.[1];
    return id === undefined ? value : { $ref: id };
  }
  if (Array.isArray(value)) return value.map(dereference);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, nested]) => [name, dereference(nested)]),
    );
  }
  return value;
}

/**
 * Converts every reference in a field's value back to a wikilink, at any depth.
 *
 * Only arrays and plain objects are walked into. Anything else goes to the YAML
 * writer whole, which knows how to spell a Date or a Map and would be handed an
 * empty mapping if this had taken one apart on the way past.
 */
function enreference(value: unknown): unknown {
  // Ahead of the object case below, which a reference would otherwise fall into
  // and come back out of as a mapping with a `$ref` key.
  if (isReference(value)) return `[[${value.$ref}]]`;
  if (Array.isArray(value)) return value.map(enreference);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, nested]) => [name, enreference(nested)]),
    );
  }
  return value;
}

/** Whether a value is an object holding named values and nothing more. */
function isPlainObject(value: unknown): value is { [name: string]: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
