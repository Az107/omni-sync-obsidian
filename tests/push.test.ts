import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";

import { Ignore, VAULT_EXCLUDES } from "../src/ignore";
import { decodePath } from "../src/paths";
import { Pusher } from "../src/push";
import { FakeAdapter, FakeApi, FakeState, asApi, asState, folderDefaults } from "./fakes";

function makePusher(options: {
  api: FakeApi;
  state: FakeState;
  adapter: FakeAdapter;
  ignore?: Ignore;
  maxFileSizeBytes?: number;
  shouldStop?: () => boolean;
}) {
  return new Pusher({
    api: asApi(options.api),
    state: asState(options.state),
    adapter: options.adapter as unknown as DataAdapter,
    folder: folderDefaults,
    ignore: options.ignore ?? new Ignore([]),
    listPaths: () => [...options.adapter.files.keys()],
    log: () => {},
    maxFileSizeBytes: options.maxFileSizeBytes ?? 10 * 1024 * 1024,
    shouldStop: options.shouldStop,
  });
}

const path = "notes/todo.md";
const bytes = new TextEncoder().encode("# hello\n\nfirst note\n");

async function pushOne(): Promise<{
  api: FakeApi;
  state: FakeState;
  adapter: FakeAdapter;
  pusher: Pusher;
}> {
  const api = new FakeApi();
  const state = new FakeState();
  const adapter = new FakeAdapter();
  adapter.put(path, bytes);
  const pusher = makePusher({ api, state, adapter });
  await pusher.push(null);
  return { api, state, adapter, pusher };
}

