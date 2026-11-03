import { describe, expect, it } from "vitest";

import { describeError, formatDate, formatSize } from "../src/format";

describe("formatSize", () => {
  it("keeps bytes exact", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("scales to the usual units", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(300_000)).toBe("293 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatDate", () => {
  it("returns the input when it cannot parse", () => {
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("formats an ISO timestamp", () => {
    expect(formatDate("2026-11-03T14:00:00.000Z")).not.toBe("2026-11-03T14:00:00.000Z");
  });
});

describe("describeError", () => {
  it("uses the message of an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(42)).toBe("42");
  });
});
