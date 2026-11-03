/**
 * The pull half of the engine.
 *
 * - `applied_seq` advances per entry, after the entry is fully applied, so a
 *   failure replays exactly the failed op and nothing before it.
 * - the op log is paged (`limit`), so a long history is a sequence of bounded
 *   responses instead of one giant JSON. The first sync of a folder does not
 *   replay the log at all: `bootstrap` takes the head and the manifest, which
 *   is the current state.
 * - an excluded or non-UTF-8 path is skipped but still advances the watermark,
 *   or it would be re-read on every pull forever.
 * - a pulled op whose `version_id` this device already holds, with the file
 *   still on disk, is an echo of our own write: advance, do not rewrite.
 * - a local file that differs from the server on first sync is **kept**, and a
 *   synthetic baseline (`versionId = 0`) is recorded so the push uploads it and
 *   the server records the overwrite.
 * - a remote update for a file the user has edited since the last sync is not
 *   applied: the push runs first and its stale base opens the overwrite row.
 * - a remote update for a file open in an editor is held back in `pending` and
 *   applied when the leaf closes.
 * - files above the size cap are skipped in both directions, with a log, rather
 *   than being read into memory on a phone.
 */

import type { DataAdapter } from "obsidian";

import type { Api, ChunkRefDto, FolderDto, LogEntryDto, ManifestEntryDto } from "./api";
import { joinChunks, sha256Hex } from "./chunker";
import { mapLimit } from "./concurrency";
import { type Ignore, isDropping } from "./ignore";
import { decodePath, parentPath } from "./paths";
import { chunkRefs, hashChunks, sameChunks } from "./scan";
import type { State } from "./state";
import { isEcho } from "./watermark";

/** Chunk requests in flight at once. */
const CHUNK_CONCURRENCY = 4;
/** Must match `Api.OP_PAGE`; a value import would drag `obsidian` into tests. */
const OP_PAGE = 500;

export interface PullResult {
  /** Ops seen in this pull's log batches. */
  entries: number;
  /** Files written from the server (log entries, bootstrap and pending). */
  written: number;
  removed: number;
  /** Echoes, excluded paths, adopted-identical files and held-back updates. */
  skipped: number;
  /** Local edits the push must resolve. */
  deferred: number;
  /** Files skipped because they exceed the size cap. */
  tooLarge: number;
  /** True when `shouldStop` asked the pull to break early. */
  cancelled: boolean;
}

export interface PullDeps {
  api: Api;
  state: State;
  adapter: DataAdapter;
  folder: FolderDto;
  ignore: Ignore;
  log: (message: string, error?: unknown) => void;
  /** Called after every applied entry with its seq. */
  onApplied?: (appliedSeq: number) => void;
  /** Called with the number of entries handled in this run. */
  onProgress?: (done: number) => void;
  isOpen?: (path: string) => boolean;
  markSelfWrite?: (path: string) => void;
  /** Files larger than this are not downloaded. */
  maxFileSizeBytes: number;
  /** Cooperative cancellation, checked between pages and entries. */
  shouldStop?: () => boolean;
}

export class Puller {
  constructor(private readonly deps: PullDeps) {}

  async pull(): Promise<PullResult> {
    const result = emptyResult();

    // Apply anything held back for an open editor before asking for more.
    await this.applyPending(result);

    let since = await this.deps.state.appliedSeq();
    let handled = 0;
    for (;;) {
      if (this.deps.shouldStop?.()) {
        result.cancelled = true;
        break;
      }

      const requested = since;
      const page = await this.deps.api.opsSince(this.deps.folder.id, requested, OP_PAGE);
      result.entries += page.entries.length;

      for (const entry of page.entries) {
        if (this.deps.shouldStop?.()) {
          result.cancelled = true;
          break;
        }
        await this.applyEntry(entry, result);
        // Only after the entry is durable: a failure replays this op, not past it.
        await this.deps.state.setAppliedSeq(entry.seq);
        since = entry.seq;
        this.deps.onApplied?.(entry.seq);
        this.deps.onProgress?.(++handled);
      }

      if (result.cancelled || !page.has_more) break;
      // No progress relative to the request would loop forever.
      if (page.next <= requested) break;
      since = page.next;
    }
    return result;
  }

