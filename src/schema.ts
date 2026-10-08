/**
 * Registers and checks Autofile's JSON Schemas with the explicitly selected
 * 2020-12 dialect. The registry is process-global, so schemas are addressed by
 * content and compiled once even when several store instances read them.
 */

import { createHash } from "node:crypto";

import "@hyperjump/json-schema/formats";
import {
  InvalidSchemaError,
  registerSchema,
  setMetaSchemaOutputFormat,
  setShouldValidateFormat,
  unregisterSchema,
  validate,
  type Validator,
} from "@hyperjump/json-schema/draft-2020-12";
import { addFormat, setFormatHandler } from "@hyperjump/json-schema/experimental";
import { annotate, type Annotator } from "@hyperjump/json-schema/annotations/experimental";
import {
  annotatedWith,
  annotation,
  value as instanceValue,
} from "@hyperjump/json-schema/annotated-instance/experimental";
import { JSE, type ErrorObject, type JSEOutput } from "@hyperjump/json-schema-errors";

import type { JsonObject, JsonValue } from "./json.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const FORMAT_KEYWORD = "https://json-schema.org/keyword/draft-2020-12/format";
const BLOB_FORMAT = "https://autofile.dev/formats/blob";
const blobUriPattern = /^autofile:\/\/\/_blobs\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/u;
const knownFormats = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
  "blob",
]);
const schemaMapKeywords = ["$defs", "properties", "patternProperties", "dependentSchemas"];
const schemaArrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaKeywords = [
  "items",
  "contains",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "contentSchema",
];
const preparedSchemas = new Map<string, Promise<PreparedSchema>>();

setShouldValidateFormat(true);
// json-schema-errors augments the package root's TypeScript declarations, but
// the draft-specific entry point does not expose that augmentation.
setMetaSchemaOutputFormat(JSE as unknown as "FLAG");
addFormat({
  id: BLOB_FORMAT,
  // JSON Schema formats ignore other instance types. Autofile's separate
  // annotation check gives URI and blob values their stricter string rule.
  handler: (value) => typeof value !== "string" || blobUriPattern.test(value),
});
setFormatHandler(FORMAT_KEYWORD, "blob", BLOB_FORMAT);

/** A compiled schema that returns all readable validation problems. */
export interface PreparedSchema {
  validate(value: JsonValue): Promise<string[]>;
  formatFields(value: JsonValue, format: "uri" | "blob"): FormatField[];
}

/** One instance value reached by a schema's `format` annotation. */
export interface FormatField {
  pointer: string;
  location: string;
  value: JsonValue;
}

/** Checks that a declaration schema is safe, valid 2020-12 JSON Schema. */
export async function prepareSchema(schema: JsonObject): Promise<PreparedSchema> {
  const inspectionErrors = inspectSchema(schema);
  if (inspectionErrors.length > 0) throw new SchemaRefusal(inspectionErrors);

  const serialized = JSON.stringify(schema);
  const digest = createHash("sha256").update(serialized).digest("hex");
  const schemaUri = `https://autofile.dev/schemas/${digest}`;
  let prepared = preparedSchemas.get(schemaUri);
  if (prepared === undefined) {
    prepared = compileSchema(schema, schemaUri);
    preparedSchemas.set(schemaUri, prepared);
    prepared.catch(() => preparedSchemas.delete(schemaUri));
  }
  return prepared;
}

/** A user-correctable problem in a proposed schema declaration. */
export class SchemaRefusal extends Error {
  readonly messages: string[];

  constructor(messages: string[]) {
    super(messages.join("; "));
    this.name = "SchemaRefusal";
    this.messages = messages;
  }
}

async function compileSchema(schema: JsonObject, schemaUri: string): Promise<PreparedSchema> {
  let registered = false;
  try {
    registerSchema(schema, schemaUri, DIALECT);
    registered = true;
    const validator = await validate(schemaUri);
    const annotator = await annotate(schemaUri);
    return {
      validate: (value) => validateValue(validator, annotator, value),
      formatFields: (value, format) => findFormatFields(annotator, value, format),
    };
  } catch (error) {
    if (registered) unregisterSchema(schemaUri);
    if (error instanceof InvalidSchemaError) {
      const output = error.output as unknown as JSEOutput;
      throw new SchemaRefusal(formatErrors(output.valid ? [] : output.errors, "schema"));
    }
    throw new SchemaRefusal([
      error instanceof Error ? `schema: ${error.message}` : `schema: ${String(error)}`,
    ]);
  }
}

