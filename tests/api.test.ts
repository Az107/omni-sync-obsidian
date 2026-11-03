import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }>,
  responses: new Map<
    string,
    { status?: number; text?: string; arrayBuffer?: ArrayBuffer }
  >(),
}));

vi.mock("obsidian", () => ({
  requestUrl: async (request: {
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => {
    harness.calls.push(request);
    const key = `${request.method ?? "GET"} ${new URL(request.url).pathname}`;
    const found = harness.responses.get(key) ?? {};
    const text = found.text ?? "{}";
    return {
      status: found.status ?? 200,
      headers: {},
      text,
      arrayBuffer: found.arrayBuffer ?? new ArrayBuffer(0),
      json: null,
    };
  },
}));

import { Api, ApiError, takeHeads } from "../src/api";

beforeEach(() => {
  harness.calls.length = 0;
  harness.responses.clear();
});

describe("transport", () => {
  it("appends requests under a deployment sub-path", async () => {
    const api = new Api("http://host/app/omni-sync", "token");
    harness.responses.set("GET /app/omni-sync/api/v1/folders", {
      text: JSON.stringify({ folders: [] }),
    });

    await api.listFolders();

    expect(harness.calls.at(-1)?.url).toBe("http://host/app/omni-sync/api/v1/folders");
    expect(harness.calls.at(-1)?.headers?.Authorization).toBe("Bearer token");
  });

  it("uploads exactly the chunk view, not the whole file buffer", async () => {
    const api = new Api("http://host", "token");
    const file = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    harness.responses.set("PUT /api/v1/chunks/abc", {
      text: JSON.stringify({ created: true }),
    });

    await api.putChunk("abc", file.subarray(2, 6));

    const body = harness.calls.at(-1)?.body as ArrayBuffer;
    expect(new Uint8Array(body)).toEqual(new Uint8Array([2, 3, 4, 5]));
  });

  it("surfaces a status error with the server's message", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/folders", {
      status: 401,
      text: JSON.stringify({ error: "unauthorized" }),
    });

    await expect(api.listFolders()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "unauthorized",
    });
  });
});

describe("old-server compatibility", () => {
  it("defaults a folder response that predates the policy fields", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/folders", {
      text: JSON.stringify({ folders: [{ id: "f1", name: "Vault" }] }),
    });

    const [folder] = await api.listFolders();

    expect(folder).toEqual({
      id: "f1",
      name: "Vault",
      exclude: [],
      preserve_permissions: true,
    });
  });

  it("keeps a real policy", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/folders/f1", {
      text: JSON.stringify({
        id: "f1",
        name: "Vault",
        exclude: [".trash/"],
        preserve_permissions: false,
      }),
    });

    expect(await api.getFolder("f1")).toEqual({
      id: "f1",
      name: "Vault",
      exclude: [".trash/"],
      preserve_permissions: false,
    });
  });

  it("treats an old ops response as the last page", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/folders/f1/ops", {
      text: JSON.stringify({ entries: [{ seq: 4 }] }),
    });

    const page = await api.opsSince("f1", 0);

    expect(page.next).toBe(4);
    expect(page.has_more).toBe(false);
  });

  it("normalises an overwrite row without an id", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/overwrites", {
      text: JSON.stringify([
        { path: "eA==", losing_version_id: 1, winning_version_id: 2 },
      ]),
    });

    const [row] = await api.overwrites();

    expect(row).toEqual({
      id: null,
      path: "eA==",
      losing_version_id: 1,
      winning_version_id: 2,
      folder_id: null,
    });
  });

  it("returns an empty trash when the endpoint does not exist", async () => {
    const api = new Api("http://host", "token");
    harness.responses.set("GET /api/v1/folders/f1/deleted", {
      status: 404,
      text: JSON.stringify({ error: "not found" }),
    });

    expect(await api.deleted("f1")).toEqual([]);
  });
});

describe("op-log stream frames", () => {
  it("parses a complete frame and drops keep-alives", () => {
    expect(takeHeads("event: head\ndata: 7\n\n: keep-alive\n\n")).toEqual({
      heads: [7],
      rest: "",
    });
  });

  it("leaves a partial frame buffered", () => {
    expect(takeHeads("data: 1\ndata: 2\n\npart")).toEqual({
      heads: [1, 2],
      rest: "part",
    });
  });

  it("tolerates CRLF frames", () => {
    expect(takeHeads("data: 3\r\n\r\n")).toEqual({ heads: [3], rest: "" });
  });
});

describe("ApiError", () => {
  it("is an Error with a status", () => {
    const error = new ApiError(403, "nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(403);
  });
});
