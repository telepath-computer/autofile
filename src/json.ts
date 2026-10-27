/** Shared JSON types and lossless input checks at the store boundary. */

import { isProxy } from "node:util/types";

const isRawJson = (JSON as JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

/** A scalar JSON value. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value representable in JSON. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** A JSON object with string keys. */
export interface JsonObject { [key: string]: JsonValue }

/** Returns why an input is not a plain JSON object, without calling getters or toJSON. */
export function jsonObjectProblem(value: unknown): string | undefined {
  if (isProxy(value)) return "JSON proxies are not supported";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "must be a JSON object";
  }
  return jsonValueProblem(value, "", new Set());
}

function jsonValueProblem(value: unknown, path: string, ancestors: Set<object>): string | undefined {
  const location = `JSON value at ${JSON.stringify(path || "/")}`;
  if (isProxy(value)) return `${location}: proxies are not supported`;
  if (isRawJson?.(value)) return `${location}: raw JSON fragments are not supported`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${location}: must be a finite number other than negative zero`;
  }
  if (typeof value !== "object") return `${location}: ${typeof value} is not supported`;

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return `${location}: must be a plain object or ordinary array`;
  }
  // Built-in prototypes can carry serialization hooks too. Check descriptors so
  // the JSON snapshot cannot invoke an inherited getter or rewrite the value.
  if (!Object.hasOwn(value, "toJSON")) {
    for (let parent = prototype; parent !== null; parent = Object.getPrototypeOf(parent)) {
      const descriptor = Object.getOwnPropertyDescriptor(parent, "toJSON");
      if (descriptor === undefined) continue;
      if (!("value" in descriptor) || typeof descriptor.value === "function") {
        return `${location}: inherited JSON serialization hooks are not supported`;
      }
      break;
    }
  }
  if (ancestors.has(value)) return `${location}: circular references are not supported`;
  const keys = Reflect.ownKeys(value);
  // Arrays serialize only their numbered elements. Inspect descriptors rather
  // than reading properties so getters and toJSON can never change the input.
  const length = isArray ? Object.getOwnPropertyDescriptor(value, "length")!.value as number : undefined;
  if (length !== undefined && keys.length !== length + 1) {
    return `${location}: arrays must be dense and have no extra properties`;
  }
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (typeof key === "symbol") return `${location}: symbol properties are not supported`;
      if (length !== undefined) {
        if (key === "length") continue;
        if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
          return `${location}: arrays must have no extra properties`;
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return `${location}: properties must be enumerable data properties`;
      }
      const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      const problem = jsonValueProblem(descriptor.value, childPath, ancestors);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}
