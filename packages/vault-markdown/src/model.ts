/**
 * The shapes this vault holds in memory between the folder and the wire. What a
 * record or a blob looks like to a consumer is the HTTP API's to say; these are
 * what the program passes around on the way there.
 */

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
