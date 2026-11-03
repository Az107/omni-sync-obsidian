/**
 * The `/api/v1` client. Mirrors `omni-netproto`'s DTOs; field names stay
 * snake_case so the JSON reads like the server's and a mismatch is visible.
 *
 * Transport is Obsidian's `requestUrl` for request/response calls: it runs in
 * the app's main process, so it is not subject to CORS (the app's origin is
 * `app://` on desktop and `capacitor://` on mobile). The op-log stream uses
 * `fetch`, which is the only API that can stream; the server sends CORS headers
 * for exactly that reason, and the poll is the fallback when it fails.
 *
 * Responses are normalised at this boundary. A server older than the folder
 * policy migration omits `exclude` / `preserve_permissions`, and trusting the
 * TypeScript type there would crash or silently sync `.obsidian`.
 */

import { requestUrl } from "obsidian";

import { encodePath } from "./paths";

/** Bumped only when the wire shape changes incompatibly (`PROTOCOL_VERSION`). */
export const PROTOCOL_VERSION = 1;

export interface EnrollRequest {
  code: string;
  name: string;
  protocol_version: number;
}

export interface EnrollResponse {
  device_id: string;
  token: string;
}

export interface ChunkRefDto {
  hash: string;
  len: number;
}

export type OpKindDto = "put" | "delete" | "move" | "resolve";

export interface OpDto {
  base_seq: number;
  base_version_id?: number | null;
  kind: OpKindDto;
  path: string;
  from?: string | null;
  size: number;
  mtime_ns: number;
  mode: number;
  chunks: ChunkRefDto[];
  restored_from?: number | null;
}

export interface SubmitOpsRequest {
  ops: OpDto[];
}

export interface AppliedOpDto {
  seq: number;
  version_id: number;
}

export interface OverwriteDto {
  id: number | null;
  path: string;
  losing_version_id: number;
  winning_version_id: number;
  folder_id: string | null;
}

export interface MemberDto {
  device_id: string;
  device_name: string;
  root_path: string;
  mode: string;
  acked_seq: number;
}

export interface SubmitOpsResponse {
  applied: AppliedOpDto[];
  overwrites: OverwriteDto[];
}

export interface FolderDto {
  id: string;
  name: string;
  exclude: string[];
  preserve_permissions: boolean;
}

export interface FoldersResponse {
  folders: FolderDto[];
}

export interface ManifestEntryDto {
  path: string;
  version_id: number;
  size: number;
  mtime_ns: number;
  mode: number;
  chunks: ChunkRefDto[];
}

export interface ManifestResponse {
  entries: ManifestEntryDto[];
}

export interface LogEntryDto {
  seq: number;
  version_id: number;
  kind: OpKindDto;
  path: string;
  device_id: string;
  size: number;
  mtime_ns: number;
  mode: number;
  chunks: ChunkRefDto[];
}

export interface OpsResponse {
  entries: LogEntryDto[];
  /** Seq to pass as `since` next; the last entry's seq when non-empty. */
  next: number;
  has_more: boolean;
}

export interface HeadResponse {
  head: number;
}

export interface DeletedFileDto {
  path: string;
  version_id: number;
  size: number;
  deleted_at: string;
}

export interface DeletedFilesResponse {
  files: DeletedFileDto[];
}

export interface DeviceDto {
  id: string;
  name: string;
}

export interface HistoryEntryDto {
  version_id: number;
  seq: number;
  device_id: string;
  base_version_id?: number | null;
  size: number;
  mtime_ns: number;
  mode: number;
  restored_from: number | null;
  created_at: string;
  active: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}

export interface UpdateFolderRequest {
  exclude?: string[];
  preserve_permissions?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  body?: string | ArrayBuffer;
  contentType?: string;
}

interface ParsedResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
}

export class Api {
  private readonly base: string;
  private readonly token: string | null;

  /** Page size for `opsSince`; the server clamps it. */
  static readonly OP_PAGE = 500;

  constructor(server: string, token: string | null = null) {
    const trimmed = server.trim();
    if (!trimmed) throw new Error("a server URL is required");
    // Same normalisation as `omni_transfer::Client`: a trailing slash makes
    // `new URL` append *under* a deployment sub-path.
    this.base = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    this.token = token;
  }

  withToken(token: string): Api {
    return new Api(this.base, token);
  }

  get server(): string {
    return this.base;
  }

  async health(): Promise<HealthResponse> {
    const response = await this.request("healthz", {});
    return response.json as HealthResponse;
  }

