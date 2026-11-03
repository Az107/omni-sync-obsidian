import { describe, expect, it } from "vitest";

import { Ignore } from "../src/ignore";
import { scanVault } from "../src/scan";
import { FakeAdapter, FakeState } from "./fakes";

async function scan(adapter: FakeAdapter, state: FakeState, maxFileSizeBytes = 1024) {
  return scanVault({
    adapter: adapter as never,
    state: state as never,
    ignore: new Ignore([]),
    listPaths: () => [...adapter.files.keys()],
    scope: null,
    maxFileSizeBytes,
  });
}

describe("scan size cap", () => {
  it("leaves an oversized file out of the candidates but keeps it present", async () => {
    const adapter = new FakeAdapter();
    const state = new FakeState();
    adapter.put("big.bin", new Uint8Array(20));
    adapter.put("small.md", new Uint8Array(4));

    const result = await scan(adapter, state, 10);

    expect(result.tooLarge).toEqual(["big.bin"]);
    expect(result.candidates.has("big.bin")).toBe(false);
    // Present, so the diff can never turn it into a delete.
    expect(result.present.has("big.bin")).toBe(true);
    expect(result.candidates.has("small.md")).toBe(true);
  });

  it("keeps the last synced record for an oversized file", async () => {
    const adapter = new FakeAdapter();
    const state = new FakeState();
    adapter.put("big.bin", new Uint8Array(20));
    await state.setFile({
      path: "big.bin",
      versionId: 7,
      size: 20,
      mtimeMs: adapter.mtime,
      chunks: [{ hash: "aa", len: 20 }],
    });

    const result = await scan(adapter, state, 10);

    expect(result.tooLarge).toEqual(["big.bin"]);
    expect(result.present.get("big.bin")?.chunks).toEqual([{ hash: "aa", len: 20 }]);
    expect(state.files.get("big.bin")?.versionId).toBe(7);
  });
});