function findFormatFields(
  annotator: Annotator,
  value: JsonValue,
  format: "uri" | "blob",
): FormatField[] {
  const fields: FormatField[] = [];
  const annotated = annotator(value);
  for (const node of annotatedWith(annotated, "format", DIALECT)) {
    if (!annotation<string>(node, "format", DIALECT).includes(format)) continue;
    const pointer = node.pointer;
    fields.push({
      pointer,
      location: formatInstancePointer(pointer),
      value: instanceValue<JsonValue>(node),
    });
  }
  return fields;
}

async function validateValue(
  validator: Validator,
  annotator: Annotator,
  value: JsonValue,
): Promise<string[]> {
  const output = validator(value, {
    outputFormat: JSE as unknown as "FLAG",
  }) as unknown as JSEOutput;
  if (!output.valid) return formatErrors(output.errors, "");

  // JSON Schema deliberately ignores `format` for non-strings. Autofile's
  // field model is stricter: anything annotated as a URI or blob is a string.
  const annotated = annotator(value);
  const errors: string[] = [];
  for (const node of annotatedWith(annotated, "format", DIALECT)) {
    const formats = annotation<string>(node, "format", DIALECT);
    if (
      formats.some((format) => format === "uri" || format === "blob")
      && typeof instanceValue(node) !== "string"
    ) {
      const location = formatInstancePointer(node.pointer);
      errors.push(location === "" ? "must be a string" : `${location}: must be a string`);
    }
  }
  return errors;
}

function inspectSchema(schema: JsonObject): string[] {
  const errors: string[] = [];
  inspectSubschema(schema, "schema", errors, true, new WeakSet<object>());
  return errors;
}

function inspectSubschema(
  schema: JsonValue,
  location: string,
  errors: string[],
  isRoot: boolean,
  inspected: WeakSet<object>,
): void {
  if (!isObject(schema)) return;
  if (inspected.has(schema)) return;
  inspected.add(schema);

  if (schema.$schema !== undefined) {
    if (!isRoot) errors.push(`${location}.$schema: is only allowed at the schema root`);
    else if (schema.$schema !== DIALECT) {
      errors.push(`${location}.$schema: must name ${DIALECT}`);
    }
  }

  if (typeof schema.format === "string" && !knownFormats.has(schema.format)) {
    errors.push(`${location}.format: unknown format ${JSON.stringify(schema.format)}`);
  }
  for (const keyword of ["$ref", "$dynamicRef"]) {
    const reference = schema[keyword];
    if (
      typeof reference === "string"
      && reference !== ""
      && !reference.startsWith("#")
    ) {
      errors.push(`${location}.${keyword}: must point within this schema`);
    }
  }

  for (const keyword of schemaMapKeywords) {
    const schemas = schema[keyword];
    if (!isObject(schemas)) continue;
    for (const [name, subschema] of Object.entries(schemas)) {
      inspectSubschema(subschema, `${location}.${keyword}.${name}`, errors, false, inspected);
    }
  }
  for (const keyword of schemaArrayKeywords) {
    const schemas = schema[keyword];
    if (!Array.isArray(schemas)) continue;
    schemas.forEach((subschema, index) => {
      inspectSubschema(
        subschema,
        `${location}.${keyword}.${String(index)}`,
        errors,
        false,
        inspected,
      );
    });
  }
  for (const keyword of schemaKeywords) {
    if (schema[keyword] !== undefined) {
      inspectSubschema(schema[keyword], `${location}.${keyword}`, errors, false, inspected);
    }
  }
}

function formatErrors(errors: ErrorObject[], prefix: string): string[] {
  return errors.map((error) => {
    const location = formatInstanceLocation(error.instanceLocation);
    const path = [prefix, location].filter((part) => part !== "").join(".");
    const message = error.message.length === 0
      ? "does not match the schema"
      : `${error.message[0]?.toLowerCase() ?? ""}${error.message.slice(1)}`;
    return path === "" ? message : `${path}: ${message}`;
  });
}

function formatInstanceLocation(location: string): string {
  const hash = location.indexOf("#");
  const fragment = hash === -1 ? location : location.slice(hash + 1);
  if (fragment === "" || fragment === "/") return "";
  const pointer = decodeURIComponent(fragment).replace(/^\//u, "");
  return pointer
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function formatInstancePointer(pointer: string): string {
  if (pointer === "") return "";
  const parts = pointer.slice(1).split("/");
  if (parts.some((part) => part === "")) return pointer;
  return parts
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
