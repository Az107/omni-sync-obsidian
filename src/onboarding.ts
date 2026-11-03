import { type App, Modal, Notice, SuggestModal, Setting } from "obsidian";

import { Api, type FolderDto } from "./api";
import { describeError } from "./format";
import { VAULT_EXCLUDES } from "./ignore";
import type OmniSyncPlugin from "./main";
import { encodePath } from "./paths";

/**
 * Pair this vault: enroll the device with a one-time code, pick (or create) the
 * server folder, register the root, then hand the result to the plugin.
 *
 * Kept to two steps and no browser handoff: a loopback listener — the magic
 * link `omni-sync enroll --link` uses — is not reachable from a mobile app and
 * not worth a special case.
 */
export class OnboardingModal extends Modal {
  private server = "";
  private code = "";
  private name = "";
  private busy = false;
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: OmniSyncPlugin,
  ) {
    super(app);
    this.server = plugin.settings.server;
    this.name = plugin.settings.deviceName;
  }

  override onOpen(): void {
    this.titleEl.setText("Connect this vault to omni-sync");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", {
      cls: "omni-modal-note",
      text: "Mint a one-time code on the server: Devices → Pair. The code is valid for ten minutes and can be used once.",
    });

    new Setting(contentEl).setName("Server URL").addText((text) =>
      text
        .setPlaceholder("https://sync.example.com")
        .setValue(this.server)
        .onChange((value) => {
          this.server = value;
        }),
    );

    new Setting(contentEl).setName("Pairing code").addText((text) =>
      text.setPlaceholder("ABCD-EFGHJ").onChange((value) => {
        this.code = value;
      }),
    );

    new Setting(contentEl).setName("Device name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      }),
    );

    this.errorEl = contentEl.createEl("p", { cls: "mod-warning" });
    this.errorEl.hide();

    const actions = contentEl.createDiv({ cls: "omni-modal-actions" });
    const connect = actions.createEl("button", {
      text: "Connect",
      cls: "mod-cta",
    });
    connect.onclick = () => void this.connect(connect);
  }

  private async connect(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    if (!this.server.trim() || !this.code.trim()) {
      this.showError("A server URL and a pairing code are required.");
      return;
    }

    this.busy = true;
    button.disabled = true;
    button.setText("Connecting…");
    this.errorEl?.hide();

    try {
      const api = new Api(this.server);
      const enrolled = await api.enroll(this.code, this.name.trim() || "obsidian");
      const authed = api.withToken(enrolled.token);

      const folders = await authed.listFolders();
      const folder =
        folders.length === 0
          ? await authed.createFolder(
              this.app.vault.getName(),
              [...VAULT_EXCLUDES],
              false,
            )
          : folders.length === 1
            ? folders[0]!
            : await pickFolder(this.app, folders);

      if (!folder) {
        this.showError("No folder selected.");
        return;
      }

      await authed.registerMember(
        folder.id,
        // There is no absolute path on mobile; the vault name is what the
        // dashboard shows anyway.
        encodePath(this.app.vault.getName()),
        "both",
      );

      await this.plugin.adoptConnection({
        server: this.server,
        token: enrolled.token,
        deviceId: enrolled.device_id,
        deviceName: this.name.trim() || "obsidian",
        folder,
      });

      this.close();
      new Notice(`omni-sync: connected to “${folder.name}”`);
    } catch (error) {
      this.showError(describeError(error));
    } finally {
      this.busy = false;
      button.disabled = false;
      button.setText("Connect");
    }
  }

  private showError(message: string): void {
    if (!this.errorEl) {
      new Notice(`omni-sync: ${message}`);
      return;
    }
    this.errorEl.setText(message);
    this.errorEl.show();
  }
}

class FolderPicker extends SuggestModal<FolderDto> {
  private chosen = false;

  constructor(
    app: App,
    private readonly folders: FolderDto[],
    private readonly resolve: (folder: FolderDto | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose the folder this vault syncs with");
  }

  getSuggestions(query: string): FolderDto[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.folders;
    return this.folders.filter(
      (folder) =>
        folder.name.toLowerCase().includes(needle) ||
        folder.id.toLowerCase().includes(needle),
    );
  }

  renderSuggestion(folder: FolderDto, el: HTMLElement): void {
    el.createDiv({ text: folder.name });
    el.createDiv({ text: folder.id, cls: "omni-modal-note" });
  }

  override onChooseSuggestion(folder: FolderDto): void {
    this.chosen = true;
    this.resolve(folder);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.resolve(null);
  }
}

function pickFolder(app: App, folders: FolderDto[]): Promise<FolderDto | null> {
  return new Promise((resolve) => {
    new FolderPicker(app, folders, resolve).open();
  });
}
