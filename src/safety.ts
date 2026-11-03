/**
 * Vault-level warnings that are cheaper to check once than to debug later.
 *
 * None of these disable syncing: the user may have a reason. They are shown
 * prominently on start and listed in the settings tab.
 */

import type { App, DataAdapter } from "obsidian";

/** Groups of paths that a case-insensitive filesystem cannot tell apart. */
export function caseCollisions(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(path);
    else groups.set(key, [path]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

const CLOUD_FOLDERS: ReadonlyArray<readonly [string, string]> = [
  ["library/mobile documents", "iCloud Drive"],
  ["dropbox", "Dropbox"],
  ["onedrive", "OneDrive"],
  ["google drive", "Google Drive"],
  ["pcloud", "pCloud"],
  ["mega", "MEGA"],
];

export function vaultWarnings(app: App, adapter: DataAdapter): string[] {
  const warnings: string[] = [];

  // Obsidian Sync is a core plugin; two sync services on one tree conflict.
  const internal = (
    app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => { enabled?: boolean } | null;
      };
    }
  ).internalPlugins;
  if (internal?.getPluginById?.("sync")?.enabled) {
    warnings.push(
      "Obsidian Sync is enabled on this vault. Two sync services writing one tree will fight; disable one of them.",
    );
  }

  const source = adapter as unknown as {
    getBasePath?: () => string;
    basePath?: string;
  };
  const basePath =
    (typeof source.getBasePath === "function" ? source.getBasePath() : source.basePath) ??
    "";
  const lower = basePath.toLowerCase();
  for (const [needle, name] of CLOUD_FOLDERS) {
    if (lower.includes(needle)) {
      warnings.push(
        `This vault lives in ${name}, which moves files independently. Two sync services on one tree can race; consider moving the vault out.`,
      );
      break;
    }
  }

  for (const group of caseCollisions(app.vault.getFiles().map((file) => file.path))) {
    warnings.push(
      `These paths differ only by case (${group.join(", ")}); a case-insensitive device cannot keep both.`,
    );
  }

  return warnings;
}
