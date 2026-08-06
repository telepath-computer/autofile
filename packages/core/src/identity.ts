/**
 * An identity is a collection and a key joined by a slash, and every operation
 * on a vault starts by taking one apart. The rule lives here rather than in
 * each store, since two stores disagreeing about where the collection ends
 * would file the same identity in two places.
 */

/**
 * The collection and key an identity names, or null when the string is not
 * spelled as one. The collection is everything before the first slash and the
 * key is everything after it, and both have to be non-empty: a collection on
 * its own is not an identity. Null rather than a throw, so a caller reports it
 * in whatever vocabulary it answers in.
 *
 * Both come back exactly as they were given. A key is a string rather than a
 * path, so nothing is rejected for the shape of its segments and nothing is
 * trimmed, case-folded, normalised or unescaped on the way through — a store
 * that keeps keys as file paths says what it will not accept, and a consumer
 * holding an identity escaped unescapes it before there is one to split.
 */
export function splitIdentity(id: string): { collection: string; key: string } | null {
  const slash = id.indexOf('/');
  if (slash === -1) return null;

  const collection = id.slice(0, slash);
  const key = id.slice(slash + 1);
  // Taking everything before the first slash already gives a collection name
  // with no `/` in it; non-empty is the rest of the rule.
  if (collection === '' || key === '') return null;

  return { collection, key };
}
