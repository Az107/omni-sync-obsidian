/**
 * Deleted files with a restorable content version.
 *
 * The server keeps every version, so a delete is recoverable even though the
 * path is gone. `resolve` against the last content version mints a `Resolve`
 * op, which every device then pulls; this is not a local undelete.
 */

import { type App, Modal, Notice } from "obsidian";

import type { DeletedFileDto } from "./api";
import { describeError, formatDate, formatSize } from "./format";
import type OmniSyncPlugin from "./main";
import { decodePath } from "./paths";

export class TrashModal extends Modal {
  private list: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: OmniSyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Deleted files");
    this.contentEl.createEl("p", {
      cls: "omni-modal-note",
      text: "Paths deleted across the folder that still have a version to restore. Restoring brings the file back on every device.",
    });
    this.list = this.contentEl.createDiv({ cls: "omni-overwrites" });
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const list = this.list;
    if (!list) return;
    list.empty();

    let rows: DeletedFileDto[];
    try {
      rows = await this.plugin.loadDeleted();
    } catch (error) {
      list.createEl("p", {
        text: `Could not load deleted files: ${describeError(error)}`,
      });
      return;
    }

    if (rows.length === 0) {
      list.createEl("p", { text: "No deleted files with a restorable version." });
      return;
    }

    for (const row of rows) {
      this.renderRow(list, row);
    }
  }

  private renderRow(list: HTMLElement, row: DeletedFileDto): void {
    let path: string;
    try {
      path = decodePath(row.path);
    } catch {
      path = `${row.path} (not valid UTF-8)`;
    }

    const card = list.createDiv({ cls: "omni-conflict" });
    card.createDiv({ cls: "omni-conflict-path", text: path });
    card.createDiv({
      cls: "omni-conflict-detail",
      text: `${formatSize(row.size)} · deleted ${formatDate(row.deleted_at)} · restores v${row.version_id}`,
    });

    const actions = card.createDiv({ cls: "omni-conflict-actions" });
    const restore = actions.createEl("button", {
      text: "Restore",
      cls: "mod-cta",
    });
    restore.onclick = () => {
      void this.restore(row, restore);
    };
  }

  private async restore(row: DeletedFileDto, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.setText("Restoring…");
    try {
      await this.plugin.restoreDeleted(row);
      await this.refresh();
    } catch (error) {
      button.disabled = false;
      button.setText("Restore");
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }
}
