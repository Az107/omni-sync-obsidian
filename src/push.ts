/**
 * The push half: turn local changes into ops, upload their chunks, submit in
 * batches, and advance the watermark over the contiguous run only.
 *
 * The rules this mirror from `omni_agent::Engine::push_inner`:
 *
 * - a path whose metadata matches the last record is not read;
 * - a file read back with the same chunks as the record is not an op (only its
 *   mtime moved), but the new mtime is recorded so the fast path keeps working;
 * - `base_version_id` is the version this device last synced, `null` for a
 *   create; a stale base is how the server knows to open an overwrite row;
 * - `ops.id` is global, so the watermark advances only across a contiguous run,
 *   and `syncStep` pulls immediately afterwards to close gaps and update the
 *   server's ack watermark;
 * - a successful push drops any held-back remote op for the same path: ours is
 *   newer, and the server has already recorded the conflict.
 */

import type { DataAdapter } from "obsidian";

import type { Api, ChunkRefDto, FolderDto, OpDto } from "./api";
import { mapLimit } from "./concurrency";
import type { Ignore } from "./ignore";
import { encodePath } from "./paths";
import {
  chunkRefs,
  hashChunks,
  sameChunks,
  scanVault,
  type HashedChunk,
  type ScanDeps,
} from "./scan";
import type { State } from "./state";
import { advanceWatermark } from "./watermark";

const BATCH_SIZE = 100;
/** Independent chunk PUTs in flight at once. */
const UPLOAD_CONCURRENCY = 4;

export interface PushResult {
  /** Paths inspected, including the ones already up to date. */
  scanned: number;
  /** Files submitted as puts. */
  uploaded: number;
  deleted: number;
  batches: number;
  /** Candidates whose content turned out identical to the record. */
  unchanged: number;
  /** Overwrite rows this push opened (a stale base). */
  conflicts: number;
  /** Paths left alone because they exceed the size cap. */
  tooLarge: number;
  /** True when `shouldStop` asked the push to break early. */
  cancelled: boolean;
}

export interface PushDeps {
  api: Api;
  state: State;
  adapter: DataAdapter;
  folder: FolderDto;
  ignore: Ignore;
  listPaths: () => string[];
  log: (message: string, error?: unknown) => void;
  /** Files larger than this are not read, uploaded or deleted. */
  maxFileSizeBytes: number;
  /** Cooperative cancellation, checked between files and batches. */
  shouldStop?: () => boolean;
  /** Called with the number of candidate files handled. */
  onProgress?: (done: number) => void;
}

interface PutItem {
  kind: "put";
  path: string;
  size: number;
  mtimeMs: number;
  chunks: ChunkRefDto[];
  baseVersionId: number | null;
}

interface DeleteItem {
  kind: "delete";
  path: string;
  baseVersionId: number | null;
}

type Work = PutItem | DeleteItem;

export class Pusher {
  constructor(private readonly deps: PushDeps) {}

  async push(scope: Set<string> | null): Promise<PushResult> {
    const { api, state, adapter, ignore } = this.deps;
    const since = await state.appliedSeq();
    const known = await state.allFiles();

    const scan = await scanVault({
      adapter,
      state,
      ignore,
      listPaths: this.deps.listPaths,
      scope,
      maxFileSizeBytes: this.deps.maxFileSizeBytes,
    } satisfies ScanDeps);

    const result: PushResult = {
      scanned: scan.scanned.size,
      uploaded: 0,
      deleted: 0,
      batches: 0,
      unchanged: 0,
      conflicts: 0,
      tooLarge: scan.tooLarge.length,
      cancelled: false,
    };
    if (scan.tooLarge.length > 0) {
      this.deps.log(
        `${scan.tooLarge.length} file(s) exceed the size cap and were left alone`,
      );
    }
    const work: Work[] = [];
    const uploaded = new Set<string>();
    let handled = 0;

    for (const path of scan.candidates) {
      if (this.deps.shouldStop?.()) {
        result.cancelled = true;
        break;
      }
      handled += 1;
      this.deps.onProgress?.(handled);
      const entry = scan.present.get(path);
      if (!entry) continue;

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await adapter.readBinary(path));
      } catch (error) {
        // Vanished mid-scan, or unreadable. The next scan sees the truth.
        this.deps.log(`could not read ${path}; leaving it for the next cycle`, error);
        continue;
      }