describe("Pusher", () => {
  it("uploads a new file's chunk and submits a create", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put(path, bytes);

    const result = await makePusher({ api, state, adapter }).push(null);

    expect(result.uploaded).toBe(1);
    expect(api.submissions).toHaveLength(1);
    const op = api.submissions[0]![0]!;
    expect(decodePath(op.path)).toBe(path);
    expect(op.kind).toBe("put");
    expect(op.base_version_id).toBeNull();
    expect(op.mode).toBe(0);
    expect(op.chunks).toHaveLength(1);
    expect(op.size).toBe(bytes.length);

    expect(state.seq).toBe(1);
    expect(state.files.get(path)?.versionId).toBe(10);
    expect(state.files.get(path)?.chunks).toEqual(op.chunks);
  });

  it("does not read or re-push a file whose metadata is unchanged", async () => {
    const { api, state, pusher } = await pushOne();

    const second = await pusher.push(null);

    expect(second.scanned).toBe(1);
    expect(second.uploaded).toBe(0);
    expect(api.submissions).toHaveLength(1);
    expect(state.seq).toBe(1);
  });

  it("treats a timestamp-only change as no content change", async () => {
    const { api, state, adapter, pusher } = await pushOne();
    adapter.mtime += 1_000;

    const result = await pusher.push(null);

    expect(result.unchanged).toBe(1);
    expect(result.uploaded).toBe(0);
    expect(api.submissions).toHaveLength(1);
    // The new mtime is recorded so the next scan takes the fast path again.
    expect(state.files.get(path)?.mtimeMs).toBe(adapter.mtime);
  });

  it("submits an edit with the previous version as its base", async () => {
    const { api, state, adapter, pusher } = await pushOne();
    adapter.put(path, new TextEncoder().encode("version two, longer\n"));
    adapter.mtime += 2_000;

    const result = await pusher.push(null);

    expect(result.uploaded).toBe(1);
    expect(api.submissions).toHaveLength(2);
    const op = api.submissions[1]![0]!;
    expect(op.base_version_id).toBe(10);
    expect(state.files.get(path)?.versionId).toBe(20);
  });

  it("submits a delete with the last version as its base", async () => {
    const { api, state, adapter, pusher } = await pushOne();
    adapter.files.delete(path);

    const result = await pusher.push(null);

    expect(result.deleted).toBe(1);
    const op = api.submissions[1]![0]!;
    expect(op.kind).toBe("delete");
    expect(op.base_version_id).toBe(10);
    expect(state.files.has(path)).toBe(false);
  });

  it("does not delete a path a targeted scan did not look at", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put("a.md", bytes);
    adapter.put("b.md", bytes);
    const pusher = makePusher({ api, state, adapter });
    await pusher.push(null);

    // `a.md` vanished, but this scan only covers `b.md`.
    adapter.files.delete("a.md");
    const targeted = await pusher.push(new Set(["b.md"]));
    expect(targeted.deleted).toBe(0);
    expect(state.files.has("a.md")).toBe(true);

    const full = await pusher.push(null);
    expect(full.deleted).toBe(1);
    expect(state.files.has("a.md")).toBe(false);
  });

  it("batches large pushes and advances only across the contiguous run", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    for (let index = 0; index < 101; index += 1) {
      adapter.put(`notes/${index}.md`, new TextEncoder().encode(`note ${index}\n`));
    }
    const pusher = makePusher({ api, state, adapter });

    const result = await pusher.push(null);

    expect(result.batches).toBe(2);
    expect(api.submissions.map((batch) => batch.length)).toEqual([100, 1]);
    expect(state.seq).toBe(101);
  });

  it("leaves the watermark behind a foreign op", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put(path, bytes);
    // Another device took the first 100 op ids on the global sequence.
    api.seq = 100;

    await makePusher({ api, state, adapter }).push(null);

    expect(state.seq).toBe(0);
  });

  it("never pushes an excluded path", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put(".obsidian/workspace.json", new TextEncoder().encode("{}"));
    adapter.put(".trash/old.md", bytes);
    adapter.put(".obsidian/appearance.json", new TextEncoder().encode("{}"));
    adapter.put(path, bytes);

    const result = await makePusher({
      api,
      state,
      adapter,
      ignore: new Ignore(VAULT_EXCLUDES),
    }).push(null);

    // `appearance.json` is content and syncs; the volatile files never do.
    expect(result.uploaded).toBe(2);
    const paths = api.submissions[0]!.map((op) => decodePath(op.path)).sort();
    expect(paths).toEqual([".obsidian/appearance.json", path]);
  });

  it("drops a held-back remote update once the local version is pushed", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", path, new TextEncoder().encode("remote\n"));
    await state.setPending({ path, entry });
    adapter.put(path, bytes);

    await makePusher({ api, state, adapter }).push(null);

    expect(state.pending.has(path)).toBe(false);
  });

  it("reports the overwrite rows a stale push opens", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put(path, bytes);
    api.overwriteOnSubmit = true;

    const result = await makePusher({ api, state, adapter }).push(null);

    expect(result.conflicts).toBe(1);
  });

  it("keeps trusting mtime for a same-size edit (the triage trade-off)", async () => {
    const { api, state, adapter, pusher } = await pushOne();
    // Same length and mtime, different bytes: the metadata fast path cannot see
    // it. A content verify is `reset`.
    adapter.put(path, new TextEncoder().encode("# HELLO\n\nfirst note\n"));
    const result = await pusher.push(null);
    expect(result.uploaded).toBe(0);
    expect(api.submissions).toHaveLength(1);
    expect(state.files.get(path)?.versionId).toBe(10);
  });

  it("does not push a file above the size cap", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put("big.bin", new Uint8Array(50));

    const result = await makePusher({
      api,
      state,
      adapter,
      maxFileSizeBytes: 10,
    }).push(null);

    expect(result.tooLarge).toBe(1);
    expect(result.uploaded).toBe(0);
    expect(api.submissions).toHaveLength(0);
  });

  it("does not delete a previously synced file that grew over the cap", async () => {
    const { api, state, adapter } = await pushOne();
    adapter.put(path, new Uint8Array(50));
    adapter.mtime += 2_000;

    const result = await makePusher({
      api,
      state,
      adapter,
      maxFileSizeBytes: 10,
    }).push(null);

    expect(result.tooLarge).toBe(1);
    expect(result.deleted).toBe(0);
    expect(api.submissions).toHaveLength(1);
    expect(state.files.has(path)).toBe(true);
  });

  it("stops between files when cancellation is requested", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    adapter.put("a.md", bytes);
    adapter.put("b.md", bytes);

    const result = await makePusher({
      api,
      state,
      adapter,
      shouldStop: () => true,
    }).push(null);

    expect(result.cancelled).toBe(true);
    expect(api.submissions).toHaveLength(0);
  });

  it("uploads every chunk of a multi-chunk file with its own bytes", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 1) big[at] = (at * 31) % 251;
    adapter.put("big.bin", big);

    const result = await makePusher({ api, state, adapter }).push(null);

    expect(result.uploaded).toBe(1);
    const op = api.submissions[0]![0]!;
    expect(op.chunks.length).toBeGreaterThan(1);
    const stored = op.chunks.map((chunk) => api.chunks.get(chunk.hash)!);
    expect(stored.reduce((total, chunk) => total + chunk.length, 0)).toBe(big.length);
  });
});
