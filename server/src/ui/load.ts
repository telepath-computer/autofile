/**
 * Fetching: the address bar is the query. The UI reads a path, asks the server
 * for that exact path as JSON, and hands the result to the renderer. One page
 * per fetch; nothing is held between them.
 */

import { renderErrorResponse, renderRequestFailure, renderValue } from "./render.js";

function failureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Fetch `path` as JSON and render it. The path is relative, so the request goes
 * to whichever origin served the page — in development that is the same server,
 * because the UI is built to disk and served by it rather than by a dev server.
 * Always resolves: every failure is a rendered state, never a blank page.
 */
export async function loadView(
  path: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Node> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
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
