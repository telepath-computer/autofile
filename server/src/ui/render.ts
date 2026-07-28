/**
 * Rendering: by JSON type and nothing else.
 *
 * Strings, numbers and booleans become text; arrays become lists; objects
 * become key/value pairs, in the order the keys arrived. No key is relabelled,
 * reordered, resolved or interpreted, and there is nothing per-route or
 * per-record-type here. Every response from every route goes through
 * `renderValue`.
 *
 * These functions are pure: they build detached DOM and never touch the
 * network, the document, or `location`.
 */

/** The marker shown for a JSON `null`. */
export const NULL_MARKER = "(null)";

/** The marker shown for an array with no items. */
export const EMPTY_ARRAY_MARKER = "(empty list)";

/** The marker shown for an object with no keys. */
export const EMPTY_OBJECT_MARKER = "(empty object)";

function marker(className: string, text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function renderArray(value: readonly unknown[]): Node {
  if (value.length === 0) return marker("empty", EMPTY_ARRAY_MARKER);

  const list = document.createElement("ul");
  for (const item of value) {
    const li = document.createElement("li");
    li.appendChild(renderValue(item));
    list.appendChild(li);
  }
  return list;
}

function renderObject(value: object): Node {
  const entries = Object.entries(value);
  if (entries.length === 0) return marker("empty", EMPTY_OBJECT_MARKER);

  const list = document.createElement("dl");
  for (const [key, item] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.appendChild(renderValue(item));
    list.appendChild(dt);
    list.appendChild(dd);
  }
  return list;
}

/**
 * Render any JSON value as DOM. Text is always set via `textContent`, so vault
 * content — agent-written, from email and web pages — is never markup.
 */
export function renderValue(value: unknown): Node {
  if (value === null || value === undefined) return marker("null", NULL_MARKER);
  if (Array.isArray(value)) return renderArray(value);
  if (typeof value === "object") return renderObject(value);
  return document.createTextNode(String(value));
}

function errorSection(heading: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "error";
  const h1 = document.createElement("h1");
  h1.textContent = heading;
  section.appendChild(h1);
  return section;
}

function paragraph(text: string): HTMLElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

/**
 * A non-2xx response. The path is always named, which is what makes a 404 a
 * not-found state rather than a blank page. The Error body, when there is one,
 * is rendered by the same generic renderer as everything else — that is what
 * puts a 422's parse message on screen.
 */
export function renderErrorResponse(
  status: number,
  path: string,
  body: unknown,
): HTMLElement {
  const section = errorSection(status === 404 ? "Not found" : `Error ${status}`);
  section.appendChild(paragraph(path));
  if (body !== null && body !== undefined) {
    section.appendChild(renderValue(body));
  }
  return section;
}

/** A request that never produced a response, or a response that was not JSON. */
export function renderRequestFailure(path: string, message: string): HTMLElement {
  const section = errorSection("Request failed");
  section.appendChild(paragraph(path));
  section.appendChild(paragraph(message));
  return section;
}
