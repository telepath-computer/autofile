/** A field value pointing at an identity. */
export interface Reference {
  $ref: string;
}

/**
 * Whether a value is a reference. A reference may sit at any depth in a field's
 * value, so this answers about one value: a caller walking a value asks it of
 * each part.
 *
 * A reference is an object whose only key is a string `$ref` of its own. One
 * carrying anything alongside it is ordinary data rather than a reference,
 * since a form that dropped what it could not represent would lose it silently.
 * Not an array, which is one of the values a reference sits inside rather than
 * one itself, and not something that only inherits a `$ref` — fields come back
 * from a store as parsed data, where neither happens, so this is what the
 * answer is for everything else that reaches it.
 */
export function isReference(value: unknown): value is Reference {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, '$ref') &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  );
}
