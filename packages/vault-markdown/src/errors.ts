/**
 * What can go wrong here, as classes rather than messages. A consumer maps a
 * vault's errors onto its own vocabulary — an HTTP status, an exit code — and
 * each of these is a different answer, so telling them apart must not mean
 * reading English out of a message.
 */

import type { Finding } from './findings.ts';

/**
 * The vault could not be opened: its `autofile.yml` cannot be read, does not
 * parse, is not a valid config, or describes collections this vault cannot
 * serve. One class for all of them, because the answer to every one is the
 * same — there is no vault here to talk to.
 */
export class VaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConfigError';
  }
}

/**
 * A collection the vault does not declare. Kept apart from an absent record,
 * because reporting both as absence would make a misspelled collection look
 * like ordinary emptiness.
 */
export class UnknownCollectionError extends Error {
  readonly collection: string;

  constructor(collection: string) {
    super(`no collection named '${collection}'`);
    this.name = 'UnknownCollectionError';
    this.collection = collection;
  }
}

/**
 * Nothing is filed at an identity the caller expected something at. `get`
 * answers null for the same absence, since a caller asking what is there has
 * somewhere to put the answer; a caller telling the vault to remove something
 * has not, and would otherwise not be told it removed nothing.
 */
export class NotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`nothing is filed at '${id}'`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/**
 * A string that is not spelled as an identity this vault can hold: not a
 * collection and a key joined by a slash, or a key with a segment no file can
 * have. Nothing is trimmed or normalised to make one fit, so the caller is told
 * rather than answered about some other identity.
 */
export class InvalidIdentityError extends Error {
  readonly id: string;

  constructor(id: string, why: string) {
    super(`'${id}' is not an identity: ${why}`);
    this.name = 'InvalidIdentityError';
    this.id = id;
  }
}

/**
 * Content the vault will not hold: a key it cannot write, or fields that break
 * the collection's rules. Refused before anything is written, since a `put`
 * that wrote it would leave a vault that fails its own `validate`.
 */
export class InvalidContentError extends Error {
  readonly id: string;
  /** What it broke, in the terms `validate` reports in. */
  readonly findings: Finding[];

  constructor(id: string, findings: Finding[]) {
    super(`${id} cannot be written: ${findings.map((finding) => finding.message).join('; ')}`);
    this.name = 'InvalidContentError';
    this.id = id;
    this.findings = findings;
  }
}

/**
 * Fields offered to a collection that holds blobs, or bytes offered to one that
 * holds records. What a collection holds decides how content is read, so this
 * is a refusal rather than a guess at which the caller meant.
 */
export class WrongContentError extends Error {
  readonly id: string;

  constructor(id: string, holds: 'record' | 'blob') {
    super(`${id} is in a collection that holds ${holds}s, and was given the other`);
    this.name = 'WrongContentError';
    this.id = id;
  }
}

/**
 * A record that is there and cannot be read: its file, or its header. Not the
 * same answer as `null`, which means the collection holds no such key — a file
 * that is there but broken is not an absent record, and answering that way
 * would hide a damaged vault behind an ordinary miss.
 */
export class RecordParseError extends Error {
  readonly id: string;

  constructor(id: string, why: string) {
    super(`${id} cannot be read: ${why}`);
    this.name = 'RecordParseError';
    this.id = id;
  }
}
