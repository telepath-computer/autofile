/**
 * Reading a vault's `autofile.yml`, and turning it into the collections the
 * vault answers with. Everything a config can get wrong is caught here, so a
 * vault that opens has collections that answer without reading anything further.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Collection } from '@autofile/core';
import ajvModule from 'ajv/dist/2020.js';
import type { ErrorObject, SchemaObject, ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

import { VaultConfigError } from './errors.ts';

// Both packages are CommonJS with `module.exports` set to the export itself, so
// Node's ESM interop hands back the class and the function. TypeScript can only
// see the declared namespace, hence the casts.
const Ajv2020 = ajvModule as unknown as typeof ajvModule.default;
const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;

/** The file a vault's config lives in, at the vault root. */
export const CONFIG_FILE = 'autofile.yml';

/**
 * A collection as this vault holds it: what the vault spec describes, plus the
 * one rule that is markdown's — whether records here may have a body, which is
 * a field of the file rather than of the model.
 */
export interface MarkdownCollection extends Collection {
  /** false forbids a body on records here. A body is allowed by default. */
  body?: boolean;
}

/**
 * The config document's own schema, stating in JSON Schema what the markdown
 * vault spec states in TypeScript. Unknown keys are rejected in the config and
 * in a collection both, so a misspelled key is a refusal rather than a setting
 * that silently does nothing.
 */
const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    collections: {
      type: 'object',
      // A collection's name is non-empty and contains no `/`, which is also
      // what keeps a name from spanning the slash an identity is split on.
      propertyNames: { type: 'string', pattern: '^[^/]+$' },
      additionalProperties: {
        type: 'object',
        properties: {
          type: { enum: ['record', 'blob'] },
          title: { type: 'string' },
          description: { type: 'string' },
          schema: { type: 'object' },
          body: { type: 'boolean' },
        },
        required: ['type'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

interface CollectionConfig {
  type: 'record' | 'blob';
  title?: string;
  description?: string;
  schema?: SchemaObject;
  body?: boolean;
}

interface Config {
  collections?: { [name: string]: CollectionConfig };
}

/** What a vault holds after reading its config. */
export interface VaultConfig {
  collections: { [name: string]: MarkdownCollection };
  /**
   * The compiled schema of each collection that declares one. Compiled here and
   * kept rather than recompiled where records are checked, since a second Ajv
   * could differ in dialect or in whether formats assert, and the vault would
   * then be checked against rules other than the ones it was opened under.
   */
  schemas: { [name: string]: ValidateFunction };
}

/**
 * Reads the config at a vault root and answers with its collections, by name.
 * Anything wrong with it is a `VaultConfigError`: there is no vault to talk to
 * either way, and a caller that cannot open one has nothing to do with a
 * distinction between the ways it failed.
 */
export async function readConfig(root: string): Promise<VaultConfig> {
  let source: string;
  try {
    source = await readFile(join(root, CONFIG_FILE), 'utf8');
  } catch (cause) {
    throw new VaultConfigError(`${CONFIG_FILE} cannot be read: ${message(cause)}`);
  }

  let document: unknown;
  try {
    document = parse(source);
  } catch (cause) {
    throw new VaultConfigError(`${CONFIG_FILE} does not parse as YAML: ${message(cause)}`);
  }

  // A fresh Ajv per vault: compiled schemas are cached by `$id`, so a shared
  // instance would let one vault's config collide with another's. Formats
  // assert, because a property declared `format: date` must hold a date.
  //
  // `strictTypes` and `strictTuples` are Ajv style heuristics that log against
  // schemas that are perfectly legal, and a config that conforms to the spec
  // must not make the tool complain. Ajv's other strict checks stay on, so a
  // misspelled keyword is an error rather than a rule that never fires.
  const ajv = addFormats(new Ajv2020({ allErrors: true, strictTypes: false, strictTuples: false }));

  if (!ajv.validate(CONFIG_SCHEMA, document)) {
    throw new VaultConfigError(
      `${CONFIG_FILE} is not a valid config: ${(ajv.errors ?? []).map(describe).join('; ')}`,
    );
  }

  const config = document as Config;
  const collections: { [name: string]: MarkdownCollection } = {};
  const schemas: { [name: string]: ValidateFunction } = {};
  let blobs: string | undefined;

  for (const [name, entry] of Object.entries(config.collections ?? {})) {
    if (entry.type === 'blob') {
      // Two blob collections would claim the same keys with no rule for which
      // wins, so the second is refused rather than shadowing the first.
      if (blobs !== undefined) {
        throw new VaultConfigError(
          `${CONFIG_FILE} declares two blob collections, '${blobs}' and '${name}'`,
        );
      }
      blobs = name;
    }

    if (entry.schema !== undefined) schemas[name] = compile(ajv, name, entry.schema);

    const collection: MarkdownCollection = { type: entry.type, name };
    if (entry.title !== undefined) collection.title = entry.title;
    if (entry.description !== undefined) collection.description = entry.description;
    if (entry.schema !== undefined) collection.schema = entry.schema;
    if (entry.body !== undefined) collection.body = entry.body;
    collections[name] = collection;
  }

  return { collections, schemas };
}

/**
 * Compiles a collection's schema, to know it is usable as one. A schema that
 * does not compile is refused rather than dropped, because a collection whose
 * rules silently never apply looks like a collection whose records all pass.
 */
function compile(
  ajv: InstanceType<typeof Ajv2020>,
  name: string,
  schema: SchemaObject,
): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (cause) {
    throw new VaultConfigError(
      `${CONFIG_FILE}: the schema of collection '${name}' is not usable as one: ${message(cause)}`,
    );
  }
}

/** What Ajv objected to, in terms of the document it was given. */
function describe(error: ErrorObject): string {
  const where = error.instancePath === '' ? '(root)' : error.instancePath;
  // Ajv leaves the offending key out of `message` for these two keywords, so it
  // is spliced in from `params`: a refusal has to say which key is wrong.
  switch (error.keyword) {
    case 'additionalProperties':
      return `${where}: unknown key '${error.params['additionalProperty']}'`;
    case 'propertyNames':
      return `${where}: invalid collection name '${error.params['propertyName']}'`;
    default:
      return `${where}: ${error.message}`;
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
