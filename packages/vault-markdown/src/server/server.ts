/**
 * The HTTP API, answered for a markdown vault. An identity is already a path,
 * so the URL space is the identity space: one segment is a collection, two or
 * more is an identity.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Blob, Fields, Record } from '@autofile/core';
import { splitIdentity } from '@autofile/core';

import {
  InvalidContentError,
  InvalidIdentityError,
  UnknownCollectionError,
  WrongContentError,
} from '../errors.ts';
import type { MarkdownVault } from '../vault.ts';

/** What every route answers to, and what an identity answers to besides. */
const READ_METHODS = ['GET', 'OPTIONS'];
const WRITE_METHODS = ['GET', 'PUT', 'DELETE', 'OPTIONS'];

/**
 * A server answering the API for `vault`, which it holds open across requests.
 * The caller starts it with `listen` and stops it with `close`: it is a plain
 * `http.Server`, so nothing here is a second vocabulary for those.
 */
export function createServer(vault: MarkdownVault): Server {
  return createHttpServer((request, response) => {
    // Nothing may be left unanswered: a request that got no response at all
    // would hang its client, and an unhandled rejection would end the process
    // that other clients are still talking to.
    handle(vault, request, response).catch(() => response.destroy());
  });
}

async function handle(
  vault: MarkdownVault,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // With no authentication this means any page a browser has open can read and
  // write the vault. That is a choice this server makes rather than something
  // the API asks for, and the point of serving JSON is a web app.
  response.setHeader('access-control-allow-origin', '*');

  const method = request.method ?? 'GET';

  try {
    const target = route(request.url ?? '');

    if (target.kind === 'invalid') {
      json(response, 400, { error: target.why });
      return;
    }

    const allowed = target.kind === 'identity' ? WRITE_METHODS : READ_METHODS;

    if (method === 'OPTIONS') {
      const requested = request.headers['access-control-request-headers'];
      response.writeHead(204, {
        'access-control-allow-methods': allowed.join(', '),
        'access-control-allow-headers': typeof requested === 'string' ? requested : '*',
      });
      response.end();
      return;
    }

    if (!allowed.includes(method)) {
      response.writeHead(405, { allow: allowed.join(', '), 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `${method} is not something this answers` }));
      return;
    }

    if (target.kind === 'vault') {
      json(response, 200, { collections: Object.values(vault.collections) });
      return;
    }

    if (target.kind === 'collection') {
      json(response, 200, { items: (await vault.list(target.name)).map(represent) });
      return;
    }

    if (method === 'PUT') {
      await write(vault, target.id, request, response);
      return;
    }

    if (method === 'DELETE') {
      await vault.remove(target.id);
      response.writeHead(204);
      response.end();
      return;
    }

    const found = await vault.get(target.id);
    if (found === null) {
      json(response, 404, { error: `nothing is filed at '${target.id}'` });
      return;
    }
    if (found.type === 'blob') {
      await send(response, found);
      return;
    }
    json(response, 200, represent(found));
  } catch (error) {
    fail(response, error);
  }
}

/**
 * What a request path names. The path is split on `/` first and each segment
 * decoded after: decoding the whole path first would let `%2F` invent a
 * boundary that was not in the request, and decoding after the identity was
 * checked would let `%2e%2e` pass a check it becomes `..` just too late for.
 */
type Target =
  | { kind: 'vault' }
  | { kind: 'collection'; name: string }
  | { kind: 'identity'; id: string }
  | { kind: 'invalid'; why: string };

function route(url: string): Target {
  // A query names nothing here, and the request target is otherwise the path.
  const path = url.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/')) return { kind: 'invalid', why: `'${url}' is not a path` };
  if (path === '/') return { kind: 'vault' };

  const segments: string[] = [];
  for (const segment of path.slice(1).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { kind: 'invalid', why: `'${segment}' is not percent-encoded` };
    }
    // A segment still holding a `/` once decoded names nothing.
    if (decoded.includes('/')) {
      return { kind: 'invalid', why: `'${segment}' decodes to a segment holding a slash` };
    }
    segments.push(decoded);
  }

  // One segment is a collection; two or more is an identity, since a key may
  // contain slashes.
  const joined = segments.join('/');
  return segments.length === 1
    ? { kind: 'collection', name: joined }
    : { kind: 'identity', id: joined };
}

/**
 * Creates or replaces what an identity names, and answers with it. What the
 * collection holds decides how the body is read, not `Content-Type` —
 * otherwise a `.json` file could never be a blob.
 */
async function write(
  vault: MarkdownVault,
  id: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // The collection is resolved here rather than left to `put`, because reading
  // the body at all depends on what it holds.
  const split = splitIdentity(id);
  if (split === null) {
    throw new InvalidIdentityError(id, 'it is not a collection and a key joined by a slash');
  }
  const collection = vault.collections[split.collection];
  if (collection === undefined) throw new UnknownCollectionError(split.collection);

  const body = await bytes(request);

  if (collection.type === 'blob') {
    // Nothing on the way in is recorded as a claim about the bytes: a blob's
    // media type is its key's to say.
    json(response, 200, represent(await vault.put(id, new globalThis.Blob([body]))));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new WrongContentError(id, 'record');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WrongContentError(id, 'record');
  }
  json(response, 200, represent(await vault.put(id, parsed as Fields)));
}

/** Everything a request carried, as the bytes it was sent as. */
async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A blob's bytes, with `Content-Type` from its media type and `Content-Length`
 * from its size, so it loads in a browser. The bytes are streamed rather than
 * read in: a vault can hold a video.
 */
async function send(response: ServerResponse, blob: Blob): Promise<void> {
  response.writeHead(200, {
    'content-type': blob.content.type,
    'content-length': String(blob.content.size),
  });
  await pipeline(Readable.fromWeb(blob.content.stream()), response);
}

/**
 * A record or a blob as JSON. A blob has no JSON representation, so what is
 * carried is what is known about one: asking about a single blob means asking
 * for it, and this is what a listing can say without the bytes.
 */
function represent(found: Record | Blob): unknown {
  return found.type === 'record'
    ? {
        type: 'record',
        id: found.id,
        fields: found.fields,
        created: found.created,
        updated: found.updated,
      }
    : {
        type: 'blob',
        id: found.id,
        content: { type: found.content.type, size: found.content.size },
        created: found.created,
        updated: found.updated,
      };
}

/**
 * What the vault refused, as a status. They are different answers rather than
 * one: a misspelled collection is not an empty shelf, and a vault holding what
 * it cannot represent is broken rather than asked something wrong.
 */
function fail(response: ServerResponse, error: unknown): void {
  // A blob that failed part-way through has already been answered `200`, and
  // the only way left to say it went wrong is to break the connection.
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof UnknownCollectionError) {
    json(response, 404, { error: error.message });
    return;
  }
  if (error instanceof InvalidIdentityError) {
    json(response, 400, { error: error.message });
    return;
  }
  if (error instanceof WrongContentError) {
    json(response, 415, { error: error.message });
    return;
  }
  if (error instanceof InvalidContentError) {
    // A key the vault cannot spell is the identity being wrong rather than the
    // record; anything else about it was understood and refused.
    const unspellable = error.findings.some((finding) => finding.rule === 'key');
    json(response, unspellable ? 400 : 422, {
      error: error.message,
      reasons: error.findings.map((finding) => finding.message),
    });
    return;
  }
  // A record the vault holds and cannot read — and anything else that went
  // wrong in here — is the vault being broken rather than the request, and how
  // to find out where is the vault's own business.
  json(response, 500, { error: error instanceof Error ? error.message : String(error) });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
