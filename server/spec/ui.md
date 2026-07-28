# Autofile UI

The built-in view of an autofile vault: a browser app served by `autofile-server` from the same routes that serve its JSON. Start the server, open a browser at it, read the vault.

It is also the reference consumer of the server's JSON interface (`index.md`) — it reads only the public routes, so anything it shows, an app can fetch and show differently. The negotiation, discovery routes, and static serving it relies on are specified there.

This is the first of three passes: a real app, with a real build and data layer, showing the JSON as HTML and nothing more. Presentation is the second pass. Cross-references — wikilinks, vault-relative paths, assets — are the third, once those vault conventions settle.

## Fetching

Once the shell — the HTML document that boots the UI — has loaded, the UI takes the address bar as its query: it reads `location.pathname`, fetches that exact path with `Accept: application/json`, and renders the response. Page URL and data URL are the same URL, so the UI never derives an API address from a page address.

One page per fetch, and nothing held between them.

## Rendering

By JSON type and nothing else: strings, numbers, and booleans as text, arrays as lists, objects as nested key/value pairs. Keys appear as sent, in the order sent. Nothing is relabelled, reordered, resolved, or interpreted — a wikilink is the string `[[places/portland]]`, a markdown body is the text it is. One rule covers every response, so there is nothing per-route to write.

## Errors

Shown, not hidden. A `404` renders a not-found state; a `422` renders its parse message, since a broken file is not an absent one. A collection's `errors` array renders alongside its records — a half-saved record dropping silently out of a listing is exactly when you want to see it.

## Presentation

None yet — semantic HTML and default browser styling. Layout, type, colour, and dark mode are the second pass, and deciding them here would only mean deciding them again there.

## Build

The UI is part of the server package rather than its own — one package, one version, one install. Its source is `src/ui/`, TypeScript and custom elements with no framework, and Vite roots there, takes `src/ui/index.html` as its entry, and builds to `dist/ui/`, which ships alongside the server's `dist/src/`. Vite's `base` is `/_ui/`, so the shell's asset URLs are absolute and resolve the same from any record path.

TypeScript becomes two projects referenced from the package's `tsconfig.json`: the server's, which excludes `src/ui` so browser code never compiles into `dist/src`, and the UI's, which typechecks only, since Vite emits and never typechecks. The package build is `tsc -b && vite build`.

There is no Vite dev server. Development builds to disk and watches — Vite rebuilding `dist/ui`, `tsc` rebuilding `dist/src`, and the server restarting when it changes — so what you look at is served by the real server through the real negotiation path, not a simulation of it. The UI fetches relative paths and therefore always talks to whichever origin served it, which leaves no origin to configure and nothing for CORS to carry.

A dev server would cost all three. The page URL and the data URL are the same string, differing only by `Accept`, so Vite could not route between serving the shell and proxying data without reimplementing the negotiation rule in its config — and serving the app from a second origin would mean a `base` that breaks history fallback, an origin to inject, and a dev entry path unlike the real one.

## Testing

Value formatting across the JSON types is unit-tested under Vitest. Rendering gets a mount check and the error states — thin on purpose, since assertions written against a placeholder rendering would be rewritten by the second pass.
