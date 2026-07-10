import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { RecordPatch, RecordPayload, RecordService } from "./recordService.js";

export interface AppOptions {
  recordService: RecordService;
  // Overridable for tests; the default is deliberately generous because the
  // read side serves records of any size and PUT must be able to write them.
  jsonBodyLimit?: string;
}

export function createApp({ recordService, jsonBodyLimit = "50mb" }: AppOptions): Express {
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

  app.get("/vaults/:vault/records/:type", async (request, response, next) => {
    try {
      const { vault, type } = request.params;
      const result = await recordService.listRecords(vault, type);
      switch (result.kind) {
        case "ok":
          response.status(200).json(result.collection);
          return;
        case "invalidSegment":
          sendError(response, 400, result.message);
          return;
        case "unknownVault":
          sendError(response, 404, "unknown vault");
          return;
        case "notFound":
          sendError(response, 404, "not found");
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
