/**
 * Path excludes, ported from `omni_core::Ignore`.
 *
 * Excludes are a folder property on the server, not a plugin setting: two
 * clients of one folder must agree or they keep re-adding what the other
 * ignores. Matching is byte-wise on the UTF-8 path, exactly like Rust, so a
 * multi-byte character counts as multiple bytes for `?`.
 *
 * `testdata/ignore_cases.json` is shared with `omni-core` and asserted in
 * `tests/ignore.test.ts`.
 */

export const VAULT_EXCLUDES: readonly string[] = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/cache/",
  ".trash/",
  ".obsidian/plugins/*/data.json",
];

const SLASH = 0x2f;
const STAR = 0x2a;
const QUESTION = 0x3f;
const encoder = new TextEncoder();

/**
 * Names no client ever syncs, mirroring `omni_agent::scan::is_ignored`.
 *
 * These are editor droppings and being-written files. They are enforced on the
 * pull side too, so a legacy client that pushed one cannot inject it here.
 */
export function isDropping(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name === ".omni-sync" ||
    name === ".omniignore" ||
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name.endsWith(".omni-tmp") ||
    name.endsWith(".part") ||
    name.endsWith(".crdownload") ||
    name.startsWith("~$") ||
    (name.startsWith(".") && name.endsWith(".swp"))
  );
}

interface Pattern {
  glob: Uint8Array;
  subtree: Uint8Array | null;
  anchored: boolean;
}

export class Ignore {
  private readonly patterns: Pattern[];

  constructor(patterns: readonly string[]) {
    const compiled: Pattern[] = [];
    for (const raw of patterns) {
      const pattern = compile(raw);
      if (pattern) compiled.push(pattern);
    }
    this.patterns = compiled;
  }

  static vaultDefaults(): Ignore {
    return new Ignore(VAULT_EXCLUDES);
  }

  get isEmpty(): boolean {
    return this.patterns.length === 0;
  }

  matches(path: string): boolean {
    if (path.length === 0) return false;
    const bytes = encoder.encode(path);
    return this.patterns.some((pattern) => patternMatches(pattern, bytes));
  }
}

function compile(raw: string): Pattern | null {
  let source = raw.replace(/\r+$/, "");
  if (source.length === 0 || source.startsWith("#")) return null;

  let directory = false;
  if (source.length > 1 && source.endsWith("/")) {
    directory = true;
    source = source.slice(0, -1);
  }
  const anchored = source.startsWith("/") || source.includes("/");
  if (source.startsWith("/")) source = source.slice(1);
  if (source.length === 0) return null;

  const glob = encoder.encode(source);
  let subtree: Uint8Array | null = null;
  if (directory) {
    subtree = new Uint8Array(glob.length + 3);
    subtree.set(glob);
    subtree.set([SLASH, STAR, STAR], glob.length);
  }
  return { glob, subtree, anchored };
}

function patternMatches(pattern: Pattern, path: Uint8Array): boolean {
  if (pattern.anchored) {
    if (globMatch(pattern.glob, 0, path, 0, path.length)) return true;
    return (
      pattern.subtree !== null && globMatch(pattern.subtree, 0, path, 0, path.length)
    );
  }

  // Unanchored: any single segment may match. A directory pattern also covers
  // its contents because they contain that segment.
  let start = 0;
  for (let at = 0; at <= path.length; at += 1) {
    if (at === path.length || path[at] === SLASH) {
      if (at > start && globMatch(pattern.glob, 0, path, start, at)) {
        return true;
      }
      start = at + 1;
    }
  }
  return false;
}

/**
 * `*` never crosses `/`, `**` does, `?` is one non-`/` byte.
 *
 * `[ti, tEnd)` is the slice of `text` being matched, so a caller can test one
 * path segment without copying it.
 */
function globMatch(
  pattern: Uint8Array,
  pi: number,
  text: Uint8Array,
  ti: number,
  tEnd: number,
): boolean {
  while (pi < pattern.length) {
    const byte = pattern[pi]!;

    if (byte === STAR && pattern[pi + 1] === STAR) {
      const rest = pi + 2;
      // `**/` also matches zero segments: `a/**/b` matches `a/b`.
      if (pattern[rest] === SLASH && globMatch(pattern, rest + 1, text, ti, tEnd)) {
        return true;
      }
      for (let at = ti; at <= tEnd; at += 1) {
        if (globMatch(pattern, rest, text, at, tEnd)) return true;
      }
      return false;
    }

    if (byte === STAR) {
      let at = ti;
      for (;;) {
        if (globMatch(pattern, pi + 1, text, at, tEnd)) return true;
        if (at === tEnd || text[at] === SLASH) return false;
        at += 1;
      }
    }

    if (byte === QUESTION) {
      if (ti === tEnd || text[ti] === SLASH) return false;
      pi += 1;
      ti += 1;
      continue;
    }

    if (ti === tEnd || text[ti] !== byte) return false;
    pi += 1;
    ti += 1;
  }
  return ti === tEnd;
}
