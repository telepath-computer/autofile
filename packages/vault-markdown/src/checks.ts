/**
 * The rules a record or a blob has to keep, as the findings it breaks. `put`
 * runs them over what it was handed and refuses what fails; `validate` runs the
 * same ones over what is on disk. One set rather than two, since a `put` that
 * accepted what `validate` then called a violation would write a vault that
 * fails its own check.
 *
 * `collision` is not here: it is about the whole vault rather than one key, so
 * only a walk over everything in it can find it.
 */

import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import type { MarkdownCollection } from './config.ts';
import type { Finding } from './findings.ts';
import type { Fields } from './model.ts';
import { BODY } from './records.ts';

/**
 * The longest a path segment may be, in bytes. 255 is what every filesystem a
 * vault is likely to sit on allows, and a key over it cannot be written at all.
 */
const NAME_LIMIT = 255;

/** Anything in the Unicode control category, which a filename should not carry. */
const CONTROL = /\p{Cc}/u;

/**
 * What is wrong with a key, if anything: a segment no file can have, a spelling
 * a filesystem would not give back the way it went in, or a name too long to
 * write. `suffix` is what the key gains on its way to a filename — `.md` for a
 * record — since that counts against the limit too.
 */
export function checkKey(collection: string, key: string, suffix: string): Finding[] {
  const wrong: string[] = [];
  const segments = key.split('/');

  // Each would resolve to something another key already names, or to something
  // outside the vault.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    wrong.push('has a segment that is empty, `.` or `..`');
  }
  // Two spellings of the same characters are one file on a filesystem that
  // normalises, and two identities to a vault that does not.
  if (key !== key.normalize('NFC')) wrong.push('is not in Unicode NFC');
  if (CONTROL.test(key)) wrong.push('holds a control character');
  if (
    segments.some(
      (segment, index) =>
        Buffer.byteLength(index === segments.length - 1 ? segment + suffix : segment, 'utf8') >
        NAME_LIMIT,
    )
  ) {
    wrong.push(`has a segment longer than ${NAME_LIMIT} bytes, which the filesystem cannot hold`);
  }

  if (wrong.length === 0) return [];
  return [violation('key', collection, key, `its key ${wrong.join(', ')}`)];
}

/**
 * What is wrong with a record's fields: a body its collection allows none of,
 * and whatever its schema objects to. A record with no fields is checked as
 * having none rather than skipped, since a required field is not satisfied by
 * there being no header to hold it.
 */
export function checkFields(
  collection: MarkdownCollection,
  key: string,
  fields: Fields,
  schema: ValidateFunction | undefined,
): Finding[] {
  const findings: Finding[] = [];

  if (collection.body === false && BODY in fields) {
    findings.push(
      violation('body', collection.name, key, 'it has a body where its collection allows none'),
    );
  } else if (BODY in fields && typeof fields[BODY] !== 'string') {
    // The region below the header is text, so a body of any other kind is
    // refused rather than written as whatever it happens to stringify to.
    findings.push(violation('body', collection.name, key, 'its body is not text'));
  }
  if (schema !== undefined && !schema(fields)) {
    findings.push(
      violation('schema', collection.name, key, (schema.errors ?? []).map(describe).join('; ')),
    );
  }

  return findings;
}

/** One thing found wanting, against the identity a collection and key name. */
export function violation(
  rule: string,
  collection: string,
  key: string,
  message: string,
): Finding {
  return { rule, severity: 'violation', id: `${collection}/${key}`, collection, message };
}

/** What a schema objected to, in terms of the fields it was given. */
function describe(error: ErrorObject): string {
  // Ajv leaves the offending key out of `message` here, so it is spliced in
  // from `params`: a violation has to say which field is wrong.
  const message =
    error.keyword === 'additionalProperties'
      ? `unknown field '${error.params['additionalProperty']}'`
      : (error.message ?? 'is invalid');
  // An objection to the fields as a whole names no field of its own.
  return error.instancePath === '' ? message : `${error.instancePath}: ${message}`;
}
