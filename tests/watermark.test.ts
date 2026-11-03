import { describe, expect, it } from "vitest";

import { advanceWatermark, isEcho, pullsFirst } from "../src/watermark";

describe("advanceWatermark", () => {
  it("moves across a contiguous batch", () => {
    expect(advanceWatermark(0, [1, 2, 3])).toBe(3);
    expect(advanceWatermark(7, [8, 9])).toBe(9);
  });

  it("stops at a foreign op inside the batch", () => {
    // We pushed 101 and 103; another device took 102 in between.
    expect(advanceWatermark(100, [101, 103])).toBe(101);
    // Our first op is already contaminated: nothing advances.
    expect(advanceWatermark(100, [102, 103])).toBe(100);
  });

  it("only advances a first push when the folder was empty", () => {
    expect(advanceWatermark(0, [1, 2])).toBe(2);
    expect(advanceWatermark(0, [51, 52])).toBe(0);
  });

  it("leaves the watermark alone for an empty batch", () => {
    expect(advanceWatermark(42, [])).toBe(42);
  });
});

describe("echo detection", () => {
  it("skips an op we already applied while the file exists", () => {
    expect(isEcho(7, 7, true)).toBe(true);
  });

  it("applies the op when the version differs or the file is gone", () => {
    expect(isEcho(6, 7, true)).toBe(false);
    expect(isEcho(7, 7, false)).toBe(false);
    expect(isEcho(undefined, 7, true)).toBe(false);
  });
});

describe("sync order", () => {
  it("pulls first only on the first sync", () => {
    expect(pullsFirst(0)).toBe(true);
    expect(pullsFirst(1)).toBe(false);
  });
});
