import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { RecordPatch, RecordPayload, RecordService } from "./recordService.js";

export interface AppOptions {
  recordService: RecordService;
  // Overridable for tests; the default is deliberately generous because the
  // read side serves records of any size and PUT must be able to write them.
  jsonBodyLimit?: string;
  // The UI's build output: the static assets and the shell document. Overridable
  // for tests; the default resolves against the compiled module rather than the
  // working directory, so the installed binary finds it wherever npm put it.
  uiDir?: string;
}

export function createApp({
  recordService,
  jsonBodyLimit = "50mb",
  uiDir = fileURLToPath(new URL("../ui/", import.meta.url))
}: AppOptions): Express {
  const app = express();

  // v1 has no conditional requests or write-conflict detection; suppress
  // express's default ETag so no caching semantics leak into the interface.
  app.set("etag", false);

  app.use((_request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });

  app.options("*", (_request, response) => {
    response.setHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.status(204).end();
  });

  app.use(express.json({ limit: jsonBodyLimit }));

  // The UI's build output, at the prefix its shell's asset references point to.
  app.use("/_ui", express.static(uiDir));

  const shellPath = path.join(uiDir, "index.html");
  let shellWarned = false;

  // Read per request, not held: the server must start before the UI is built
  // (and start at all without it), so the shell cannot be a constructor-time
  // dependency — and because the shell names a content-hashed asset, a copy
  // held across a rebuild would point at a script that rebuild has deleted.
  async function loadShell(): Promise<string | undefined> {
    try {
      return await readFile(shellPath, "utf8");
    } catch {
      // JSON is the interface's default representation, so an unbuilt UI
      // degrades to today's behaviour rather than breaking the server.
      if (!shellWarned) {
        shellWarned = true;
        process.stderr.write(
          `autofile-server: no UI shell at ${shellPath}; serving JSON to every request\n`
        );
      }
      return undefined;
    }
  }

  // Both representations of one resource. "json" is listed first so that */* and
  // a missing Accept header — which match either — resolve to JSON, leaving HTML
  // to requests that genuinely prefer it, which in practice means browsers.
  async function sendNegotiated(
    request: Request,
    response: Response,
    status: number,
    body: unknown
  ): Promise<void> {
    response.setHeader("Vary", "Accept");
    if (request.accepts(["json", "html"]) === "html") {
      const document = await loadShell();
      if (document !== undefined) {
        // The shell carries the status the JSON would have earned, so a page URL
        // and its data URL never disagree about whether a thing exists.
        response.status(status).type("html").send(document);
        return;
      }
    }
    response.status(status).json(body);
  }

  function sendNegotiatedError(
    request: Request,
    response: Response,
    status: number,
    message: string
  ): Promise<void> {
    return sendNegotiated(request, response, status, { message });
  }

  app.get("/", async (request, response, next) => {
    try {
      await sendNegotiated(request, response, 200, recordService.listVaults());
    } catch (error) {
      next(error);
    }
  });

  app.get("/vaults/:vault", async (request, response, next) => {
    try {
      const result = await recordService.listTypes(request.params.vault);
      switch (result.kind) {
        case "ok":
          await sendNegotiated(request, response, 200, { types: result.types });
          return;
        case "unknownVault":
          await sendNegotiatedError(request, response, 404, "unknown vault");
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/vaults/:vault/records/:type", async (request, response, next) => {
    try {
      const { vault, type } = request.params;
      const result = await recordService.listRecords(vault, type);
      switch (result.kind) {
        case "ok":
          await sendNegotiated(request, response, 200, result.collection);
          return;
        case "invalidSegment":
          await sendNegotiatedError(request, response, 400, result.message);
          return;
        case "unknownVault":
          await sendNegotiatedError(request, response, 404, "unknown vault");
          return;
        case "notFound":
          await sendNegotiatedError(request, response, 404, "not found");
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/vaults/:vault/records/:type/:slug", async (request, response, next) => {
    try {
      const { vault, type, slug } = request.params;
      const result = await recordService.getRecord(vault, type, slug);
      switch (result.kind) {
        case "ok":
          await sendNegotiated(request, response, 200, result.record);
          return;
        case "invalidSegment":
          await sendNegotiatedError(request, response, 400, result.message);
          return;
        case "unknownVault":
          await sendNegotiatedError(request, response, 404, "unknown vault");
          return;
        case "notFound":
          await sendNegotiatedError(request, response, 404, "not found");
          return;
        case "parseError":
          await sendNegotiated(request, response, 422, result.error);
      }
    } catch (error) {
      next(error);
    }
  });

  app.put("/vaults/:vault/records/:type/:slug", async (request, response, next) => {
    try {
      if (!request.is("application/json")) {
        sendError(response, 400, "request must declare Content-Type: application/json");
        return;
      }
      const payload = parsePutPayload(request.body);
      if (!payload.ok) {
        sendError(response, 400, payload.message);
        return;
      }

      const { vault, type, slug } = request.params;
      const result = await recordService.putRecord(vault, type, slug, payload.payload);
      switch (result.kind) {
        case "ok":
          response.status(result.created ? 201 : 200).json(result.record);
          return;
        case "invalidSegment":
        case "refused":
          sendError(response, 400, result.message);
          return;
        case "unknownVault":
          sendError(response, 404, "unknown vault");
      }
    } catch (error) {
      next(error);
    }
  });

  app.patch("/vaults/:vault/records/:type/:slug", async (request, response, next) => {
    try {
      if (!request.is("application/json")) {
        sendError(response, 400, "request must declare Content-Type: application/json");
        return;
      }
      const parsed = parsePatchPayload(request.body);
      if (!parsed.ok) {
        sendError(response, 400, parsed.message);
        return;
      }

      const { vault, type, slug } = request.params;
      const result = await recordService.patchRecord(vault, type, slug, parsed.patch);
      switch (result.kind) {
        case "ok":
          response.status(200).json(result.record);
          return;
        case "invalidSegment":
          sendError(response, 400, result.message);
          return;
        case "unknownVault":
          sendError(response, 404, "unknown vault");
          return;
        case "notFound":
          sendError(response, 404, "not found");
          return;
        case "parseError":
          response.status(422).json(result.error);
      }
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    sendError(response, 404, "not found");
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    sendError(response, status, status >= 500 ? "internal server error" : message);
  });

  return app;
}

type ParsedPayload = { ok: true; payload: RecordPayload } | { ok: false; message: string };

function parsePutPayload(body: unknown): ParsedPayload {
  if (!isPlainObject(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  for (const key of Object.keys(body)) {
    if (key !== "properties" && key !== "body") {
      return { ok: false, message: `unknown field: ${key}` };
    }
  }
  if (!isPlainObject(body.properties)) {
    return { ok: false, message: "properties is required and must be an object" };
  }
  if (typeof body.body !== "string") {
    return { ok: false, message: "body is required and must be a string" };
  }
  return { ok: true, payload: { properties: body.properties, body: body.body } };
}

type ParsedPatch = { ok: true; patch: RecordPatch } | { ok: false; message: string };

function parsePatchPayload(body: unknown): ParsedPatch {
  if (!isPlainObject(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  for (const key of Object.keys(body)) {
    if (key !== "properties" && key !== "body") {
      return { ok: false, message: `unknown field: ${key}` };
    }
  }
  const patch: RecordPatch = {};
  if (body.properties !== undefined) {
    if (!isPlainObject(body.properties)) {
      return { ok: false, message: "properties must be an object when present" };
    }
    patch.properties = body.properties;
  }
  if (body.body !== undefined) {
    if (typeof body.body !== "string") {
      return { ok: false, message: "body must be a string when present" };
    }
    patch.body = body.body;
  }
  return { ok: true, patch };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Errors raised before the routes run (JSON body parsing, percent-decoding of
// route params) carry their own status; anything else is a 500.
function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 600) {
      return status;
    }
  }
  return 500;
}

function sendError(response: Response, status: number, message: string): void {
  response.status(status).json({ message });
}
