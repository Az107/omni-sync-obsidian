/**
 * Opt-in interop test: drives the real `Api` + `Pusher` + `Puller` against a
 * running omni-sync server, with real directories as the vaults.
 *
 * Skipped by `npm test`. Run it with:
 *
 * ```sh
 * OMNI_SERVER=http://127.0.0.1:8799 OMNI_TOKEN=osn_... \
 *   npx vitest run tests/interop.test.ts
 * ```
 *
 * It mocks Obsidian's `requestUrl` with Node's `fetch`, which is the only part
 * of the engine the unit tests cannot exercise (the URL building, the bearer
 * header and the binary body are what this covers). It creates its own folder,
 * so it can be re-run against the same server.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

interface RequestUrlRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

function nodeRequestUrl(request: RequestUrlRequest) {
  return fetch(request.url, {
    method: request.method ?? "GET",
    headers: {
      ...(request.headers ?? {}),
      ...(request.contentType ? { "Content-Type": request.contentType } : {}),
    },
    body: request.body as BodyInit | undefined,
  }).then(async (response) => {
    const buffer = await response.arrayBuffer();
    return {
      status: response.status,
      headers: {},
      text: new TextDecoder().decode(buffer),
      arrayBuffer: buffer,
      json: null,
    };
  });
}

vi.mock("obsidian", () => ({ requestUrl: nodeRequestUrl }));

const { Api } = await import("../src/api");
const { Ignore, VAULT_EXCLUDES } = await import("../src/ignore");
const { decodePath, encodePath } = await import("../src/paths");
const { Pusher } = await import("../src/push");
const { Puller } = await import("../src/sync");
const { FakeState } = await import("./fakes");
const { splitmixBytes } = await import("./fixtures");

class DiskAdapter {
  constructor(readonly root: string) {}

  private full(path: string): string {
    return join(this.root, path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.full(path));
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = await readFile(this.full(path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await writeFile(this.full(path), Buffer.from(data));
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.full(from), this.full(to));
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.full(path), { recursive: true });
  }

  async stat(path: string) {
    try {
      const info = await stat(this.full(path));
      return {
        type: info.isDirectory() ? ("folder" as const) : ("file" as const),
        ctime: info.ctimeMs,
        mtime: info.mtimeMs,
        size: info.size,
      };
    } catch {
      return null;
    }
  }
}

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

const server = process.env.OMNI_SERVER;
const token = process.env.OMNI_TOKEN;
const enabled = Boolean(server && token);

const cleanup: string[] = [];

afterAll(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("live server interop", () => {
  it("pushes, pulls, edits, deletes and resolves a conflict", async () => {
    const api = new Api(server!, token!);
    const folder = await api.createFolder(
      `interop ${new Date().toISOString()}`,
      [...VAULT_EXCLUDES],
      false,
    );
    await api.registerMember(folder.id, encodePath("interop"), "both");
    const ignore = new Ignore(folder.exclude);

    const vaultA = await mkdtemp(join(tmpdir(), "omni-a-"));
    const vaultB = await mkdtemp(join(tmpdir(), "omni-b-"));
    cleanup.push(vaultA, vaultB);
    const adapterA = new DiskAdapter(vaultA);
    const adapterB = new DiskAdapter(vaultB);
    const stateA = new FakeState();
    const stateB = new FakeState();

    const pusher = (
      state: InstanceType<typeof FakeState>,
      adapter: DiskAdapter,
      vault: string,
    ) =>
      new Pusher({
        api,
        state: state as never,
        adapter: adapter as never,
        folder,
        ignore,
        listPaths: () => listFiles(vault),
        log: () => {},
        maxFileSizeBytes: 200 * 1024 * 1024,
      });
    const puller = (state: InstanceType<typeof FakeState>, adapter: DiskAdapter) =>
      new Puller({
        api,
        state: state as never,
        adapter: adapter as never,
        folder,
        ignore,
        log: () => {},
        markSelfWrite: () => {},
        maxFileSizeBytes: 200 * 1024 * 1024,
      });

    const pusherA = pusher(stateA, adapterA, vaultA);
    const pusherB = pusher(stateB, adapterB, vaultB);
    const pullerA = puller(stateA, adapterA);
    const pullerB = puller(stateB, adapterB);

    const note = new TextEncoder().encode("# hello\n\nfirst note\n");
    // 2 MiB of non-periodic bytes forces several chunks, which is what catches
    // an upload that sends the whole file buffer per chunk.
    const binary = splitmixBytes(2 * 1024 * 1024, 42);

    await mkdir(join(vaultA, "notes"), { recursive: true });
    await mkdir(join(vaultA, "assets"), { recursive: true });
    await writeFile(join(vaultA, "notes/todo.md"), note);
    await writeFile(join(vaultA, "assets/pic.bin"), binary);

    const pushed = await pusherA.push(null);
    expect(pushed.uploaded).toBe(2);

    // The SSE stream works through CORS and sends the current head immediately.
    const streamController = new AbortController();
    const streamedHead = new Promise<number>((resolve) => {
      void api
        .streamOps(folder.id, streamController.signal, (head) => resolve(head))
        .catch(() => {});
    });
    const headValue = await Promise.race([
      streamedHead,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("no head within 5s")), 5_000),
      ),
    ]);
    streamController.abort();
    expect(headValue).toBeGreaterThan(0);

    // A new vault is seeded from the head + manifest, not by replaying the log.
    const bootstrapped = await pullerB.bootstrap();
    expect(bootstrapped).toBe(true);
    expect(stateB.seq).toBe(await api.head(folder.id));
    expect(new Uint8Array(await readFile(join(vaultB, "notes/todo.md")))).toEqual(note);
    expect(new Uint8Array(await readFile(join(vaultB, "assets/pic.bin")))).toEqual(
      binary,
    );

    const edited = new TextEncoder().encode("# hello\n\nsecond version\n");
    await writeFile(join(vaultA, "notes/todo.md"), edited);
    const pushedEdit = await pusherA.push(new Set(["notes/todo.md"]));
    expect(pushedEdit.uploaded).toBe(1);

    const secondPull = await pullerB.pull();
    expect(secondPull.written).toBe(1);
    expect(new Uint8Array(await readFile(join(vaultB, "notes/todo.md")))).toEqual(edited);

    await rm(join(vaultA, "notes/todo.md"));
    const pushedDelete = await pusherA.push(null);
    expect(pushedDelete.deleted).toBe(1);

    const thirdPull = await pullerB.pull();
    expect(thirdPull.removed).toBe(1);
    await expect(readFile(join(vaultB, "notes/todo.md"))).rejects.toThrow();
    expect(new Uint8Array(await readFile(join(vaultB, "assets/pic.bin")))).toEqual(
      binary,
    );

    // --- deleted files are recoverable from their last content version ---
    const trashed = (await api.deleted(folder.id)).find(
      (row) => decodePath(row.path) === "notes/todo.md",
    );
    expect(trashed?.version_id).toBeGreaterThan(0);
    await api.resolve(folder.id, "notes/todo.md", trashed!.version_id);
    await pullerB.pull();
    expect(new Uint8Array(await readFile(join(vaultB, "notes/todo.md"))).toString()).toBe(
      edited.toString(),
    );

    // --- rename: the plugin marks both paths, the server sees delete + put ---
    const renamed = "assets/renamed.bin";
    await rename(join(vaultA, "assets/pic.bin"), join(vaultA, renamed));
    const pushedRename = await pusherA.push(new Set(["assets/pic.bin", renamed]));
    expect(pushedRename.deleted).toBe(1);
    expect(pushedRename.uploaded).toBe(1);

    const renamePull = await pullerB.pull();
    expect(renamePull.removed).toBe(1);
    expect(renamePull.written).toBe(1);
    await expect(readFile(join(vaultB, "assets/pic.bin"))).rejects.toThrow();
    expect(new Uint8Array(await readFile(join(vaultB, renamed)))).toEqual(binary);

    // --- offline conflict: both sides edit the same file from the same base ---
    const conflictPath = "notes/conflict.md";
    const original = new TextEncoder().encode("original\n");
    await writeFile(join(vaultA, conflictPath), original);
    await pusherA.push(new Set([conflictPath]));
    await pullerB.pull();
    expect(new Uint8Array(await readFile(join(vaultB, conflictPath)))).toEqual(original);

    const fromA = new TextEncoder().encode("A's edit\n");
    await writeFile(join(vaultA, conflictPath), fromA);
    await pusherA.push(new Set([conflictPath]));

    // B has not pulled A's edit; its base is still the original version.
    const fromB = new TextEncoder().encode("B's edit\n");
    await writeFile(join(vaultB, conflictPath), fromB);
    const conflictPush = await pusherB.push(new Set([conflictPath]));
    expect(conflictPush.uploaded).toBe(1);

    const rows = await api.overwrites();
    const row = rows.find(
      (candidate) =>
        candidate.folder_id === folder.id && decodePath(candidate.path) === conflictPath,
    );
    expect(row, "the stale push must open an overwrite row").toBeDefined();
    expect(row?.folder_id).toBe(folder.id);
    expect(typeof row?.id).toBe("number");

    // Restoring the losing version is a Resolve op: both devices converge on
    // it, and the server marks the path's review rows resolved.
    await api.resolve(folder.id, conflictPath, row!.losing_version_id);
    await pullerA.pull();
    await pullerB.pull();
    expect(new Uint8Array(await readFile(join(vaultA, conflictPath))).toString()).toBe(
      fromA.toString(),
    );
    expect(new Uint8Array(await readFile(join(vaultB, conflictPath))).toString()).toBe(
      fromA.toString(),
    );
    expect((await api.overwrites()).some((candidate) => candidate.id === row!.id)).toBe(
      false,
    );

    // A second conflict, dismissed this time: keep the active version.
    const secondA = new TextEncoder().encode("A's second edit\n");
    const secondB = new TextEncoder().encode("B's second edit\n");
    await writeFile(join(vaultA, conflictPath), secondA);
    await pusherA.push(new Set([conflictPath]));
    await writeFile(join(vaultB, conflictPath), secondB);
    await pusherB.push(new Set([conflictPath]));

    const second = (await api.overwrites()).find(
      (candidate) =>
        candidate.folder_id === folder.id && decodePath(candidate.path) === conflictPath,
    );
    expect(typeof second?.id).toBe("number");
    await api.dismissOverwrite(second!.id!);
    expect(
      (await api.overwrites()).some((candidate) => candidate.id === second!.id),
    ).toBe(false);

    // The active version is B's; A converges after a pull.
    await pullerA.pull();
    expect(new Uint8Array(await readFile(join(vaultA, conflictPath))).toString()).toBe(
      secondB.toString(),
    );

    // --- device rename and CORS, which the WebView client depends on ---
    const renamedDevice = await api.renameDevice("interop-renamed");
    expect(renamedDevice.name).toBe("interop-renamed");
    const members = await api.listMembers(folder.id);
    expect(members.some((member) => member.device_name === "interop-renamed")).toBe(true);

    const base = server!.endsWith("/") ? server! : `${server!}/`;
    const preflight = await fetch(new URL("api/v1/folders", base), {
      method: "OPTIONS",
      headers: {
        Origin: "app://obsidian.md",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(preflight.headers.get("access-control-allow-methods")).toBeTruthy();
  });
});