  /**
   * First sync of a folder: fetch the head, then the manifest, and make the
   * vault match it. Returns false when the server has no `/head` endpoint, in
   * which case the caller falls back to replaying the log.
   *
   * Head is read before the manifest on purpose: an op that lands between the
   * two is included in the manifest and then re-delivered by the pull from
   * `head` (idempotent), instead of being skipped forever.
   */
  async bootstrap(): Promise<boolean> {
    const folder = this.deps.folder.id;
    let head: number;
    try {
      head = await this.deps.api.head(folder);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }

    const manifest = await this.deps.api.manifest(folder);
    const result = emptyResult();
    let handled = 0;

    for (const entry of manifest.entries) {
      if (this.deps.shouldStop?.()) {
        result.cancelled = true;
        break;
      }
      this.deps.onProgress?.(++handled);

      let path: string;
      try {
        path = decodePath(entry.path);
      } catch {
        result.skipped += 1;
        continue;
      }
      if (this.deps.ignore.matches(path) || isDropping(path)) {
        result.skipped += 1;
        continue;
      }

      const log = asLogEntry(entry);
      const stored = await this.deps.state.getFile(path);
      const exists = await this.deps.adapter.exists(path);

      if (stored && stored.versionId === entry.version_id && exists) {
        result.skipped += 1;
        continue;
      }

      if (exists) {
        // The same adoption rules as a first-sync op: identical content is
        // adopted, different content is kept for the push to report.
        await this.adoptLocal(path, log, result);
      } else {
        await this.writeCapped(path, log, result);
      }
    }

    if (!result.cancelled) {
      await this.deps.state.setAppliedSeq(head);
    }
    return true;
  }

  private async applyEntry(entry: LogEntryDto, result: PullResult): Promise<void> {
    let path: string;
    try {
      path = decodePath(entry.path);
    } catch {
      // A Linux daemon can sync a filename that is not valid UTF-8; an Obsidian
      // vault cannot hold it. Skip it, but do not wedge the watermark.
      this.deps.log(`skipping a path that is not valid UTF-8 (seq ${entry.seq})`);
      result.skipped += 1;
      return;
    }

    if (this.deps.ignore.matches(path) || isDropping(path)) {
      result.skipped += 1;
      return;
    }

    if (entry.kind === "delete") {
      this.deps.markSelfWrite?.(path);
      if (await this.deps.adapter.exists(path)) {
        await this.deps.adapter.remove(path);
      }
      await this.deps.state.removeFile(path);
      await this.deps.state.removePending(path);
      result.removed += 1;
      return;
    }

    const stored = await this.deps.state.getFile(path);
    const exists = await this.deps.adapter.exists(path);

    if (isEcho(stored?.versionId, entry.version_id, exists)) {
      result.skipped += 1;
      return;
    }

    // Obsidian normally reloads an externally written file, but a dirty editor
    // buffer would save over it. Hold the update until the leaf closes; the
    // watermark may advance because the content is persisted in `pending`.
    if (exists && this.deps.isOpen?.(path)) {
      await this.deps.state.setPending({ path, entry });
      result.skipped += 1;
      return;
    }

    if (stored === undefined && exists) {
      const handled = await this.adoptLocal(path, entry, result);
      if (handled) return;
    }

    if (stored !== undefined && stored.versionId !== 0 && exists) {
      const stat = await this.deps.adapter.stat(path);
      if (stat && Math.abs(stat.mtime - stored.mtimeMs) > 1) {
        result.deferred += 1;
        return;
      }
    }

    await this.writeCapped(path, entry, result);
  }

  /** Download and record, unless the file is above the size cap. */
  private async writeCapped(
    path: string,
    entry: LogEntryDto,
    result: PullResult,
  ): Promise<void> {
    if (entry.size > this.deps.maxFileSizeBytes) {
      result.tooLarge += 1;
      this.deps.log(`${path} is ${entry.size} bytes, above the size cap; not downloaded`);
      return;
    }
    await this.writeEntry(path, entry);
    result.written += 1;
  }

  /** Apply held-back updates whose file is now closed and still untouched. */
  private async applyPending(result: PullResult): Promise<void> {
    const pending = await this.deps.state.allPending();
    for (const { path, entry } of pending) {
      if (this.deps.ignore.matches(path) || isDropping(path)) {
        await this.deps.state.removePending(path);
        continue;
      }
      if (this.deps.isOpen?.(path)) continue;

      const stored = await this.deps.state.getFile(path);
      if (stored && stored.versionId >= entry.version_id) {
        // The push (or a newer op) superseded it while it was held.
        await this.deps.state.removePending(path);
        continue;
      }

      if (entry.size > this.deps.maxFileSizeBytes) {
        await this.deps.state.removePending(path);
        result.tooLarge += 1;
        this.deps.log(`${path} is above the size cap; dropping the held update`);
        continue;
      }

      const exists = await this.deps.adapter.exists(path);
      if (exists && stored) {
        const stat = await this.deps.adapter.stat(path);
        if (stat && Math.abs(stat.mtime - stored.mtimeMs) > 1) {
          // Locally edited: leave it for the push, which will drop this entry.
          continue;
        }
      }

      try {
        await this.writeEntry(path, entry);
        await this.deps.state.removePending(path);
        result.written += 1;
      } catch (error) {
        this.deps.log(`could not apply the held update for ${path}`, error);
      }
    }
  }

