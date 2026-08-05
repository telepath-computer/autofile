import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import type { PathEntry, PathRules, VaultConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { MARKDOWN, compareBytewise, isHidden, isMissing, toPrefix } from './paths.ts';
import type { VaultRecord } from './records.ts';

/**
 * Checks records against the rules of the path that governs them, and warns
 * about the listed paths with nothing at them.
 *
 * The rules are the ones `loadConfig` compiled: compiling them again here could
 * differ in dialect or in whether formats assert, and the vault would be
 * checked against rules other than the ones its config was accepted under.
 */
export async function checkVault(
  root: string,
  config: VaultConfig,
  rules: Record<string, PathRules>,
  records: VaultRecord[],
): Promise<Finding[]> {
  const violations: Finding[] = [];

  for (const record of records) {
    if (record.status === 'violation') {
      // A record that could not be read has no header to check, so the parse
      // violation is the whole story and reporting more would double-report it.
      violations.push(record.finding);
      continue;
    }
    // A path listed with no entry at all is `null`, and one listed with an
    // empty entry is `{}`: neither carries rules, so both check as no rules.
    violations.push(
      ...checkRecord(record, config.paths?.[record.path] ?? {}, rules[record.path] ?? {}),
    );
  }

  // Violations first, then warnings. Each group arrives in the order fixed
  // above and below, and interleaving them would mean inventing an order across
  // two sorted lists; grouping also keeps what must be fixed — the findings a
  // caller's verdict turns on — from being read past.
  return [...violations, ...(await warnEmpty(root, config))];
}

function checkRecord(
  record: Extract<VaultRecord, { status: 'parsed' }>,
  entry: PathEntry,
  rules: PathRules,
): Finding[] {
  const violations: Finding[] = [];
  // The three rules a record that could be read can break; `parse` is the one
  // it cannot, and a record carrying that is never checked this far.
  const violation = (rule: 'schema' | 'filename' | 'body', message: string): Finding => ({
    rule,
    severity: 'violation',
    file: `${record.identity}${MARKDOWN}`,
    path: record.path,
    message,
  });

  // A record with no header carries no structured data, so it is checked as a
  // header with no properties rather than skipped: a required property is not
  // satisfied by there being no header to hold it.
  if (rules.schema !== undefined && !rules.schema(record.header ?? {})) {
    violations.push(violation('schema', describeFailure(rules.schema)));
  }

  // A filename schema is written against the name alone, without folders and
  // without the extension, so it is the slug that is checked.
  const slug = record.identity.slice(record.identity.lastIndexOf('/') + 1);
  if (rules.filename !== undefined && !rules.filename(slug)) {
    violations.push(violation('filename', describeFailure(rules.filename)));
  }

  // Whitespace alone is not a body, and findRecords has already dropped it, so
  // a record that has one here has one.
  if (entry.body === false && record.body !== undefined) {
    violations.push(violation('body', 'has a body where the path allows none'));
  }

  return violations;
}

const NOTHING_AT = 'nothing at this path';

/**
 * The listed paths with nothing at them, in a fixed order: sorted by path, byte
 * by byte, so the config's key order never shows through.
 *
 * An `empty` finding concerns a path rather than any record, so it names the
 * path entry alone.
 */
async function warnEmpty(root: string, config: VaultConfig): Promise<Finding[]> {
  const warnings: Finding[] = [];
  for (const path of Object.keys(config.paths ?? {}).sort(compareBytewise)) {
    if (await isEmpty(root, path)) {
      warnings.push({ rule: 'empty', severity: 'warning', path, message: NOTHING_AT });
    }
  }
  return warnings;
}

/**
 * Whether a listed path has nothing at it. Static files count as something:
 * they are filed into a path and retrieved by identity like records, so a path
 * of nothing but images has been filed into.
 */
async function isEmpty(root: string, path: string): Promise<boolean> {
  // A key naming nothing within the vault has nothing at it by definition, and
  // it is the same reading findRecords takes: what is warned about is exactly
  // what no record can come from.
  const prefix = toPrefix(path);
  if (prefix === undefined) return true;

  try {
    return (await readdir(join(root, prefix))).every(isHidden);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

/** What a validator objected to, in terms of the value it was given. */
function describeFailure(validate: ValidateFunction): string {
  return (validate.errors ?? []).map(describeError).join('; ');
}

function describeError(error: ErrorObject): string {
  // Ajv leaves the offending key out of `message` here, so it is spliced in
  // from `params`: a violation has to say which key is wrong.
  const message =
    error.keyword === 'additionalProperties'
      ? `unknown property '${error.params['additionalProperty']}'`
      : (error.message ?? 'is invalid');
  // An error against the value as a whole has no property to name, and a
  // filename never has one, so the location is prefixed only where there is one.
  return error.instancePath === '' ? message : `${error.instancePath}: ${message}`;
}
