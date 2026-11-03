import { describe, expect, it } from "vitest";

import { decodePath, encodePath, parentPath, vaultPath } from "../src/paths";

describe("wire paths", () => {
  it("round-trip ASCII, Unicode and emoji", () => {
    for (const path of [
      "notes/todo.md",
      "café/résumé.pdf",
      "日本語/ノート.md",
      "emoji/📝 note.md",
      "with spaces/a b.md",
    ]) {
      expect(decodePath(encodePath(path))).toBe(path);
    }
  });

  it("produce the exact base64 the Rust client sends", () => {
    // `omni_netproto::encode_path(b"notes/todo.md")`
    expect(encodePath("notes/todo.md")).toBe("bm90ZXMvdG9kby5tZA==");
  });

  it("refuse a path that is not UTF-8", () => {
    // 0xFF is never a valid UTF-8 lead byte.
    expect(() => decodePath("/w==")).toThrow();
  });
});

describe("vault path helpers", () => {
  it("normalise leading and trailing slashes", () => {
    expect(vaultPath("/notes/todo.md/")).toBe("notes/todo.md");
    expect(vaultPath("notes/todo.md")).toBe("notes/todo.md");
  });

  it("find the parent directory", () => {
    expect(parentPath("notes/todo.md")).toBe("notes");
    expect(parentPath("notes/sub/todo.md")).toBe("notes/sub");
    expect(parentPath("todo.md")).toBeNull();
  });
});