  /**
   * Decide what to do with a file that exists only locally.
   *
   * Returns true when the entry is fully handled without a download.
   */
  private async adoptLocal(
    path: string,
    entry: LogEntryDto,
    result: PullResult,
  ): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.deps.adapter.readBinary(path));
    } catch (error) {
      this.deps.log(`could not read the local copy of ${path}; downloading`, error);
      return false;
    }

    const localChunks = chunkRefs(await hashChunks(bytes));
    // With permissions preserved we cannot prove mode equality on a client that
    // has no POSIX modes, so we do not adopt: downloading is the safe direction.
    const identical =
      !this.deps.folder.preserve_permissions && sameChunks(localChunks, entry.chunks);

    if (identical) {
      const stat = await this.deps.adapter.stat(path);
      await this.deps.state.setFile({
        path,
        versionId: entry.version_id,
        size: bytes.length,
        mtimeMs: stat?.mtime ?? Date.now(),
        chunks: entry.chunks,
      });
      result.skipped += 1;
      return true;
    }

    // Keep the local file and record a synthetic baseline (`versionId = 0`), so
    // the push uploads it with no base and the server records a real overwrite
    // instead of silently losing either side.
    await this.recordBaseline(path, entry);
    result.deferred += 1;
    this.deps.log(
      `kept the local ${path}: it differs from the server, so the next sync will report an overwrite`,
    );
    return true;
  }

  /** Mirror `omni_agent`'s synthetic first-sync baseline for a kept file. */
  private async recordBaseline(path: string, entry: LogEntryDto): Promise<void> {
    await this.deps.state.setFile({
      path,
      versionId: 0,
      size: entry.size,
      mtimeMs: 0,
      chunks: entry.chunks,
    });
  }

  private async writeEntry(path: string, entry: LogEntryDto): Promise<void> {
    const bytes = await this.fetchChunks(entry.chunks);
    this.deps.markSelfWrite?.(path);
    await writeFile(this.deps.adapter, path, bytes);
    const stat = await this.deps.adapter.stat(path);
    await this.deps.state.setFile({
      path,
      versionId: entry.version_id,
      size: bytes.length,
      mtimeMs: stat?.mtime ?? Date.now(),
      chunks: entry.chunks,
    });
  }

  private async fetchChunks(chunks: ChunkRefDto[]): Promise<Uint8Array> {
    const parts = await mapLimit(chunks, CHUNK_CONCURRENCY, async (chunk) => {
      const bytes = await this.deps.api.getChunk(chunk.hash);
      if (!bytes) {
        throw new Error(`the server is missing chunk ${chunk.hash}`);
      }
      if ((await sha256Hex(bytes)) !== chunk.hash) {
        throw new Error(`chunk ${chunk.hash} failed verification`);
      }
      return bytes;
    });
    return joinChunks(parts);
  }
}

/** Write via a temp sibling and a rename, so a reader never sees half a file. */
export async function writeFile(
  adapter: DataAdapter,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const parent = parentPath(path);
  if (parent && !(await adapter.exists(parent))) {
    await adapter.mkdir(parent);
  }
  const temp = `${path}.omni-tmp`;
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await adapter.writeBinary(temp, exact);
  try {
    await adapter.rename(temp, path);
  } catch {
    // Some adapters (notably on mobile) refuse to rename over an existing
    // file. Removing first loses atomicity for a moment; the alternative is
    // failing the pull, which is worse.
    if (await adapter.exists(path)) await adapter.remove(path);
    await adapter.rename(temp, path);
  }
}

function emptyResult(): PullResult {
  return {
    entries: 0,
    written: 0,
    removed: 0,
    skipped: 0,
    deferred: 0,
    tooLarge: 0,
    cancelled: false,
  };
}

function asLogEntry(entry: ManifestEntryDto): LogEntryDto {
  return {
    seq: 0,
    version_id: entry.version_id,
    kind: "put",
    path: entry.path,
    device_id: "",
    size: entry.size,
    mtime_ns: entry.mtime_ns,
    mode: entry.mode,
    chunks: entry.chunks,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}