      const chunks = await hashChunks(bytes);
      const record = known.get(path);
      const refs = chunkRefs(chunks);
      if (record && record.versionId > 0 && sameChunks(record.chunks, refs)) {
        // The timestamp moved but the content did not.
        await state.setFile({
          ...record,
          size: bytes.length,
          mtimeMs: entry.mtimeMs,
        });
        result.unchanged += 1;
        continue;
      }

      const toUpload: HashedChunk[] = [];
      const queued = new Set<string>();
      for (const chunk of chunks) {
        if (uploaded.has(chunk.hash) || queued.has(chunk.hash)) continue;
        queued.add(chunk.hash);
        toUpload.push(chunk);
      }
      await mapLimit(toUpload, UPLOAD_CONCURRENCY, async (chunk) => {
        await api.putChunk(chunk.hash, chunk.data);
      });
      for (const chunk of toUpload) uploaded.add(chunk.hash);

      work.push({
        kind: "put",
        path,
        size: bytes.length,
        mtimeMs: entry.mtimeMs,
        chunks: refs,
        baseVersionId: record && record.versionId > 0 ? record.versionId : null,
      });
    }

    for (const path of scan.scanned) {
      if (scan.present.has(path)) continue;
      const record = known.get(path);
      if (!record) continue;
      work.push({
        kind: "delete",
        path,
        baseVersionId: record.versionId > 0 ? record.versionId : null,
      });
    }

    if (work.length === 0) return result;

    // `applied_seq` is global across folders; only a contiguous run from the
    // previous value may move the watermark.
    let watermark = since;
    for (let at = 0; at < work.length; at += BATCH_SIZE) {
      const batch = work.slice(at, at + BATCH_SIZE);
      const ops: OpDto[] = batch.map((item) =>
        item.kind === "put"
          ? {
              base_seq: since,
              base_version_id: item.baseVersionId,
              kind: "put",
              path: encodePath(item.path),
              size: item.size,
              mtime_ns: Math.round(item.mtimeMs) * 1_000_000,
              // This client cannot express POSIX modes; 0 is the documented
              // wildcard, equal to any mode on every other client.
              mode: 0,
              chunks: item.chunks,
            }
          : {
              base_seq: since,
              base_version_id: item.baseVersionId,
              kind: "delete",
              path: encodePath(item.path),
              size: 0,
              mtime_ns: 0,
              mode: 0,
              chunks: [],
            },
      );

      const response = await api.submitOps(this.deps.folder.id, ops);
      if (response.applied.length !== batch.length) {
        throw new Error(
          `server acknowledged ${response.applied.length} of ${batch.length} ops`,
        );
      }
      result.conflicts += response.overwrites.length;

      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]!;
        const applied = response.applied[index]!;
        if (item.kind === "delete") {
          await state.removeFile(item.path);
        } else {
          await state.setFile({
            path: item.path,
            versionId: applied.version_id,
            size: item.size,
            mtimeMs: item.mtimeMs,
            chunks: item.chunks,
          });
          result.uploaded += 1;
        }
        if (item.kind === "delete") result.deleted += 1;
        // Our version is newer than anything we were holding back for this
        // path; the held-back remote version is already in server history.
        await state.removePending(item.path);
      }

      watermark = advanceWatermark(
        watermark,
        response.applied.map((applied) => applied.seq),
      );
      await state.setAppliedSeq(watermark);
      result.batches += 1;
    }

    return result;
  }
}
