import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function readTestData(name: string): string {
  return readFileSync(join(here, "..", "testdata", name), "utf8");
}

const MASK64 = (1n << 64n) - 1n;

/**
 * The same splitmix64 stream as `omni_chunk::testdata::fixture`, including the
 * little-endian byte order.
 */
export function splitmixBytes(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let state = BigInt(seed);
  let at = 0;
  while (at < len) {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    z = (z ^ (z >> 31n)) & MASK64;
    for (let byte = 0; byte < 8 && at < len; byte += 1, at += 1) {
      out[at] = Number((z >> BigInt(byte * 8)) & 0xffn);
    }
  }
  return out;
}

/** Mirrors `omni_chunk::testdata::fixture`. Keep the two in step. */
export function fixture(generator: string, len: number, seed: number): Uint8Array {
  switch (generator) {
    case "splitmix64":
      return splitmixBytes(len, seed);
    case "ascii-ramp": {
      const out = new Uint8Array(len);
      for (let at = 0; at < len; at += 1) out[at] = at % 256;
      return out;
    }
    case "text": {
      const line = new TextEncoder().encode(
        "# Heading\n\nThe quick brown fox jumps over the lazy dog.\n",
      );
      const out = new Uint8Array(len);
      let at = 0;
      while (at < len) {
        const take = Math.min(len - at, line.length);
        out.set(line.subarray(0, take), at);
        at += take;
      }
      return out;
    }
    case "ascii-noise": {
      const source = splitmixBytes(len, seed);
      const out = new Uint8Array(len);
      for (let at = 0; at < len; at += 1) {
        out[at] = 32 + (source[at]! % 95);
      }
      return out;
    }
    default:
      throw new Error(`unknown fixture generator ${generator}`);
  }
}
