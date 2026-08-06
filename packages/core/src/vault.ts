/**
 * The interface a vault implementation provides, and the shapes it answers in.
 * A consumer is written against this and works over any store: a folder of
 * markdown, a vault over HTTP, whatever comes next.
 */

import type { Finding } from './findings.ts';

export interface Vault {
  /** The vault's collections, by name. */
  collections: { [name: string]: Collection };

  /** The record or blob at an identity, or null if its collection has no such key. */
  get(id: string): Promise<Record | Blob | null>;
  /** A collection's items, ordered bytewise by key. */
  list(collection: string): Promise<(Record | Blob)[]>;
  /** Creates or replaces a record or blob. */
  put(id: string, content: Fields | globalThis.Blob): Promise<Record | Blob>;
  remove(id: string): Promise<void>;

  /** Everything in the vault that breaks its own rules. */
  validate(): Promise<Finding[]>;
}

export interface Collection {
  /** What the collection holds. */
  type: 'record' | 'blob';
  name: string;
  /** A human-readable name for the collection. */
  title?: string;
  /** What it contains and how to file into it. */
  description?: string;
  /** JSON Schema for the fields of records here. Record collections only. */
  schema?: object;
}

export interface Record {
  type: 'record';
  /** The record's identity. */
  id: string;
  fields: Fields;
  created: Date;
  updated: Date;
}

export interface Blob {
  type: 'blob';
  /** The blob's identity. */
  id: string;
  created: Date;
  updated: Date;
  /** The bytes: `size`, `type` for the media type, `stream()`, `arrayBuffer()`. */
  content: globalThis.Blob;
}

export interface Fields {
  [name: string]: unknown;
}
