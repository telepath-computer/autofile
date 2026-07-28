import { afterEach, describe, expect, it, vi } from "vitest";

import { AutofilePage, PAGE_TAG, definePage } from "./page.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

describe("autofile-page", () => {
  it("mounts the rendered response when connected", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          status: 200,
          ok: true,
          json: async () => ({ types: [{ name: "contacts", count: 3 }] }),
        }) as unknown as Response,
    ) as typeof fetch;

    definePage();
    const page = document.createElement(PAGE_TAG) as AutofilePage;
    document.body.appendChild(page);
    await page.load();

    expect(page.textContent).toContain("contacts");
    expect(page.textContent).toContain("3");
  });

  it("mounts an error state rather than nothing when the fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    definePage();
    const page = document.createElement(PAGE_TAG) as AutofilePage;
    document.body.appendChild(page);
    await page.load();

    expect(page.textContent).toContain("Request failed");
  });
});
