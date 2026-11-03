import { describe, expect, it } from "vitest";

import { caseCollisions } from "../src/safety";

describe("caseCollisions", () => {
  it("finds paths a case-insensitive filesystem would merge", () => {
    expect(caseCollisions(["Notes/Todo.md", "notes/todo.md", "b.md"])).toEqual([
      ["Notes/Todo.md", "notes/todo.md"],
    ]);
  });

  it("reports nothing when every path differs by more than case", () => {
    expect(caseCollisions(["a.md", "b.md", "dir/c.md"])).toEqual([]);
  });

  it("keeps groups separate", () => {
    const groups = caseCollisions(["A.md", "a.md", "B.md", "b.md"]);
    expect(groups).toHaveLength(2);
  });

  it("ignores unicode case folding inconsistencies by comparing lowercase", () => {
    expect(caseCollisions(["CAFÉ.md", "café.md"])).toEqual([["CAFÉ.md", "café.md"]]);
  });
});
