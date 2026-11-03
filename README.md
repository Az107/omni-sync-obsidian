# omni-sync for Obsidian

Sync a vault with an [omni-sync](https://github.com/Az107/omni-sync) server:
the server sequences every change, keeps every version, and is where an
overwrite gets resolved. This plugin is the client inside Obsidian, on desktop
**and** mobile.

> **Status: phase 4 — hardened.** Two-way sync, paged op-log pulls, a
> manifest-seeded first sync, a chunk-size cap, background-visible conflict
> and trash views, SSE with a polling fallback, backoff, revocation handling
> and a release workflow. Not yet run on a physical iOS/Android device, and
> the DTOs are still hand-written. Do not run two sync services over one
> vault.

## Why a plugin and not the daemon

Obsidian mobile runs plugins in a WebView and cannot spawn a process, so the
plugin cannot supervise `omni-sync daemon`. It speaks the server's `/api/v1`
directly: `requestUrl` for transport, the same `ops` log, the same
content-defined chunker, and the same folder-level exclude policy.

## Install (development)

```sh
git clone <this repo> omni-sync-obsidian
cd omni-sync-obsidian
npm install
npm run build            # typecheck + bundle main.js
ln -s "$PWD" "<vault>/.obsidian/plugins/omni-sync"
```

Enable it in **Settings → Community plugins**. `isDesktopOnly` is false, so it
loads on iOS and Android too.

BRAT installs work the same way once a release exists: the release assets are
`main.js`, `manifest.json`, and `styles.css`.

## Pair a vault

1. On the server dashboard, **Devices → Pair** to mint a one-time code.
2. In Obsidian, run **omni-sync: Connect this vault to a server…** from the
   command palette (or the settings tab).
3. Enter the server URL (a sub-path deployment such as
   `https://host/app/omni-sync` works), the code, and a device name.
4. Pick the server folder, or let the plugin create one named after the vault
   with the vault preset.

The device token is stored in IndexedDB, **not** in the vault, so Obsidian Sync,
iCloud, or a Git commit cannot copy it to another device. `data.json` holds only
non-secret settings.

## The vault preset

A folder's excludes and permission policy live on the **server**, not in the
plugin, because two clients of one folder must agree. Creating a folder from
the plugin applies:

```
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache/
.trash/
.obsidian/plugins/*/data.json
```

and turns **preserve permissions off**: this client cannot read or write POSIX
mode bits. Everywhere else `mode = 0` is a wildcard that compares equal to any
mode, so a plugin push and a unix daemon do not fight over permissions.

An excluded path is ignored, never deleted. **Settings → Sync policy** shows the
live list and can apply the preset to an existing folder.

## Behaviour

- **Push** is event-driven: a create, modify, delete or rename marks the path
  dirty, a 500 ms debounce coalesces a burst of saves, and the changed paths
  (only those) are scanned, chunked and submitted. A rename becomes a delete
  plus a put, because the server refuses `Move`.
- **Pull** uses the server's SSE stream when the platform can stream (the
  server sends permissive CORS headers for the WebView); a 5 s poll with
  exponential backoff is the fallback. The op log is paged (500 entries), so a
  long history is a sequence of bounded responses.
- **First sync** reads the head, then the manifest, and makes the vault match
  it — no history replay. Head is read first so an op that lands in between is
  re-delivered (idempotent) rather than skipped. An older server without
  `/head` falls back to replaying the log.
- **Size cap** — files above **Settings → Largest file to sync** (100 MB by
  default) are ignored in both directions. This client reads a whole file into
  memory, so the cap is what keeps a phone from being asked to hold a 1 GB
  attachment.
- Metadata is triage: a file whose size and mtime match the last synced record
  is not read. A file that is read but hashes to the same chunk list is not a
  version — only its mtime is updated.
- Files are written through a `.omni-tmp` sibling and a rename, then verified:
  every chunk's SHA-256 is checked against its address before it is written.
  Chunk uploads and downloads run four at a time.
- The watermark only advances over ops that were fully applied, skipping
  excluded paths and non-UTF-8 names (a Linux daemon can create those; a vault
  cannot hold them).
- On first sync, a local file that is identical is adopted without a rewrite;
  one that differs is kept and a baseline is recorded so the push reports a
  real overwrite instead of losing either side.
- A remote update for a file **open in an editor** is held back (persisted in
  IndexedDB) and applied when the leaf closes. A remote update for a file you
  **edited since the last sync** is skipped: the push runs first, so the
  server already has your version and records the overwrite.
- A **revoked token** stops retrying and asks you to reconnect; a network
  failure backs off up to a minute instead of hammering the server. _Cancel_
  stops a running sync after the current file, and what was already accepted
  is kept.

## History and conflicts

