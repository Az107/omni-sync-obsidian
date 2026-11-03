import { Notice, Plugin, TFile } from "obsidian";

import {
  Api,
  ApiError,
  type DeletedFileDto,
  type FolderDto,
  type HistoryEntryDto,
  type OverwriteDto,
} from "./api";
import { describeError } from "./format";
import { HistoryModal } from "./history";
import { Ignore, VAULT_EXCLUDES, isDropping } from "./ignore";
import { OnboardingModal } from "./onboarding";
import { OverwritesModal } from "./overwrites";
import { decodePath } from "./paths";
import { Pusher, type PushResult } from "./push";
import { vaultWarnings } from "./safety";
import {
  defaultSettings,
  newVaultId,
  OmniSyncSettingTab,
  type OmniSyncSettings,
} from "./settings";
import { State } from "./state";
import { Puller, type PullResult } from "./sync";
import { TrashModal } from "./trash";

/** Polling cadence while Obsidian is visible and healthy. */
const POLL_BASE_MS = 5_000;
/** Backoff ceiling after repeated failures. */
const POLL_MAX_MS = 60_000;
/** Coalesce a burst of editor saves into one push. */
const DEBOUNCE_MS = 500;
/** A full scan catches anything the watcher missed (edits while closed). */
const FULL_SCAN_INTERVAL_MS = 5 * 60_000;
/** How long a write of ours may still produce vault events. */
const SELF_WRITE_TTL_MS = 3_000;
/** Coalesce SSE wake-ups; a big push emits many heads. */
const WAKE_DEBOUNCE_MS = 250;

export interface Connection {
  server: string;
  token: string;
  deviceId: string;
  deviceName: string;
  folder: FolderDto;
}

type SyncMode = "pull" | "push" | "full";
type StatusKind = "idle" | "ok" | "busy" | "error";

interface Summary {
  written: number;
  removed: number;
  uploaded: number;
  deleted: number;
  deferred: number;
  conflicts: number;
  tooLarge: number;
  cancelled: boolean;
}

export default class OmniSyncPlugin extends Plugin {
  // `Plugin` already declares `settings?: unknown`; narrowing it with `declare`
  // is the documented pattern and avoids emitting a field that overwrites it.
  declare settings: OmniSyncSettings;

  private state: State | null = null;
  private api: Api | null = null;
  private statusEl!: HTMLElement;
  private syncing = false;
  private lastFullScan = 0;
  /** Last known folder policy, for filtering events without a network call. */
  private ignore = new Ignore([]);
  /** Unresolved conflict rows, refreshed on a full scan. */
  private overwrites = 0;
  private safety: string[] = [];
  private safetyNotified = false;

  /** Paths that changed locally and still need a push. */
  private readonly dirty = new Set<string>();
  private debounce: number | null = null;
  /** Paths we just wrote, mapped to when: their vault events are ours. */
  private readonly selfWrites = new Map<string, number>();

  private pollTimer: number | null = null;
  private consecutiveFailures = 0;
  private revoked = false;
  private cancelRequested = false;
  private lastProgress = 0;

