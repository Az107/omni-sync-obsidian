/**
 * The conflict review queue.
 *
 * An overwrite row means two devices changed one path without seeing each
 * other. The server kept both versions and picked the later one as active;
 * this modal lets the user reverse that choice (restore the losing version) or
 * accept it (dismiss the row). Restoring is a `Resolve` op, so every client
 * pulls the result — it is not a local-only edit.
 */

import { type App, Modal, Notice } from "obsidian";

import type { OverwriteDto } from "./api";
import { describeError, formatDate, formatSize } from "./format";
import type OmniSyncPlugin from "./main";
import { decodePath } from "./paths";

export class OverwritesModal extends Modal {
  private list: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: OmniSyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("omni-sync conflicts");
    this.contentEl.createEl("p", {
      cls: "omni-modal-note",
      text: "Two devices changed the same file without seeing each other. Both versions are kept; choose which one stays active.",
    });
    this.list = this.contentEl.createDiv({ cls: "omni-overwrites" });
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const list = this.list;
    if (!list) return;
    list.empty();

    let rows: OverwriteDto[];
    try {
      rows = await this.plugin.loadOverwrites();
    } catch (error) {
      list.createEl("p", { text: `Could not load conflicts: ${describeError(error)}` });
      return;
    }

    if (rows.length === 0) {
      list.createEl("p", { text: "No conflicts waiting." });
      return;
    }

    for (const row of rows) {
      await this.renderRow(list, row);
    }
  }

  private async renderRow(list: HTMLElement, row: OverwriteDto): Promise<void> {
    let path: string;
    let decoded = true;
    try {
      path = decodePath(row.path);
    } catch {
      path = `${row.path} (not valid UTF-8)`;
      decoded = false;
    }

    const card = list.createDiv({ cls: "omni-conflict" });
    card.createDiv({ cls: "omni-conflict-path", text: path });

    // Enrich with sizes/dates/device names when history is available; the
    // overwrite row itself only carries version ids.
    let losing = `v${row.losing_version_id}`;
    let winning = `v${row.winning_version_id}`;
    if (decoded) {
      try {
        const [history, names] = await Promise.all([
          this.plugin.loadHistory(path),
          this.plugin.deviceNames(),
        ]);
        const describe = (versionId: number, fallback: string): string => {
          const entry = history.find((candidate) => candidate.version_id === versionId);
          if (!entry) return fallback;
          return [
            fallback,
            formatSize(entry.size),
            names.get(entry.device_id) ?? entry.device_id,
            formatDate(entry.created_at),
          ].join(" · ");
        };
        losing = describe(row.losing_version_id, losing);
        winning = describe(row.winning_version_id, winning);
      } catch {
        // The actions still work without the context.
      }
    }

    card.createDiv({ cls: "omni-conflict-detail", text: `Superseded: ${losing}` });
    card.createDiv({ cls: "omni-conflict-detail", text: `Active now: ${winning}` });

    const actions = card.createDiv({ cls: "omni-conflict-actions" });

    const restore = actions.createEl("button", {
      text: `Restore v${row.losing_version_id}`,
      cls: "mod-cta",
    });
    restore.disabled = !decoded;
    restore.onclick = () => {
      void this.run(async () => {
        await this.plugin.restoreOverwrite(row);
      }, restore);
    };

    const keep = actions.createEl("button", { text: "Keep active" });
    keep.onclick = () => {
      void this.run(async () => {
        await this.plugin.dismissOverwrite(row);
      }, keep);
    };
  }

  private async run(work: () => Promise<void>, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await work();
      await this.refresh();
    } catch (error) {
      button.disabled = false;
      new Notice(`omni-sync: ${describeError(error)}`);
    }
  }
}
