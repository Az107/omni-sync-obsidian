/**
 * Per-file version history, with restore.
 *
 * The server keeps every version (last-write-wins never deletes history), so a
 * restore is just a `Resolve` op against the old version id: every client then
 * pulls the restored content, and the file's active version moves forward
 * instead of being rewritten backwards.
 */

import { type App, Modal, Notice } from "obsidian";

import type { HistoryEntryDto } from "./api";
import { describeError, formatDate, formatSize } from "./format";
import type OmniSyncPlugin from "./main";

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: OmniSyncPlugin,
    private readonly path: string,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.titleEl.setText("Version history");
    this.contentEl.createEl("p", { cls: "omni-modal-note", text: this.path });

    const list = this.contentEl.createDiv({ cls: "omni-history" });
    const loading = list.createEl("p", { text: "Loading…" });

    try {
      const [entries, names] = await Promise.all([
        this.plugin.loadHistory(this.path),
        this.plugin.deviceNames(),
      ]);
      loading.remove();

      if (entries.length === 0) {
        list.createEl("p", {
          text: "No versions recorded yet. A version appears after the first push.",
        });
        return;
      }

      for (const entry of entries) {
        this.renderVersion(list, entry, names);
      }
    } catch (error) {
      loading.setText(`Could not load history: ${describeError(error)}`);
    }
  }

  private renderVersion(
    list: HTMLElement,
    entry: HistoryEntryDto,
    names: Map<string, string>,
  ): void {
    const row = list.createDiv({
      cls: `omni-version${entry.active ? " is-active" : ""}`,
    });
    const main = row.createDiv({ cls: "omni-version-main" });
    main.createSpan({ cls: "omni-version-id", text: `v${entry.version_id}` });
    main.createSpan({
      cls: "omni-version-meta",
      text: [
        formatSize(entry.size),
        names.get(entry.device_id) ?? entry.device_id,
        formatDate(entry.created_at),
      ].join(" · "),
    });
    if (entry.active) main.createSpan({ cls: "omni-badge", text: "active" });
    if (entry.restored_from) {
      main.createSpan({
        cls: "omni-badge",
        text: `restored from v${entry.restored_from}`,
      });
    }

    const button = row.createEl("button", {
      text: entry.active ? "Current" : "Restore",
      cls: entry.active ? "" : "mod-cta",
    });
    button.disabled = entry.active;
    if (entry.active) return;

    button.onclick = () => {
      void this.restore(entry, button);
    };
  }

  private async restore(
    entry: HistoryEntryDto,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    button.setText("Restoring…");
    try {
      await this.plugin.restoreVersion(this.path, entry.version_id);
      this.close();
    } catch (error) {
      button.disabled = false;
      button.setText("Restore");
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }
}