- **Version history** — right-click any file → _omni-sync: version history_, or
  run the same command on the open note. Every version the server kept is
  listed with size, device and date; _Restore_ sends a `Resolve` op, so every
  device converges on the restored content rather than just this one. The
  current version is marked, and a restore-of-a-restore shows as
  `restored from vN`.
- **Conflicts** — when two devices changed the same file without seeing each
  other, the later version is active and the earlier one is kept. The status
  bar shows `N conflicts` and a notice appears when one is raised. _Review
  conflicts_ shows the superseded and active versions with _Restore_ (make the
  superseded content active for every device) and _Keep active_ (dismiss the
  row). The server's dashboard sees the same decision immediately.
- **Trash** — _Show deleted files_ lists paths deleted across the folder that
  still have a content version; _Restore_ brings the file back on every
  device.
- **Dashboard link** — _Open the server dashboard_ opens the server's
  overwrites page in the browser, which is where the same rows are visible to
  anyone without the vault.

## Settings worth knowing

- **Exclude patterns** are editable in place (one per line) and saved to the
  server, so every client follows the change. _Apply the vault preset_ fills in
  the volatile `.obsidian` files and `.trash/`.
- **Device name** can be renamed on the server without re-pairing.
- **Disconnect** revokes this device's token and clears the local sync state;
  files are kept.
- **Event stream** can be turned off if a WebView streams badly; polling then
  drives pulls.

## Safety

- **Do not run this plugin and `omni-sync daemon` on the same vault.** Two
  engines on one tree race on file state; that is the same rule as two daemons.
- **Do not enable Obsidian Sync for a vault connected here.** Two sync services
  writing one tree is a conflict generator, not a redundancy win. The plugin
  detects an enabled Obsidian Sync core plugin on start and shows a sticky
  notice; it also warns when the vault sits inside iCloud Drive, Dropbox,
  OneDrive, Google Drive, pCloud or MEGA, and when two paths differ only by
  case (macOS, Windows and iOS cannot keep both). The same warnings are listed
  under **Settings → Vault checks**.
- Case-insensitive filesystems and macOS NFC/NFD names can still collide; the
  plugin does not normalize bytes. Known gap, tracked in the omni-sync plan.

## Tests

```sh
npm test          # 129 unit tests, no Obsidian runtime needed
npm run typecheck
npm run lint
npm run build
```

The engine also has an opt-in interop test that drives the real `Api`,
`Pusher` and `Puller` against a running server (it creates its own folder and
uses real directories as the two vaults):

```sh
OMNI_SERVER=http://127.0.0.1:8799 OMNI_TOKEN=osn_... \
  npx vitest run tests/interop.test.ts
```

`testdata/chunk_vectors.json` and `testdata/ignore_cases.json` are **generated
by the Rust workspace** (`omni-chunk`, `omni-core`) and copied here. They are
the contract: the TypeScript chunker must cut at the same offsets and the
ignore matcher must return the same answers, or the two clients of one folder
never deduplicate and disagree about what to sync. Regenerate with:

```sh
cargo run -p omni-chunk --example gen_vectors > testdata/chunk_vectors.json
cp ../omni-sync/crates/omni-core/testdata/ignore_cases.json testdata/
```

## Roadmap

- **Real-device pass** — iOS and Android: WebView streaming, `adapter.rename`
  over an existing file, background suspension mid-upload, and the status bar.
- **Generated DTOs** — derive the TypeScript types from `omni-netproto` so a
  wire change is a compile error instead of an interop-test failure.
- **Vault profile** — a 10k-file / 1 GB run with chunk concurrency and the size
  cap, plus a UI test harness for the modals.

Design notes and the full plan live in the omni-sync repo at
`docs/obsidian-plugin-plan.md`.

## Development

```sh
npm ci                  # exact deps from package-lock.json
npm run dev             # esbuild watch, rebuilds main.js
npm run typecheck
npm test
npm run lint            # eslint, flat config
npm run format          # prettier --write .
npm run format:check    # what CI would fail on
npm run build           # typecheck + minified main.js
node scripts/bump.mjs 0.2.0   # package.json, manifest.json, versions.json
```

`scripts/bump.mjs` sets the same version in `package.json` and
`manifest.json` and records it against `minAppVersion` in `versions.json`, so
a release never ships a version Obsidian cannot map to an app requirement.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and a production build on
every push to `main` and every pull request, and fails if the build did not
produce `main.js`. Releasing is one tag: push `obsidian-v<version>` (or run the
**release** workflow by hand) and the workflow builds the bundle, refuses to
publish unless the tag matches `manifest.json`, then attaches `main.js`,
`manifest.json` and `styles.css` to a GitHub release — the three files BRAT
and the community plugin browser expect. That is the pipeline phase 4 was
waiting on, not a separate process.

## License

MIT © 2026 omni-sync contributors. See [`LICENSE`](LICENSE).
