import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";

import { Ignore } from "../src/ignore";
import { Puller } from "../src/sync";
import { FakeAdapter, FakeApi, FakeState, asApi, asState, folderDefaults } from "./fakes";

function makePuller(options: {
  api: FakeApi;
  state: FakeState;
  adapter: FakeAdapter;
  ignore?: Ignore;
  isOpen?: (path: string) => boolean;
  markSelfWrite?: (path: string) => void;
  maxFileSizeBytes?: number;
}) {
  return new Puller({
    api: asApi(options.api),
    state: asState(options.state),
    adapter: options.adapter as unknown as DataAdapter,
    folder: folderDefaults,
    ignore: options.ignore ?? new Ignore([]),
    log: () => {},
    isOpen: options.isOpen,
    maxFileSizeBytes: options.maxFileSizeBytes ?? 10 * 1024 * 1024,
    markSelfWrite: options.markSelfWrite,
  });
}

const bytes = new TextEncoder().encode("# hello\n\nfirst note\n");
const path = "notes/todo.md";

describe("Puller", () => {
  it("writes a pulled file and records its version", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", path, bytes));

    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.written).toBe(1);
    expect(adapter.files.get(path)).toEqual(bytes);
    expect(state.seq).toBe(1);
    expect(state.files.get(path)?.versionId).toBe(10);
  });

  it("does not rewrite an echo of a version it already holds", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", path, bytes));
    await makePuller({ api, state, adapter }).pull();

    state.seq = 0;
    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(state.seq).toBe(1);
  });

  it("skips an excluded path but still advances the watermark", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", ".obsidian/workspace.json", bytes));

    const ignore = new Ignore([".obsidian/workspace.json"]);
    const result = await makePuller({ api, state, adapter, ignore }).pull();

    expect(result.skipped).toBe(1);
    expect(adapter.files.size).toBe(0);
    expect(state.seq).toBe(1);
  });

  it("removes a deleted file", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", path, bytes));
    await makePuller({ api, state, adapter }).pull();

    api.entries.push(await api.entry("delete", path, new Uint8Array()));
    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.removed).toBe(1);
    expect(adapter.files.has(path)).toBe(false);
    expect(state.files.has(path)).toBe(false);
    expect(state.seq).toBe(2);
  });

  it("adopts an identical local file on first sync without rewriting it", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", path, bytes);
    api.entries.push(entry);
    adapter.put(path, bytes);

    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(state.files.get(path)?.versionId).toBe(entry.version_id);
  });

  it("keeps a differing local file on first sync and records a baseline", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const remote = new TextEncoder().encode("remote content that differs");
    const local = new TextEncoder().encode("my local draft");
    api.entries.push(await api.entry("put", path, remote));
    adapter.put(path, local);

    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.deferred).toBe(1);
    expect(result.written).toBe(0);
    expect(adapter.files.get(path)).toEqual(local);
    expect(state.files.get(path)?.versionId).toBe(0);
    expect(state.seq).toBe(1);
  });

  it("holds an update for an open file and applies it once closed", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", path, bytes);

    let open = true;
    const puller = makePuller({ api, state, adapter, isOpen: () => open });
    // The file is on disk because an editor has it open.
    adapter.put(path, new TextEncoder().encode("open buffer\n"));
    api.entries.push(entry);

    const first = await puller.pull();
    expect(first.skipped).toBe(1);
    expect(first.written).toBe(0);
    expect(state.pending.has(path)).toBe(true);
    // The watermark moved: the content is safely in `pending`.
    expect(state.seq).toBe(1);

    open = false;
    const second = await puller.pull();
    expect(second.written).toBe(1);
    expect(adapter.files.get(path)).toEqual(bytes);
    expect(state.pending.has(path)).toBe(false);
  });

  it("drops a held update that a later push superseded", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", path, bytes);
    await state.setPending({ path, entry });
    // The push already recorded a newer version for this path.
    await state.setFile({
      path,
      versionId: entry.version_id + 10,
      size: bytes.length,
      mtimeMs: adapter.mtime,
      chunks: entry.chunks,
    });

    const result = await makePuller({ api, state, adapter }).pull();

    expect(state.pending.has(path)).toBe(false);
    expect(result.written).toBe(0);
  });

  it("keeps a locally edited file when a newer remote version arrives", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const first = new TextEncoder().encode("version one\n");
    api.entries.push(await api.entry("put", path, first));
    await makePuller({ api, state, adapter }).pull();

    const localEdit = new TextEncoder().encode("my local edit\n");
    adapter.put(path, localEdit);
    adapter.mtime += 5_000;
    api.entries.push(
      await api.entry("put", path, new TextEncoder().encode("remote two\n")),
    );

    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.deferred).toBe(1);
    expect(result.written).toBe(0);
    expect(adapter.files.get(path)).toEqual(localEdit);
    // The old record is the base the push needs to open an overwrite row.
    expect(state.files.get(path)?.versionId).toBe(10);
  });

  it("refuses to apply a chunk that fails its hash", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", path, bytes);
    api.entries.push(entry);
    api.chunks.set(entry.chunks[0]!.hash, new TextEncoder().encode("tampered"));

    await expect(makePuller({ api, state, adapter }).pull()).rejects.toThrow(
      /failed verification/,
    );
    expect(state.seq).toBe(0);
  });

  it("pages the op log and applies every page", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.pageSize = 1;
    api.entries.push(await api.entry("put", "a.md", bytes));
    api.entries.push(await api.entry("put", "b.md", bytes));
    api.entries.push(await api.entry("put", "c.md", bytes));

    const result = await makePuller({ api, state, adapter }).pull();

    expect(result.entries).toBe(3);
    expect(adapter.files.size).toBe(3);
    expect(state.seq).toBe(3);
    expect(api.opCalls).toBeGreaterThanOrEqual(3);
  });

  it("bootstraps from the head and manifest instead of the log", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", "a.md", bytes));
    api.entries.push(await api.entry("put", "b.md", bytes));

    const bootstrapped = await makePuller({ api, state, adapter }).bootstrap();

    expect(bootstrapped).toBe(true);
    expect(state.seq).toBe(2);
    expect(adapter.files.has("a.md")).toBe(true);
    expect(adapter.files.has("b.md")).toBe(true);
    expect(adapter.renames.map((rename) => rename.to).sort()).toEqual(["a.md", "b.md"]);
    // The log was not replayed.
    expect(api.opCalls).toBe(0);
  });

  it("adopts an identical local file during bootstrap", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    const entry = await api.entry("put", "a.md", bytes);
    api.entries.push(entry);
    adapter.put("a.md", bytes);

    await makePuller({ api, state, adapter }).bootstrap();

    expect(adapter.renames).toHaveLength(0);
    expect(state.files.get("a.md")?.versionId).toBe(entry.version_id);
  });

  it("skips a remote file above the size cap but advances the watermark", async () => {
    const api = new FakeApi();
    const state = new FakeState();
    const adapter = new FakeAdapter();
    api.entries.push(await api.entry("put", "big.bin", new Uint8Array(50)));

    const result = await makePuller({
      api,
      state,
      adapter,
      maxFileSizeBytes: 10,
    }).pull();

    expect(result.tooLarge).toBe(1);
    expect(result.written).toBe(0);
    expect(adapter.files.has("big.bin")).toBe(false);
    expect(state.seq).toBe(1);
  });
});
