/**
 * The vault rules about names: what a path key names, what an identity is
 * spelled like, and what is ignored. Finding records and checking a vault both
 * walk the same folders and have to agree about them down to the letter, so
 * they read these rules from here rather than each holding its own copy — a
 * rule that changed in one and not the other would be records nothing reports.
 */

/** The extension that makes a file in a listed path a record. */
export const MARKDOWN = '.md';

/** Files and folders whose name begins with a dot are ignored. */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Whether a value is spelled as an identity: no leading `/`, and no `.` or `..`
 * segments. Symlinks are not a way out of the vault, so they are followed
 * wherever they lead; a `..` in the spelling is, so it is not.
 */
function isIdentity(value: string): boolean {
  const segments = value.split('/');
  return !value.startsWith('/') && !segments.includes('.') && !segments.includes('..');
}

/**
 * The folder a path entry's key names, relative to the vault root, or undefined
 * when the key names nothing within the vault.
 *
 * Path entry keys are literal paths written from the vault root, so the key's
 * leading `/` is the root itself rather than the filesystem's. A key naming no
 * path at all, one spelled out of the vault, or one naming a folder the rules
 * ignore names nothing — and following it out of the vault, or into a folder
 * nothing in is a record, is not the alternative. The config schema rejects
 * every such key, but neither walker assumes its config came through
 * `loadConfig`.
 */
export function toPrefix(key: string): string | undefined {
  const prefix = key.replace(/^\//, '').replace(/\/+$/, '');
  if (prefix === '' || !isIdentity(prefix)) return undefined;
  if (prefix.split('/').some(isHidden)) return undefined;
  return prefix;
}

/** Whether an fs error means the target is not there — vanished, or never was. */
export function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Orders two names byte by byte, so what a run reports depends on the vault
 * alone and not on the locale it ran in.
 */
export function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
