import type {
  Api,
  ChunkRefDto,
  LogEntryDto,
  ManifestEntryDto,
  ManifestResponse,
  OpDto,
  SubmitOpsResponse,
} from "../src/api";
import { sha256Hex, split } from "../src/chunker";
import { decodePath, encodePath } from "../src/paths";
import type { FileRecord, PendingRecord, State } from "../src/state";

export interface Stat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/** The slice of `DataAdapter` the engine uses, backed by a Map. */
export class FakeAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  /** Final renames, i.e. files the puller actually wrote. */
  readonly renames: Array<{ from: string; to: string }> = [];
  mtime = 1_700_000_000_000;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`no such file: ${path}`);
    return bytes.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data.slice(0)));
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
    this.renames.push({ from, to });
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async stat(path: string): Promise<Stat | null> {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    return { type: "file", ctime: 1, mtime: this.mtime, size: bytes.length };
  }

  put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }
}

export class FakeState {
  seq = 0;
  readonly files = new Map<string, FileRecord>();
  readonly pending = new Map<string, PendingRecord>();

  async appliedSeq(): Promise<number> {
    return this.seq;
  }

  async setAppliedSeq(seq: number): Promise<void> {
    this.seq = seq;
  }

  async getFile(path: string): Promise<FileRecord | undefined> {
    return this.files.get(path);
  }

  async allFiles(): Promise<Map<string, FileRecord>> {
    return new Map(this.files);
  }

  async setFile(record: FileRecord): Promise<void> {
    this.files.set(record.path, record);
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async getPending(path: string): Promise<PendingRecord | undefined> {
    return this.pending.get(path);
  }

  async allPending(): Promise<PendingRecord[]> {
    return [...this.pending.values()];
  }

  async setPending(record: PendingRecord): Promise<void> {
    this.pending.set(record.path, record);
  }

  async removePending(path: string): Promise<void> {
    this.pending.delete(path);
  }

  async reset(): Promise<void> {
    this.files.clear();
    this.pending.clear();
    this.seq = 0;
  }
}

export class FakeApi {
  entries: LogEntryDto[] = [];
  readonly chunks = new Map<string, Uint8Array>();
  readonly submissions: OpDto[][] = [];
  seq = 0;
  /** Set to false to make the next submit fail. */
  accept = true;
  /** When true, the next submit reports one overwrite for its first op. */
  overwriteOnSubmit = false;
  /** Max entries per `opsSince` page; lower it in tests to force pagination. */
  pageSize = 500;
  opCalls = 0;

  async opsSince(
    _folderId: string,
    since: number,
    limit = this.pageSize,
  ): Promise<{ entries: LogEntryDto[]; next: number; has_more: boolean }> {
    this.opCalls += 1;
    const pending = this.entries.filter((entry) => entry.seq > since);
    const size = Math.min(limit, this.pageSize);
    const page = pending.slice(0, size);
    return {
      entries: page,
      next: page.at(-1)?.seq ?? since,
      has_more: pending.length > page.length,
    };
  }

  async head(): Promise<number> {
    return Math.max(this.entries.at(-1)?.seq ?? 0, this.seq);
  }

  async manifest(): Promise<ManifestResponse> {
    const latest = new Map<string, LogEntryDto>();
    for (const entry of this.entries) latest.set(decodePath(entry.path), entry);
    const entries: ManifestEntryDto[] = [];
    for (const entry of latest.values()) {
      if (entry.kind === "delete") continue;
      entries.push({
        path: entry.path,
        version_id: entry.version_id,
        size: entry.size,
        mtime_ns: entry.mtime_ns,
        mode: entry.mode,
        chunks: entry.chunks,
      });
    }
    return { entries };
  }

  async getChunk(hash: string): Promise<Uint8Array | null> {
    return this.chunks.get(hash) ?? null;
  }

  async putChunk(hash: string, bytes: Uint8Array): Promise<boolean> {
    const created = !this.chunks.has(hash);
    this.chunks.set(hash, bytes);
    return created;
  }

  async submitOps(_folderId: string, ops: OpDto[]): Promise<SubmitOpsResponse> {
    if (!this.accept) throw new Error("submit refused");
    this.submissions.push(ops);
    const applied = ops.map((op) => {
      this.seq += 1;
      return { seq: this.seq, version_id: op.kind === "delete" ? 0 : this.seq * 10 };
    });
    const first = ops[0];
    const overwrites =
      this.overwriteOnSubmit && first
        ? [
            {
              id: null,
              path: first.path,
              losing_version_id: 1,
              winning_version_id: applied[0]?.version_id ?? 0,
              folder_id: "f1",
            },
          ]
        : [];
    this.overwriteOnSubmit = false;
    return { applied, overwrites };
  }

  /** Build a remote op for pull tests. */
  async entry(
    kind: "put" | "delete",
    path: string,
    bytes: Uint8Array,
  ): Promise<LogEntryDto> {
    const chunks: ChunkRefDto[] = [];
    for (const chunk of split(bytes)) {
      const slice = bytes.subarray(chunk.offset, chunk.offset + chunk.len);
      const hash = await sha256Hex(slice);
      chunks.push({ hash, len: chunk.len });
      this.chunks.set(hash, slice);
    }
    this.seq += 1;
    return {
      seq: this.seq,
      version_id: kind === "delete" ? 0 : this.seq * 10,
      kind,
      path: encodePath(path),
      device_id: "remote",
      size: bytes.length,
      mtime_ns: 0,
      mode: 0,
      chunks: kind === "delete" ? [] : chunks,
    };
  }
}

export const folderDefaults = {
  id: "f1",
  name: "Vault",
  exclude: [] as string[],
  preserve_permissions: false,
};

export function asApi(api: FakeApi): Api {
  return api as unknown as Api;
}

export function asState(state: FakeState): State {
  return state as unknown as State;
}
