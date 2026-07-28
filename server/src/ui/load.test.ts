import { describe, expect, it, vi } from "vitest";

import { loadView } from "./load.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function unparseableResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  } as unknown as Response;
}

function textOf(node: Node): string {
  const host = document.createElement("div");
  host.appendChild(node);
  return host.textContent ?? "";
}

describe("loadView", () => {
  it("fetches the given path from the given origin, asking for JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { vaults: [] }));

    await loadView("http://127.0.0.1:8766", "/vaults/main/records/tasks", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8766/vaults/main/records/tasks", {
      headers: { Accept: "application/json" },
    });
  });

  it("renders a 200 body with the generic renderer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { vaults: [{ name: "main", path: "/home/rupert/Vault" }] }),
    );

    const view = await loadView("http://x", "/", fetchImpl);

    expect(textOf(view)).toContain("main");
    expect(textOf(view)).toContain("/home/rupert/Vault");
  });

  it("renders a not-found state for a 404, naming the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not found" }));

    const view = await loadView("http://x", "/vaults/main/records/tasks/nope", fetchImpl);

    expect(textOf(view)).toContain("Not found");
    expect(textOf(view)).toContain("/vaults/main/records/tasks/nope");
  });

  it("renders the parse message for a 422", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(422, {
        path: "tasks/broken.md",
        message: "YAML parse error: bad indentation at line 3",
      }),
    );

    const view = await loadView("http://x", "/vaults/main/records/tasks/broken", fetchImpl);

    expect(textOf(view)).toContain("YAML parse error: bad indentation at line 3");
  });

  it("renders an error state when the fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const view = await loadView("http://x", "/vaults/main", fetchImpl);

    expect(textOf(view)).toContain("Request failed");
    expect(textOf(view)).toContain("Failed to fetch");
  });

  it("renders an error state when a 200 body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => unparseableResponse(200));

    const view = await loadView("http://x", "/", fetchImpl);

    expect(textOf(view)).toContain("Request failed");
  });

  it("still renders an error state when an error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => unparseableResponse(500));

    const view = await loadView("http://x", "/", fetchImpl);

    expect(textOf(view)).toContain("Error 500");
  });
});
