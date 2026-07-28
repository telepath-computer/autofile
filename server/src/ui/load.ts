/**
 * Fetching: the address bar is the query. The UI reads a path, asks the server
 * for that exact path as JSON, and hands the result to the renderer. One page
 * per fetch; nothing is held between them.
 */

import { renderErrorResponse, renderRequestFailure, renderValue } from "./render.js";

/** Where to fetch from: the serving origin in a build, a running server in dev. */
export function serverOrigin(): string {
  return import.meta.env.VITE_SERVER_ORIGIN ?? location.origin;
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Fetch `origin + path` as JSON and render it. Always resolves: every failure
 * is a rendered state, never a rejection and never a blank page.
 */
export async function loadView(
  origin: string,
  path: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Node> {
  let response: Response;
  try {
    response = await fetchImpl(origin + path, {
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    return renderRequestFailure(path, failureMessage(cause));
  }

  let body: unknown = null;
  let bodyFailure: string | null = null;
  try {
    body = await response.json();
  } catch (cause) {
    bodyFailure = failureMessage(cause);
  }

  if (!(response.status >= 200 && response.status < 300)) {
    return renderErrorResponse(response.status, path, bodyFailure === null ? body : null);
  }
  if (bodyFailure !== null) {
    return renderRequestFailure(path, bodyFailure);
  }
  return renderValue(body);
}
