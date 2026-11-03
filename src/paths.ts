/**
 * Wire paths are base64 of raw UTF-8 bytes (`omni_netproto::encode_path`).
 *
 * A vault path is always a `/`-separated, vault-relative string. Decoding is
 * strict: a path that is not valid UTF-8 cannot exist in an Obsidian vault, so
 * it is reported instead of being mangled.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodePath(path: string): string {
  const bytes = encoder.encode(path);
  let binary = "";
  // `String.fromCharCode(...bytes)` overflows the argument limit on long paths.
  const window = 0x8000;
  for (let at = 0; at < bytes.length; at += window) {
    binary += String.fromCharCode(...bytes.subarray(at, at + window));
  }
  return btoa(binary);
}

export function decodePath(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return decoder.decode(bytes);
}

/** Normalise a vault path to the form the server stores: relative, `/`-joined. */
export function vaultPath(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The parent directory of a vault path, or `null` at the root. */
export function parentPath(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? null : path.slice(0, cut);
}

/** A stable, short id for this vault, used to namespace IndexedDB. */
export function vaultKey(name: string, path: string): string {
  const input = `${name}\u0000${path}`;
  let hash = 0x811c9dc5;
  for (let at = 0; at < input.length; at += 1) {
    hash ^= input.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
