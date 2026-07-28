import { describe, expect, it } from "vitest";

import {
  EMPTY_ARRAY_MARKER,
  EMPTY_OBJECT_MARKER,
  NULL_MARKER,
  renderErrorResponse,
  renderRequestFailure,
  renderValue,
} from "./render.js";

function mount(node: Node): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(node);
  return host;
}

function keysOf(host: HTMLElement): string[] {
  return [...host.querySelectorAll("dt")].map((dt) => dt.textContent ?? "");
}

describe("renderValue", () => {
  it("renders a string as text", () => {
    expect(mount(renderValue("[[places/portland]]")).textContent).toBe("[[places/portland]]");
  });

  it("renders a number as text", () => {
    expect(mount(renderValue(3)).textContent).toBe("3");
  });

  it("renders a boolean as text", () => {
    expect(mount(renderValue(false)).textContent).toBe("false");
  });

  it("renders null as an explicit marker", () => {
    const host = mount(renderValue(null));
    expect(host.querySelector("span.null")?.textContent).toBe(NULL_MARKER);
  });

  it("renders an array as a list, one item per entry", () => {
    const host = mount(renderValue(["a", 1, true]));
    expect([...host.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual([
      "a",
      "1",
      "true",
    ]);
  });

  it("renders an empty array as an explicit marker", () => {
    expect(mount(renderValue([])).querySelector("span.empty")?.textContent).toBe(
      EMPTY_ARRAY_MARKER,
    );
  });

  it("renders an object as key/value pairs", () => {
    const host = mount(renderValue({ title: "Call Homesite", status: "available" }));
    expect(keysOf(host)).toEqual(["title", "status"]);
    expect([...host.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
      "Call Homesite",
      "available",
    ]);
  });

  it("renders an empty object as an explicit marker", () => {
    expect(mount(renderValue({})).querySelector("span.empty")?.textContent).toBe(
      EMPTY_OBJECT_MARKER,
    );
  });

  it("nests objects and arrays to any depth", () => {
    const host = mount(renderValue({ a: { b: [{ c: "deep" }] } }));
    expect(keysOf(host)).toEqual(["a", "b", "c"]);
    expect(host.querySelector("dl dl ul li dl dd")?.textContent).toBe("deep");
  });

  it("renders keys in the order given, not sorted", () => {
    const host = mount(renderValue({ zebra: 1, apple: 2, mango: 3 }));
    expect(keysOf(host)).toEqual(["zebra", "apple", "mango"]);
  });

  it("renders a Record response with no special-casing of any key", () => {
    const record = {
      id: "tasks/call-homesite-about-sublet-coverage",
      type: "tasks",
      properties: {
        title: "Call Homesite about sublet coverage",
        created_at: "2026-07-06",
        status: "available",
        project: "[[projects/confirm-sublet]]",
      },
      body: "Markdown body, verbatim.",
      mtime: "2026-07-06T18:41:03.000Z",
    };
    const host = mount(renderValue(record));

    expect(keysOf(host)).toEqual([
      "id",
      "type",
      "properties",
      "title",
      "created_at",
      "status",
      "project",
      "body",
      "mtime",
    ]);
    expect(host.textContent).toContain("[[projects/confirm-sublet]]");
    expect(host.textContent).toContain("Markdown body, verbatim.");
    // No links are generated anywhere.
    expect(host.querySelector("a")).toBeNull();
  });

  it("renders a Collection response, errors array included, through the same rule", () => {
    const collection = {
      records: [
        { id: "tasks/one", type: "tasks", properties: {}, body: "", mtime: "2026-07-06T18:41:03.000Z" },
      ],
      errors: [{ path: "tasks/broken.md", message: "YAML parse error: bad indentation at line 3" }],
    };
    const host = mount(renderValue(collection));

    expect(keysOf(host).slice(0, 2)).toEqual(["records", "id"]);
    expect(keysOf(host)).toContain("errors");
    expect(host.textContent).toContain("tasks/broken.md");
    expect(host.textContent).toContain("YAML parse error: bad indentation at line 3");
  });

  it("renders HTML-ish content as literal text, never as markup", () => {
    const host = mount(
      renderValue({ body: "<script>alert(1)</script><img src=x onerror=alert(2)>" }),
    );

    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
    expect(host.innerHTML).toContain("&lt;script&gt;");
  });

  it("renders an HTML-ish key as literal text too", () => {
    const host = mount(renderValue({ "<b>key</b>": "value" }));

    expect(host.querySelector("b")).toBeNull();
    expect(keysOf(host)).toEqual(["<b>key</b>"]);
  });
});

describe("error states", () => {
  it("renders a 404 as a not-found state naming the path", () => {
    const section = renderErrorResponse(404, "/vaults/main/records/tasks/nope", {
      message: "Not found",
    });

    expect(section.querySelector("h1")?.textContent).toBe("Not found");
    expect(section.textContent).toContain("/vaults/main/records/tasks/nope");
  });

  it("renders a 422 with the parse message from the Error body", () => {
    const section = renderErrorResponse(422, "/vaults/main/records/tasks/broken", {
      path: "tasks/broken.md",
      message: "YAML parse error: bad indentation at line 3",
    });

    expect(section.querySelector("h1")?.textContent).toBe("Error 422");
    expect(section.textContent).toContain("YAML parse error: bad indentation at line 3");
    expect(section.textContent).toContain("tasks/broken.md");
  });

  it("renders an error with no body without failing", () => {
    const section = renderErrorResponse(500, "/", null);

    expect(section.querySelector("h1")?.textContent).toBe("Error 500");
    expect(section.textContent).toContain("/");
  });

  it("renders a request failure with its message", () => {
    const section = renderRequestFailure("/vaults/main", "Failed to fetch");

    expect(section.querySelector("h1")?.textContent).toBe("Request failed");
    expect(section.textContent).toContain("Failed to fetch");
  });
});
