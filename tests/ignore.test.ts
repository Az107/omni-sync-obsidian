import { describe, expect, it } from "vitest";

import { Ignore, VAULT_EXCLUDES, isDropping } from "../src/ignore";
import { readTestData } from "./fixtures";

interface Case {
  patterns: string[];
  path: string;
  ignored: boolean;
}

const cases = JSON.parse(readTestData("ignore_cases.json")) as Case[];

describe("the shared ignore corpus", () => {
  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.patterns)} against ${testCase.path}`, () => {
      const ignore = new Ignore(testCase.patterns);
      expect(ignore.matches(testCase.path)).toBe(testCase.ignored);
    });
  }
});

describe("vault defaults", () => {
  const ignore = new Ignore(VAULT_EXCLUDES);

  it("ignore volatile Obsidian files", () => {
    expect(ignore.matches(".obsidian/workspace.json")).toBe(true);
    expect(ignore.matches(".obsidian/workspace-mobile.json")).toBe(true);
    expect(ignore.matches(".obsidian/cache/index")).toBe(true);
    expect(ignore.matches(".trash/old note.md")).toBe(true);
    expect(ignore.matches(".obsidian/plugins/templater/data.json")).toBe(true);
  });

  it("keep note content and plugin code", () => {
    expect(ignore.matches("notes/todo.md")).toBe(false);
    expect(ignore.matches(".obsidian/appearance.json")).toBe(false);
    expect(ignore.matches(".obsidian/plugins/templater/main.js")).toBe(false);
  });
});

describe("editor droppings", () => {
  it("are dropped by basename at any depth", () => {
    expect(isDropping("notes/.DS_Store")).toBe(true);
    expect(isDropping("notes/a.md.omni-tmp")).toBe(true);
    expect(isDropping("downloads/report.pdf.part")).toBe(true);
    expect(isDropping("~$notes.docx")).toBe(true);
    expect(isDropping(".hidden.swp")).toBe(true);
  });

  it("do not catch ordinary files", () => {
    expect(isDropping("notes/todo.md")).toBe(false);
    expect(isDropping("partial/notes.md")).toBe(false);
  });
});