  async enroll(code: string, name: string): Promise<EnrollResponse> {
    const body: EnrollRequest = {
      code: code.trim(),
      name,
      protocol_version: PROTOCOL_VERSION,
    };
    const response = await this.request("api/v1/devices/enroll", {
      method: "POST",
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    return response.json as EnrollResponse;
  }

  async listFolders(): Promise<FolderDto[]> {
    const response = await this.request("api/v1/folders", {});
    const folders = (response.json as FoldersResponse).folders ?? [];
    return folders.map(normalizeFolder);
  }

  async getFolder(folderId: string): Promise<FolderDto> {
    const response = await this.request(`api/v1/folders/${folderId}`, {});
    return normalizeFolder(response.json as FolderDto);
  }

  async listMembers(folderId: string): Promise<MemberDto[]> {
    const response = await this.request(`api/v1/folders/${folderId}/members`, {});
    const members = (response.json as { members: MemberDto[] }).members ?? [];
    return members.map((member) => ({
      ...member,
      device_name: member.device_name || member.device_id,
    }));
  }

  async createFolder(
    name: string,
    exclude: string[],
    preservePermissions: boolean,
  ): Promise<FolderDto> {
    const response = await this.request("api/v1/folders", {
      method: "POST",
      body: JSON.stringify({
        name,
        exclude,
        preserve_permissions: preservePermissions,
      }),
      contentType: "application/json",
    });
    return normalizeFolder(response.json as FolderDto);
  }

  async updateFolder(folderId: string, request: UpdateFolderRequest): Promise<FolderDto> {
    const response = await this.request(`api/v1/folders/${folderId}`, {
      method: "PATCH",
      body: JSON.stringify(request),
      contentType: "application/json",
    });
    return normalizeFolder(response.json as FolderDto);
  }

  async registerMember(folderId: string, rootPath: string, mode = "both"): Promise<void> {
    await this.request(`api/v1/folders/${folderId}/members`, {
      method: "POST",
      body: JSON.stringify({ root_path: rootPath, mode }),
      contentType: "application/json",
    });
  }

  /** Rename the calling device on the server. */
  async renameDevice(name: string): Promise<DeviceDto> {
    const response = await this.request("api/v1/devices/me", {
      method: "PATCH",
      body: JSON.stringify({ name }),
      contentType: "application/json",
    });
    return response.json as DeviceDto;
  }

  /** Revoke the calling device's token. Best effort before local unpair. */
  async revokeDevice(): Promise<void> {
    await this.request("api/v1/devices/me", { method: "DELETE" });
  }

  async manifest(folderId: string): Promise<ManifestResponse> {
    const response = await this.request(`api/v1/folders/${folderId}/manifest`, {});
    return response.json as ManifestResponse;
  }

  /** The folder's current op-log head, used to seed a first sync. */
  async head(folderId: string): Promise<number> {
    const response = await this.request(`api/v1/folders/${folderId}/head`, {});
    return (response.json as HeadResponse).head ?? 0;
  }

  async opsSince(
    folderId: string,
    since: number,
    limit: number | null = null,
  ): Promise<OpsResponse> {
    const page = limit ?? Api.OP_PAGE;
    const response = await this.request(
      `api/v1/folders/${folderId}/ops?since=${since}&limit=${page}`,
      {},
    );
    const body = response.json as Partial<OpsResponse>;
    const entries = body.entries ?? [];
    // An older server ignores `limit` and omits the page fields; treat its
    // response as the last page so the caller's loop still terminates.
    return {
      entries,
      next: body.next ?? entries.at(-1)?.seq ?? since,
      has_more: body.has_more === true,
    };
  }

  /** Unresolved overwrite rows, across folders. */
  async overwrites(): Promise<OverwriteDto[]> {
    const response = await this.request("api/v1/overwrites", {});
    const rows = (response.json as OverwriteDto[]) ?? [];
    return rows.map((row) => ({
      id: typeof row.id === "number" ? row.id : null,
      path: row.path,
      losing_version_id: row.losing_version_id,
      winning_version_id: row.winning_version_id,
      folder_id: typeof row.folder_id === "string" ? row.folder_id : null,
    }));
  }

  /** Mark an overwrite row "keep the active version". */
  async dismissOverwrite(id: number): Promise<void> {
    await this.request(`api/v1/overwrites/${id}/dismiss`, { method: "POST" });
  }

  /** Deleted paths that still have a content version to restore. */
  async deleted(folderId: string): Promise<DeletedFileDto[]> {
    try {
      const response = await this.request(`api/v1/folders/${folderId}/deleted`, {});
      return (response.json as DeletedFilesResponse).files ?? [];
    } catch (error) {
      // A server from before this endpoint: show an empty trash, not an error.
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  }

  async submitOps(folderId: string, ops: OpDto[]): Promise<SubmitOpsResponse> {
    const request: SubmitOpsRequest = { ops };
    const response = await this.request(`api/v1/folders/${folderId}/ops`, {
      method: "POST",
      body: JSON.stringify(request),
      contentType: "application/json",
    });
    const body = response.json as SubmitOpsResponse;
    return {
      applied: body.applied ?? [],
      overwrites: (body.overwrites ?? []).map((row) => ({
        id: typeof row.id === "number" ? row.id : null,
        path: row.path,
        losing_version_id: row.losing_version_id,
        winning_version_id: row.winning_version_id,
        folder_id: typeof row.folder_id === "string" ? row.folder_id : null,
      })),
    };
  }

  async history(folderId: string, path: string): Promise<HistoryEntryDto[]> {
    const response = await this.request(
      `api/v1/folders/${folderId}/history?path=${encodeURIComponent(encodePath(path))}`,
      {},
    );
    const entries = (response.json as { entries: HistoryEntryDto[] }).entries ?? [];
    return entries.map((entry) => ({
      ...entry,
      active: entry.active === true,
      restored_from: entry.restored_from ?? null,
    }));
  }

  async resolve(
    folderId: string,
    path: string,
    restoredFrom: number,
  ): Promise<SubmitOpsResponse> {
    const response = await this.request(`api/v1/folders/${folderId}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        path: encodePath(path),
        restored_from: restoredFrom,
      }),
      contentType: "application/json",
    });
    return response.json as SubmitOpsResponse;
  }

  /** Upload a chunk. `false` means the server already had it. */
  async putChunk(hash: string, bytes: Uint8Array): Promise<boolean> {
    // `bytes` is usually a view into the whole file (a chunk slice), and
    // `fetch`/requestUrl would send the *underlying* buffer — the entire file.
    // Copy exactly this view.
    const exact = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const response = await this.request(`api/v1/chunks/${hash}`, {
      method: "PUT",
      body: exact,
      contentType: "application/octet-stream",
    });
    return Boolean((response.json as { created: boolean }).created);
  }

  /** Download a chunk, or `null` when the server does not have it. */
  async getChunk(hash: string): Promise<Uint8Array | null> {
    const response = await requestUrl({
      url: this.endpoint(`api/v1/chunks/${hash}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, response.text);
    }
    return new Uint8Array(response.arrayBuffer);
  }

  /**
   * Consume the server's op-log SSE stream, calling `onHead` for each event.
   *
   * Resolves when the stream ends, the signal aborts, or the platform has no
   * streaming `fetch`; the caller keeps polling either way.
   */
  async streamOps(
    folderId: string,
    signal: AbortSignal,
    onHead: (head: number) => void,
  ): Promise<void> {
    if (typeof fetch !== "function") {
      throw new Error("streaming fetch is unavailable");
    }
    const response = await fetch(this.endpoint(`api/v1/folders/${folderId}/ops/stream`), {
      method: "GET",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }
    const body = response.body;
    if (!body) throw new Error("the server did not stream the op log");

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = takeHeads(buffer);
        buffer = parsed.rest;
        for (const head of parsed.heads) onHead(head);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(path: string, options: RequestOptions): Promise<ParsedResponse> {
    const response = await requestUrl({
      url: this.endpoint(path),
      method: options.method ?? "GET",
      headers: this.headers(),
      body: options.body,
      contentType: options.contentType,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      let message = response.text;
      try {
        const parsed = JSON.parse(response.text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // Not JSON; the raw body is the best message available.
      }
      throw new ApiError(response.status, message || `HTTP ${response.status}`);
    }
    let json: unknown = null;
    if (response.text) {
      try {
        json = JSON.parse(response.text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      text: response.text,
      arrayBuffer: response.arrayBuffer,
      json,
    };
  }

  private endpoint(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.base).toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }
}

function normalizeFolder(raw: FolderDto): FolderDto {
  return {
    id: String(raw?.id ?? ""),
    name: String(raw?.name ?? ""),
    exclude: Array.isArray(raw?.exclude)
      ? raw.exclude.filter((pattern): pattern is string => typeof pattern === "string")
      : [],
    preserve_permissions: raw?.preserve_permissions !== false,
  };
}

/**
 * Pull whole SSE frames out of an accumulating buffer.
 *
 * Exported for the unit test: the stream parser is the part of SSE that is easy
 * to get subtly wrong (a frame split across reads, a keep-alive comment).
 */
export function takeHeads(buffer: string): { heads: number[]; rest: string } {
  const heads: number[] = [];
  let rest = buffer;
  for (;;) {
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    let index = -1;
    let width = 2;
    if (lf >= 0 && (crlf < 0 || lf < crlf)) {
      index = lf;
      width = 2;
    } else if (crlf >= 0) {
      index = crlf;
      width = 4;
    }
    if (index < 0) break;

    const frame = rest.slice(0, index);
    rest = rest.slice(index + width);
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) {
        const value = Number(line.slice(5).trim());
        if (Number.isFinite(value)) heads.push(value);
      }
    }
  }
  return { heads, rest };
}
