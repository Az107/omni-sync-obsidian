/**
 * The op-log watermark.
 *
 * `ops.id` is one global AUTOINCREMENT sequence across all folders, so a push
 * to another folder leaves a gap in this one. The watermark may only move over
 * a contiguous run of ops this device actually applied; jumping it would skip a
 * foreign op that landed inside the batch.
 *
 * Pull advances per entry (it applies every entry in order), matching
 * `Engine::pull_inner`; this helper is for the push response.
 */
export function advanceWatermark(previous: number, applied: readonly number[]): number {
  let watermark = previous;
  for (const seq of applied) {
    if (seq === watermark + 1) {
      watermark = seq;
    } else {
      break;
    }
  }
  return watermark;
}

/**
 * A pulled op is our own echo if we already hold that exact version and the
 * file is still on disk. Re-downloading and rewriting it would fire Obsidian's
 * modify events and feed a push/pull loop.
 */
export function isEcho(
  storedVersionId: number | undefined,
  versionId: number,
  exists: boolean,
): boolean {
  return storedVersionId === versionId && exists;
}

/** First sync of a folder pulls before pushing; later syncs push first. */
export function pullsFirst(appliedSeq: number): boolean {
  return appliedSeq === 0;
}
