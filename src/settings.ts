import { Platform, PluginSettingTab, Setting } from "obsidian";

import { OnboardingModal } from "./onboarding";
import type OmniSyncPlugin from "./main";

export interface OmniSyncSettings {
  /** Server base URL, e.g. `https://sync.example.com` or `.../app/omni-sync`. */
  server: string;
  /** Namespaces this vault's IndexedDB. Random per install. */
  vaultId: string;
  folderId: string;
  folderName: string;
  deviceId: string;
  deviceName: string;
  paused: boolean;
  /** Mirrors of the server's folder policy, for display and offline starts. */
  exclude: string[];
  preservePermissions: boolean;
  /** Files above this are left alone in both directions. */
  maxFileSizeMb: number;
  /** Use the server's op-log SSE stream, with the poll as a fallback. */
  eventStream: boolean;
}

export function defaultSettings(): OmniSyncSettings {
  return {
    server: "",
    vaultId: newVaultId(),
    folderId: "",
    folderName: "",
    deviceId: "",
    deviceName: Platform.isMobile ? "obsidian-mobile" : "obsidian-desktop",
    paused: false,
    exclude: [],
    preservePermissions: true,
    maxFileSizeMb: 100,
    eventStream: true,
  };
}

/** `randomUUID` needs a secure context; Obsidian provides one, but be safe. */
export function newVaultId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class OmniSyncSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: OmniSyncPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("h2", { text: "omni-sync" });

    if (!settings.folderId) {
      containerEl.createEl("p", {
        cls: "omni-modal-note",
        text: "This vault is not connected. Pair it with a server to start syncing.",
      });
      new Setting(containerEl).addButton((button) =>
        button
          .setButtonText("Connect this vault…")
          .setCta()
          .onClick(() => new OnboardingModal(this.plugin.app, this.plugin).open()),
      );
      return;
    }

    new Setting(containerEl)
      .setName("Server")
      .setDesc("Changing this disconnects the vault; pair again afterwards.")
      .addText((text) =>
        text.setValue(settings.server).onChange(async (value) => {
          settings.server = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc(`Shown on the dashboard. Device id ${settings.deviceId || "unknown"}.`)
      .addText((text) =>
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim() || "obsidian";
          await this.plugin.saveSettings();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Rename on server")
          .onClick(() => void this.plugin.renameDeviceOnServer(settings.deviceName)),
      );

    new Setting(containerEl)
      .setName("Folder")
      .setDesc(`${settings.folderName || "unnamed"} — ${settings.folderId}`);

    new Setting(containerEl)
      .setName("Sync")
      .setDesc(
        this.plugin.isSyncing()
          ? "Syncing now…"
          : settings.paused
            ? "Paused. Local changes stay local and remote changes wait until you resume."
            : "Pushes a save within a second and pulls every few seconds while Obsidian is open; a full scan on focus and every five minutes.",
      )
      .addButton((button) =>
        button.setButtonText("Sync now").onClick(() => void this.plugin.syncNow(true)),
      )
      .addButton((button) =>
        button
          .setButtonText(settings.paused ? "Resume" : "Pause")
          .onClick(() => void this.plugin.togglePause()),
      )
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.plugin.cancelSync()),
      );

    new Setting(containerEl)
      .setName("Conflicts")
      .setDesc(
        this.plugin.conflictCount > 0
          ? `${this.plugin.conflictCount} unresolved. Both versions are kept until you choose one.`
          : "No conflicts waiting.",
      )
      .addButton((button) =>
        button.setButtonText("Review…").onClick(() => this.plugin.openOverwrites()),
      )
      .addButton((button) =>
        button.setButtonText("Dashboard").onClick(() => this.plugin.openDashboard()),
      );

    new Setting(containerEl)
      .setName("Event stream")
      .setDesc(
        "Use the server's live op-log stream when the platform supports it; polling remains the fallback.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.eventStream).onChange(async (value) => {
          await this.plugin.setEventStream(value);
        }),
      );

    new Setting(containerEl)
      .setName("Largest file to sync (MB)")
      .setDesc(
        "Files above this are ignored in both directions. This client reads a whole file into memory, so a cap protects mobile devices.",
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "1024";
        text.setValue(String(settings.maxFileSizeMb)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) await this.plugin.setMaxFileSizeMb(parsed);
        });
      });

    containerEl.createEl("h3", { text: "Sync policy" });
    containerEl.createEl("p", {
      cls: "omni-modal-note",
      text: "These are the folder's excludes on the server, shared by every client. One pattern per line. An excluded file is ignored, never deleted.",
    });
    const editor = containerEl.createEl("textarea", {
      cls: "omni-policy-editor",
      attr: { spellcheck: "false", rows: "5" },
    });
    editor.value = settings.exclude.join("\n");
    const savePolicy = containerEl.createEl("button", {
      cls: "mod-cta",
      text: "Save policy",
    });
    savePolicy.onclick = () => void this.plugin.saveExcludePolicy(editor.value);

    containerEl.createEl("p", {
      cls: "omni-modal-note",
      text: settings.preservePermissions
        ? "File permissions are preserved. This client cannot read or write them, so first sync downloads instead of adopting identical files."
        : "File permissions are not preserved (correct for vaults and mobile).",
    });

    new Setting(containerEl)
      .setName("Apply the vault preset")
      .setDesc(
        "Ignore volatile .obsidian files and .trash/, and stop comparing file permissions.",
      )
      .addButton((button) =>
        button.setButtonText("Apply").onClick(() => void this.plugin.applyVaultPolicy()),
      );

    containerEl.createEl("h3", { text: "Trouble" });
    new Setting(containerEl)
      .setName("Reset local sync state")
      .setDesc(
        "Forgets the watermark and file versions so the next sync re-applies everything. Local files are kept.",
      )
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => void this.plugin.resetState()),
      );

    new Setting(containerEl)
      .setName("Disconnect this vault")
      .setDesc(
        "Revokes this device's token on the server and forgets the local sync state. The vault's files are kept.",
      )
      .addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(() => {
            if (
              window.confirm(
                "Disconnect this vault? The device token is revoked and the server will stop accepting it.",
              )
            ) {
              void this.plugin.unpair();
            }
          }),
      );

    containerEl.createEl("h3", { text: "Vault checks" });
    if (this.plugin.safetyWarnings.length === 0) {
      containerEl.createEl("p", {
        cls: "omni-modal-note",
        text: "No sync-service, cloud-folder or path-case conflicts detected.",
      });
    } else {
      for (const warning of this.plugin.safetyWarnings) {
        containerEl.createEl("p", { cls: "mod-warning", text: warning });
      }
    }
  }
}