  private streamAbort: AbortController | null = null;
  private streamGeneration = 0;
  private wakeTimer: number | null = null;
  private wakePending = false;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new OmniSyncSettingTab(this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onclick = () => void this.syncNow(true);
    this.setStatus("idle", "not connected");

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(true),
    });
    this.addCommand({
      id: "cancel-sync",
      name: "Cancel the current sync",
      callback: () => this.cancelSync(),
    });
    this.addCommand({
      id: "connect",
      name: "Connect this vault to a server…",
      callback: () => new OnboardingModal(this.app, this).open(),
    });
    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume sync",
      callback: () => void this.togglePause(),
    });
    this.addCommand({
      id: "file-history",
      name: "Show version history for the current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.openHistory(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "review-conflicts",
      name: "Review conflicts",
      callback: () => this.openOverwrites(),
    });
    this.addCommand({
      id: "deleted-files",
      name: "Show deleted files",
      callback: () => this.openTrash(),
    });
    this.addCommand({
      id: "open-dashboard",
      name: "Open the server dashboard",
      callback: () => this.openDashboard(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("omni-sync: version history")
            .setIcon("history")
            .onClick(() => void this.openHistory(file.path)),
        );
      }),
    );

    // Mutation events drive the push. Access events are not subscribed to at
    // all, so a scan can never feed itself the way inotify can on Linux.
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onVaultChange(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultChange(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onVaultChange(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // The server refuses moves: a rename is a delete plus a put.
        this.onVaultChange(oldPath);
        this.onVaultChange(file.path);
      }),
    );

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) return;
      if (this.settings.eventStream) this.startStream();
      void this.sync({ mode: "full" });
    });

    this.register(() => {
      this.stopStream();
      if (this.debounce !== null) window.clearTimeout(this.debounce);
      if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
      if (this.wakeTimer !== null) window.clearTimeout(this.wakeTimer);
    });

    this.app.workspace.onLayoutReady(() => {
      void this.start();
    });
  }

  override onunload(): void {
    this.stopStream();
    this.state?.close();
    this.state = null;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<OmniSyncSettings> | null;
    this.settings = { ...defaultSettings(), ...stored };
    // A settings file from before vault ids existed still needs one.
    if (!this.settings.vaultId) this.settings.vaultId = newVaultId();
    if (
      !Number.isFinite(this.settings.maxFileSizeMb) ||
      this.settings.maxFileSizeMb <= 0
    ) {
      this.settings.maxFileSizeMb = 100;
    }
    this.settings.eventStream = this.settings.eventStream !== false;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Called by the onboarding modal once enrollment succeeds. */
  async adoptConnection(connection: Connection): Promise<void> {
    this.stopStream();
    this.state?.close();
    this.state = null;

    this.settings.server = connection.server;
    this.settings.deviceId = connection.deviceId;
    this.settings.deviceName = connection.deviceName;
    this.settings.folderId = connection.folder.id;
    this.settings.folderName = connection.folder.name;
    this.settings.exclude = connection.folder.exclude;
    this.settings.preservePermissions = connection.folder.preserve_permissions;
    this.settings.paused = false;
    this.revoked = false;
    this.consecutiveFailures = 0;
    await this.saveSettings();

    const state = await State.open(this.settings.vaultId);
    await state.setToken(connection.token);
    await state.setDeviceId(connection.deviceId);
    // A fresh pairing starts from a clean slate, even if this vault was paired
    // with another server or folder before.
    await state.reset();
    this.state = state;

    this.api = new Api(connection.server, connection.token);
    this.ignore = new Ignore(connection.folder.exclude);
    await this.syncNow(true);
    this.startStream();
    this.schedulePoll();
  }

  async start(): Promise<void> {
    this.checkSafety();
    if (!this.settings.folderId || !this.settings.server) {
      this.setStatus("idle", "not connected");
      return;
    }
    try {
      const state = await State.open(this.settings.vaultId);
      const token = await state.token();
      if (!token) {
        state.close();
        this.setStatus("idle", "not connected");
        return;
      }
      this.state = state;
      this.api = new Api(this.settings.server, token);
      this.ignore = new Ignore(this.settings.exclude);
      await this.sync({ mode: "full" });
      if (!this.revoked) this.startStream();
      this.schedulePoll();
    } catch (error) {
      console.error("omni-sync: could not start", error);
      this.setStatus("error", "not connected");
    }
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  async togglePause(): Promise<void> {
    this.settings.paused = !this.settings.paused;
    await this.saveSettings();
    this.setStatus(
      this.settings.paused ? "idle" : "ok",
      this.settings.paused ? "paused" : "ready",
    );
    if (this.settings.paused) {
      this.stopStream();
    } else {
      this.startStream();
      await this.sync({ mode: "full" });
    }
  }

  cancelSync(): void {
    if (!this.syncing) {
      new Notice("omni-sync: no sync is running");
      return;
    }
    this.cancelRequested = true;
    new Notice("omni-sync: stopping after the current file…");
  }

  async syncNow(manual: boolean): Promise<void> {
    await this.sync({ mode: "full" }, manual);
  }

  /**
   * One sync cycle.
   *
   * `applied_seq == 0` bootstraps from the manifest (or replays the log on an
   * old server), then pushes. Once initialized, the push runs first so an
   * offline edit is sequenced before an incoming op can overwrite it on disk.
   */
  private async sync(
    options: { mode: SyncMode; scope?: Set<string>; force?: Set<string> },
    manual = false,
  ): Promise<void> {
    if (!this.api || !this.state) {
      if (manual) new Notice("omni-sync: connect this vault first");
      return;
    }
    if (this.settings.paused) {
      if (manual) new Notice("omni-sync: sync is paused");
      return;
    }
    if (this.revoked) {
      if (manual) {
        new Notice("omni-sync: this device was revoked — reconnect the vault");
      }
      return;
    }
    if (this.syncing) {
      if (options.mode === "push" && options.scope) {
        for (const path of options.scope) this.dirty.add(path);
        this.schedulePush();
      } else if (manual) {
        new Notice("omni-sync: already syncing");
      }
      return;
    }

    this.syncing = true;
    this.cancelRequested = false;
    this.pruneSelfWrites();
    this.setStatus("busy", "syncing…");
    const summary: Summary = {
      written: 0,
      removed: 0,
      uploaded: 0,
      deleted: 0,
      deferred: 0,
      conflicts: 0,
      tooLarge: 0,
      cancelled: false,
    };
    let failed = false;

    try {
      const folder = await this.api.getFolder(this.settings.folderId);
      await this.adoptPolicy(folder);

      const applied = await this.state.appliedSeq();
      if (applied === 0) {
        const bootstrapped = await this.bootstrap(folder);
        if (!bootstrapped) {
          this.accumulate(summary, await this.pull(folder, options.force));
        }
        this.accumulate(summary, await this.push(folder, null));
        this.accumulate(summary, await this.pull(folder, options.force));
        this.lastFullScan = Date.now();
      } else {
        if (options.mode !== "pull") {
          const scope =
            options.mode === "full" ? null : (options.scope ?? new Set<string>());
          this.accumulate(summary, await this.push(folder, scope));
        }
        this.accumulate(summary, await this.pull(folder, options.force));
        if (options.mode === "full") this.lastFullScan = Date.now();
      }

      this.consecutiveFailures = 0;
      if (options.mode === "full" || applied === 0 || summary.conflicts > 0) {
        await this.refreshOverwriteCount();
      }

      const pending = (await this.state.allPending()).length;
      const suffix: string[] = [];
      if (this.overwrites > 0) {
        suffix.push(`${this.overwrites} conflict${this.overwrites === 1 ? "" : "s"}`);
      }
      if (pending > 0) suffix.push(`${pending} held`);
      if (summary.cancelled) suffix.push("cancelled");

      const text =
        describe(summary) + (suffix.length > 0 ? ` · ${suffix.join(" · ")}` : "");
      this.setStatus(
        summary.cancelled ? "idle" : summary.deferred > 0 ? "busy" : "ok",
        text,
      );
      if (manual) new Notice(`omni-sync: ${text}`);
      if (manual && summary.deferred > 0) {
        new Notice(
          `omni-sync: kept ${summary.deferred} local file(s) that differ from the server`,
          8_000,
        );
      }
    } catch (error) {
      failed = true;
      if (error instanceof ApiError && error.status === 401) {
        this.revoked = true;
        this.stopStream();
        this.setStatus("error", "reconnect");
        new Notice(
          "omni-sync: this device's token was rejected. Reconnect the vault.",
          0,
        );
      } else {
        this.consecutiveFailures += 1;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        this.setStatus("error", offline ? "offline" : "sync failed");
        console.warn("omni-sync: sync failed", error);
        if (options.mode === "push" && options.scope) {
          for (const path of options.scope) this.dirty.add(path);
        }
        if (manual) new Notice(`omni-sync: ${describeError(error)}`);
      }
    } finally {
      this.syncing = false;
      if (!failed && this.dirty.size > 0) this.schedulePush();
      if (this.wakePending) {
        this.wakePending = false;
        this.scheduleWake();
      }
    }
  }

  private async bootstrap(folder: FolderDto): Promise<boolean> {
    const bootstrapped = await this.makePuller(folder).bootstrap();
    if (bootstrapped) this.log("seeded the vault from the folder manifest");
    return bootstrapped;
  }

  private pull(folder: FolderDto, force?: Set<string>): Promise<PullResult> {
    return this.makePuller(folder, force).pull();
  }

  private makePuller(folder: FolderDto, force?: Set<string>): Puller {
    return new Puller({
      api: this.api!,
      state: this.state!,
      adapter: this.app.vault.adapter,
      folder,
      ignore: new Ignore(folder.exclude),
      log: this.log,
      // A user-requested restore must land even if the note is open; the
      // editor keeps the buffer and reloads the file.
      isOpen: (path) => (force?.has(path) ? false : this.isOpen(path)),
      markSelfWrite: (path) => this.markSelfWrite(path),
      maxFileSizeBytes: this.maxFileSizeBytes(),
      shouldStop: () => this.cancelRequested,
      onProgress: (done) => this.reportProgress("pulling", done),
    });
  }

  private push(folder: FolderDto, scope: Set<string> | null): Promise<PushResult> {
    return new Pusher({
      api: this.api!,
      state: this.state!,
      adapter: this.app.vault.adapter,
      folder,
      ignore: new Ignore(folder.exclude),
      listPaths: () => this.app.vault.getFiles().map((file) => file.path),
      log: this.log,
      maxFileSizeBytes: this.maxFileSizeBytes(),
      shouldStop: () => this.cancelRequested,
      onProgress: (done) => this.reportProgress("pushing", done),
    }).push(scope);
  }

  maxFileSizeBytes(): number {
    return Math.max(1, Math.round(this.settings.maxFileSizeMb)) * 1024 * 1024;
  }

  private reportProgress(phase: string, done: number): void {
    const now = Date.now();
    if (now - this.lastProgress < 400) return;
    this.lastProgress = now;
    this.setStatus("busy", `${phase} ${done}…`);
  }

  private accumulate(summary: Summary, result: PullResult | PushResult): void {
    summary.cancelled = summary.cancelled || result.cancelled;
    if ("uploaded" in result) {
      summary.uploaded += result.uploaded;
      summary.deleted += result.deleted;
      summary.conflicts += result.conflicts;
      summary.tooLarge += result.tooLarge;
    } else {
      summary.written += result.written;
      summary.removed += result.removed;
      summary.deferred += result.deferred;
      summary.tooLarge += result.tooLarge;
    }
  }

  private readonly log = (message: string, error?: unknown): void => {
    if (error) console.warn(`omni-sync: ${message}`, error);
    else console.info(`omni-sync: ${message}`);
  };

  // ---- polling --------------------------------------------------------------

  private pollDelay(): number {
    return Math.min(
      POLL_MAX_MS,
      POLL_BASE_MS * 2 ** Math.min(this.consecutiveFailures, 4),
    );
  }

  private schedulePoll(delay = this.pollDelay()): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.pollTick();
    }, delay);
  }

  private async pollTick(): Promise<void> {
    try {
      if (document.hidden || this.settings.paused || this.revoked) return;
      if (this.syncing) return;
      if (this.dirty.size > 0) {
        const scope = new Set(this.dirty);
        this.dirty.clear();
        await this.sync({ mode: "push", scope });
      } else if (Date.now() - this.lastFullScan >= FULL_SCAN_INTERVAL_MS) {
        await this.sync({ mode: "full" });
      } else {
        await this.sync({ mode: "pull" });
      }
    } finally {
      this.schedulePoll();
    }
  }

  // ---- event stream ---------------------------------------------------------

  private startStream(): void {
    if (!this.settings.eventStream || !this.api || this.revoked || this.settings.paused) {
      return;
    }
    this.stopStream();
    const generation = ++this.streamGeneration;
    const controller = new AbortController();
    this.streamAbort = controller;
    void this.runStream(generation, controller);
  }

  private async runStream(
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    let backoff = 1_000;
    while (
      !controller.signal.aborted &&
      generation === this.streamGeneration &&
      !this.revoked
    ) {
      try {
        await this.api!.streamOps(this.settings.folderId, controller.signal, () =>
          this.scheduleWake(),
        );
        backoff = 1_000;
      } catch (error) {
        if (controller.signal.aborted) return;
        // Mobile WebViews may not stream, or the server is unreachable. The
        // poll covers it; retry quietly with a cap.
        console.info(
          `omni-sync: op stream unavailable (${describeError(error)}); polling`,
        );
      }
      const wait = backoff;
      backoff = Math.min(backoff * 2, 30_000);
      await new Promise<void>((resolve) => window.setTimeout(resolve, wait));
    }
  }

  private stopStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.streamGeneration += 1;
  }

  private scheduleWake(): void {
    if (this.syncing) {
      this.wakePending = true;
      return;
    }
    if (this.wakeTimer !== null) return;
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      void this.sync({ mode: "pull" });
    }, WAKE_DEBOUNCE_MS);
  }

  // ---- vault events ---------------------------------------------------------

  private onVaultChange(path: string): void {
    if (!path || isDropping(path) || this.ignore.matches(path)) return;
    if (this.consumeSelfWrite(path)) return;
    this.dirty.add(path);
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      if (this.dirty.size === 0) return;
      const scope = new Set(this.dirty);
      this.dirty.clear();
      void this.sync({ mode: "push", scope });
    }, DEBOUNCE_MS);
  }

  private isOpen(path: string): boolean {
    let open = false;
    // Any file view, not just markdown: a canvas or PDF has the same problem.
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: { path: string } | null };
      if (view.file?.path === path) open = true;
    });
    return open;
  }

  private markSelfWrite(path: string): void {
    this.selfWrites.set(path, Date.now());
  }

  private consumeSelfWrite(path: string): boolean {
    const at = this.selfWrites.get(path);
    if (at === undefined) return false;
    this.selfWrites.delete(path);
    return Date.now() - at <= SELF_WRITE_TTL_MS;
  }

  private pruneSelfWrites(): void {
    const cutoff = Date.now() - SELF_WRITE_TTL_MS;
    for (const [path, at] of this.selfWrites) {
      if (at < cutoff) this.selfWrites.delete(path);
    }
  }

  /** Apply the server's folder policy locally, and persist it when it moved. */
  private async adoptPolicy(folder: FolderDto): Promise<void> {
    const changed =
      folder.preserve_permissions !== this.settings.preservePermissions ||
      folder.exclude.join("\u0000") !== this.settings.exclude.join("\u0000");
    if (!changed) return;

    this.settings.exclude = folder.exclude;
    this.settings.preservePermissions = folder.preserve_permissions;
    this.settings.folderName = folder.name;
    this.ignore = new Ignore(folder.exclude);
    await this.saveSettings();
  }

  // ---- settings actions -----------------------------------------------------

  async applyVaultPolicy(): Promise<void> {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    try {
      const folder = await this.api.updateFolder(this.settings.folderId, {
        exclude: [...VAULT_EXCLUDES],
        preserve_permissions: false,
      });
      await this.adoptPolicy(folder);
      new Notice("omni-sync: the vault preset is now the folder's policy");
    } catch (error) {
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }

  async saveExcludePolicy(text: string): Promise<void> {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    const exclude = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    try {
      const folder = await this.api.updateFolder(this.settings.folderId, {
        exclude,
      });
      await this.adoptPolicy(folder);
      new Notice("omni-sync: sync policy saved");
    } catch (error) {
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }

  async renameDeviceOnServer(name: string): Promise<void> {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice("omni-sync: a device name is required");
      return;
    }
    try {
      const device = await this.api.renameDevice(trimmed);
      this.settings.deviceName = device.name;
      await this.saveSettings();
      new Notice(`omni-sync: device renamed to “${device.name}”`);
    } catch (error) {
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }

  async setMaxFileSizeMb(value: number): Promise<void> {
    const mb = Math.max(1, Math.min(1024, Math.round(value)));
    if (!Number.isFinite(mb) || mb === this.settings.maxFileSizeMb) return;
    this.settings.maxFileSizeMb = mb;
    await this.saveSettings();
  }

  async setEventStream(enabled: boolean): Promise<void> {
    this.settings.eventStream = enabled;
    await this.saveSettings();
    if (enabled) this.startStream();
    else this.stopStream();
  }

  async unpair(): Promise<void> {
    const state = this.state;
    this.stopStream();
    if (this.api) {
      try {
        await this.api.revokeDevice();
      } catch (error) {
        // An old server has no self-revoke; disconnect locally anyway.
        console.info(`omni-sync: could not revoke the token (${describeError(error)})`);
      }
    }
    await state?.unpair();
    state?.close();
    this.state = null;
    this.api = null;
    this.settings.folderId = "";
    this.settings.folderName = "";
    this.settings.deviceId = "";
    this.overwrites = 0;
    await this.saveSettings();
    this.setStatus("idle", "not connected");
    new Notice("omni-sync: this vault is disconnected");
  }

  async resetState(): Promise<void> {
    if (!this.state) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    await this.state.reset();
    new Notice("omni-sync: local sync state cleared; re-applying the vault");
    await this.syncNow(true);
  }

  // ---- history, conflicts, trash -------------------------------------------

  get safetyWarnings(): string[] {
    return this.safety;
  }

  get conflictCount(): number {
    return this.overwrites;
  }

  async loadHistory(path: string): Promise<HistoryEntryDto[]> {
    if (!this.api) throw new Error("connect this vault first");
    return this.api.history(this.settings.folderId, path);
  }

  async deviceNames(): Promise<Map<string, string>> {
    if (!this.api) return new Map();
    const members = await this.api.listMembers(this.settings.folderId);
    return new Map(members.map((member) => [member.device_id, member.device_name]));
  }

  async restoreVersion(path: string, versionId: number): Promise<void> {
    if (!this.api) throw new Error("connect this vault first");
    await this.api.resolve(this.settings.folderId, path, versionId);
    new Notice(`omni-sync: restored ${path} to v${versionId}`);
    await this.sync({ mode: "pull", force: new Set([path]) });
    await this.refreshOverwriteCount();
  }

  async loadOverwrites(): Promise<OverwriteDto[]> {
    if (!this.api) return [];
    const rows = await this.api.overwrites();
    return rows.filter(
      (row) => !row.folder_id || row.folder_id === this.settings.folderId,
    );
  }

  async restoreOverwrite(row: OverwriteDto): Promise<void> {
    if (!this.api) throw new Error("connect this vault first");
    const path = decodePath(row.path);
    await this.api.resolve(
      row.folder_id ?? this.settings.folderId,
      path,
      row.losing_version_id,
    );
    this.overwrites = Math.max(0, this.overwrites - 1);
    new Notice(`omni-sync: restored ${path} to v${row.losing_version_id}`);
    await this.sync({ mode: "pull", force: new Set([path]) });
    await this.refreshOverwriteCount();
  }

  async dismissOverwrite(row: OverwriteDto): Promise<void> {
    if (!this.api) throw new Error("connect this vault first");
    if (row.id == null) {
      throw new Error("this server cannot dismiss conflicts; update the server");
    }
    await this.api.dismissOverwrite(row.id);
    this.overwrites = Math.max(0, this.overwrites - 1);
    new Notice("omni-sync: kept the active version");
  }

  async loadDeleted(): Promise<DeletedFileDto[]> {
    if (!this.api) return [];
    return this.api.deleted(this.settings.folderId);
  }

  async restoreDeleted(row: DeletedFileDto): Promise<void> {
    if (!this.api) throw new Error("connect this vault first");
    const path = decodePath(row.path);
    await this.api.resolve(this.settings.folderId, path, row.version_id);
    new Notice(`omni-sync: restored ${path}`);
    await this.sync({ mode: "pull", force: new Set([path]) });
  }

  async openHistory(path: string): Promise<void> {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    new HistoryModal(this.app, this, path).open();
  }

  openOverwrites(): void {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    new OverwritesModal(this.app, this).open();
  }

  openTrash(): void {
    if (!this.api) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    new TrashModal(this.app, this).open();
  }

  openDashboard(): void {
    const base = this.api?.server ?? this.settings.server;
    if (!base) {
      new Notice("omni-sync: connect this vault first");
      return;
    }
    const url = new URL("overwrites", base.endsWith("/") ? base : `${base}/`);
    window.open(url.toString(), "_blank");
  }

  private async refreshOverwriteCount(): Promise<void> {
    try {
      const previous = this.overwrites;
      const next = (await this.loadOverwrites()).length;
      this.overwrites = next;
      if (next > previous) {
        new Notice(
          `omni-sync: ${next} conflict${next === 1 ? "" : "s"} waiting — run “Review conflicts”`,
          8_000,
        );
      }
    } catch {
      // Keep the previous count; the next full sync retries.
    }
  }

  private checkSafety(): void {
    this.safety = vaultWarnings(this.app, this.app.vault.adapter);
    if (this.safety.length === 0 || this.safetyNotified) return;
    this.safetyNotified = true;
    // Sticky: this is exactly the "two sync services on one tree" situation
    // that silently loses edits, so it should not scroll away.
    new Notice(`omni-sync:\n${this.safety.join("\n\n")}`, 0);
  }

  private setStatus(kind: StatusKind, text: string): void {
    this.statusEl.setText(`omni-sync: ${text}`);
    this.statusEl.dataset.omniState = kind;
    this.statusEl.setAttr("title", `omni-sync — ${text}`);
  }
}

function describe(summary: Summary): string {
  const parts: string[] = [];
  if (summary.uploaded || summary.deleted) {
    parts.push(`${summary.uploaded} pushed, ${summary.deleted} deleted`);
  }
  if (summary.written || summary.removed) {
    parts.push(`${summary.written} pulled, ${summary.removed} removed`);
  }
  if (summary.deferred) parts.push(`${summary.deferred} local kept`);
  if (summary.tooLarge) parts.push(`${summary.tooLarge} too large`);
  return parts.length > 0 ? parts.join(" · ") : "up to date";
}
