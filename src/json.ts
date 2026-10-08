/** Shared compile-time types for the plain JSON crossing store boundaries. */

/** A scalar JSON value. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value representable in JSON. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** A JSON object with string keys. */
export interface JsonObject { [key: string]: JsonValue }
