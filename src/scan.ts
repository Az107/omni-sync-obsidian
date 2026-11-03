/**
 * The inventory pass: what is on disk now, and what has to be read.
 *
 * Metadata is triage. A file whose size and mtime match the last synced record
 * reuses its chunk list without a read, which is what makes a 10k-note vault
 * cost one `stat` per file instead of one read. Only the candidates are read,
 * and the push reads them again as it uploads, so the bytes it sends are the
 * bytes it chunked.
 */

import type { DataAdapter } from "obsidian";

import type { ChunkRefDto } from "./api";
import { sha256Hex, split } from "./chunker";
import { type Ignore, isDropping } from "./ignore";
import type { State } from "./state";

export interface ScanEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** Known chunks when the metadata fast path hit; `null` means "read it". */
  chunks: ChunkRefDto[] | null;
}

export interface ScanResult {
  /** Every path looked at, including the ones that no longer exist. */
  scanned: Set<string>;
  /** Paths that still exist, with metadata and (when cheap) chunks. */
  present: Map<string, ScanEntry>;
  /** Present paths whose content must be read before a decision. */
  candidates: Set<string>;
  /** Paths skipped because they exceed the configured size cap. */
  tooLarge: string[];
}

export interface ScanDeps {
  adapter: DataAdapter;
  state: State;
  ignore: Ignore;
  /** All vault paths, used for a full scan. */
  listPaths: () => string[];
  /** Paths to inspect; `null` means "everything" (a full scan). */
  scope: Set<string> | null;
  /** Files larger than this are left alone in both directions. */
  maxFileSizeBytes: number;
}

export async function scanVault(deps: ScanDeps): Promise<ScanResult> {
  const scanned = new Set<string>();
  const present = new Map<string, ScanEntry>();
  const candidates = new Set<string>();
  const tooLarge: string[] = [];

  const known = await deps.state.allFiles();
  const paths = new Set<string>();
  if (deps.scope) {
    for (const path of deps.scope) paths.add(path);
  } else {
    for (const path of deps.listPaths()) paths.add(path);
    // A file deleted while Obsidian was closed is only in the stored manifest.
    for (const path of known.keys()) paths.add(path);
  }

  for (const path of paths) {
    if (!path || deps.ignore.matches(path) || isDropping(path)) continue;

    const stat = await deps.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      scanned.add(path);
      // A deleted directory arrives as one event; its children are only in the
      // stored manifest.
      for (const stored of known.keys()) {
        if (stored.startsWith(`${path}/`)) scanned.add(stored);
      }
      continue;
    }

    scanned.add(path);

    // A file above the cap is invisible to the diff: recorded in `present` so
    // it can never turn into a delete, and never a candidate so it is not
    // pushed. Pull skips it for the same reason.
    if (stat.size > deps.maxFileSizeBytes) {
      const record = known.get(path);
      present.set(path, {
        path,
        size: stat.size,
        mtimeMs: stat.mtime,
        chunks: record?.chunks ?? [],
      });
      tooLarge.push(path);
      continue;
    }

    const record = known.get(path);
    if (
      record &&
      record.versionId > 0 &&
      record.size === stat.size &&
      record.mtimeMs === stat.mtime
    ) {
      present.set(path, {
        path,
        size: stat.size,
        mtimeMs: stat.mtime,
        chunks: record.chunks,
      });
    } else {
      present.set(path, {
        path,
        size: stat.size,
        mtimeMs: stat.mtime,
        chunks: null,
      });
      candidates.add(path);
    }
  }

  return { scanned, present, candidates, tooLarge };
}

/** A chunk with the bytes the upload needs. */
export interface HashedChunk {
  hash: string;
  len: number;
  data: Uint8Array;
}

export async function hashChunks(bytes: Uint8Array): Promise<HashedChunk[]> {
  const out: HashedChunk[] = [];
  for (const chunk of split(bytes)) {
    const data = bytes.subarray(chunk.offset, chunk.offset + chunk.len);
    out.push({ hash: await sha256Hex(data), len: chunk.len, data });
  }
  return out;
}

export function chunkRefs(chunks: HashedChunk[]): ChunkRefDto[] {
  return chunks.map((chunk) => ({ hash: chunk.hash, len: chunk.len }));
}

export function sameChunks(
  left: readonly ChunkRefDto[],
  right: readonly ChunkRefDto[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (chunk, at) => chunk.hash === right[at]?.hash && chunk.len === right[at]?.len,
  );
}
