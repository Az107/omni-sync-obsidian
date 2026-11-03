import { describe, expect, it } from "vitest";

import { CHUNK_CONFIG, joinChunks, sha256Hex, split, toHex } from "../src/chunker";
import { fixture, readTestData } from "./fixtures";

interface Vectors {
  config: { min: number; avg: number; max: number };
  cases: Array<{
    name: string;
    generator: string;
    len: number;
    seed: number;
    lens: number[];
  }>;
}

const vectors = JSON.parse(readTestData("chunk_vectors.json")) as Vectors;

describe("the gear chunker", () => {
  it("uses the same bounds as the Rust crate", () => {
    expect(vectors.config).toEqual(CHUNK_CONFIG);
  });

  for (const testCase of vectors.cases) {
    it(`matches the Rust boundaries for ${testCase.name}`, () => {
      const data = fixture(testCase.generator, testCase.len, testCase.seed);
      const actual = split(data).map((chunk) => chunk.len);
      expect(actual).toEqual(testCase.lens);
    });
  }

  it("covers the input exactly once", () => {
    const data = fixture("ascii-noise", 700_000, 11);
    const chunks = split(data);
    let at = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(at);
      expect(chunk.len).toBeGreaterThan(0);
      at += chunk.len;
    }
    expect(at).toBe(data.length);
  });

  it("is deterministic", () => {
    const data = fixture("splitmix64", 400_000, 9);
    expect(split(data)).toEqual(split(data));
  });

  it("reassembles losslessly", () => {
    const data = fixture("ascii-noise", 900_000, 4);
    const parts = split(data).map((chunk) =>
      data.subarray(chunk.offset, chunk.offset + chunk.len),
    );
    expect(joinChunks(parts)).toEqual(data);
  });
});

describe("hashing", () => {
  it("matches the known SHA-256 of abc", async () => {
    const digest = await sha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("formats hex lowercase and padded", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });
});
