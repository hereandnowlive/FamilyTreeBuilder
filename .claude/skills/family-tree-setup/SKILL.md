---
name: family-tree-setup
description: How the Family Tree Builder desktop app (Tauri 2 + React/TypeScript + SQLite) is set up, run, verified and extended. Use before changing the build, dependencies, database schema, Tauri permissions, Rust commands or the tree layout, or when the app needs to be run or rebuilt from scratch.
---

# Family Tree Builder app: project setup

A local-only desktop app: a pan/zoom family tree canvas, with a details page per person (fields, biography, photos). Mitchell is comfortable in TypeScript and C# and still learning Rust, so the interface and the merge planning live in TypeScript, and the Rust side (files, database, recording) is heavily commented.

## Stack

| Part | Choice |
| --- | --- |
| Shell | Tauri 2 (Rust), identifier `com.mitchell.familytree` |
| UI | React 19 + TypeScript, Vite (dev server on port 1420) |
| Styling | Tailwind CSS 4 through `@tailwindcss/vite`; no `tailwind.config.js`, the theme lives in CSS |
| Canvas | `@xyflow/react` (React Flow 12) |
| Auto layout | `@dagrejs/dagre` |
| Data | SQLite through `rusqlite` (bundled SQLite); every query is in Rust, in `src-tauri/src/db.rs` |
| File picker, confirm dialogs | `tauri-plugin-dialog` |
| Family files | `zip` crate (deflate only) |
| Thumbnails | `image` crate |
| Microphone recording | `cpal` (capture) and `mp3lame-encoder` (LAME, compiled from C) |
| Package manager | npm (pnpm is not installed) |

## Commands

Run from the project root.

- `npm run app` (same as `npm run tauri dev`): run the app with hot reload. It opens a window on the desktop.
- `npm run build`: type-check (`tsc --noEmit`) and bundle the frontend. Use this as the quick check after TypeScript changes. `npm run typecheck` does the type-check alone.
- `cargo build` in `src-tauri/`: check the Rust side. The first build takes a few minutes; later ones take seconds.
- `cargo test` in `src-tauri/`: run the Rust unit tests (database and migrations, applying a merge, family file packing, opening and backups).
- `npm test`: type-check and run the merge planner tests in `tests/` with Node's built-in test runner. No test framework is installed.
- `npm run app:build`: release build, then `scripts/copy-installer.mjs` copies every installer it made to `installer/`, named `family-tree-builder_<version>...`. Takes several minutes.
- `npm run clean`: deletes `src-tauri/target`. Safe; the next build takes minutes.

The build setup mirrors Mitchell's `BoringMusicPlayer` project (`~/Desktop/MajorSideProjects/BoringMusicPlayer`), which is the reference for build conventions.

## How it was created

Only needed to rebuild from nothing.

1. Linux system packages for Tauri were already present: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libssl-dev`, `build-essential`.
2. Scaffold in a temporary folder, then copy into the project (the project path contains spaces):
   `npm create tauri-app@latest family-tree -- --template react-ts --manager npm --identifier com.mitchell.familytree --yes`
3. Frontend packages: `npm install @xyflow/react @dagrejs/dagre @tauri-apps/plugin-dialog`, `npm install -D tailwindcss @tailwindcss/vite` (plus `tailwindcss()` in the `plugins` list of `vite.config.ts`), and `npm uninstall @tauri-apps/plugin-opener`.
4. Rust crates, in `src-tauri/`:
   - `cargo remove tauri-plugin-opener`
   - `cargo add tauri-plugin-dialog@2`
   - `cargo add rusqlite --features bundled`
   - `cargo add uuid@1 --features v4`
   - `cargo add tauri@2 --features protocol-asset`
   - `cargo add zip --no-default-features --features deflate`
   - `cargo add image --no-default-features --features jpeg,png,gif,webp,bmp`
   - `cargo add cpal mp3lame-encoder` (Linux also needs `libasound2-dev`, `make` and `autoconf`)
5. `src-tauri/tauri.conf.json`: product name and window title "Family Tree Builder" (the display name only: the identifier `com.mitchell.familytree`, the Cargo package and binary name `family-tree`, and the `.familytree` extension keep the original name, and the identifier must never change because the data folders are named after it), 1280x800 window, and the asset protocol enabled with scopes `$APPDATA/media/**` and `$APPDATA/thumbs/**` so the webview can display stored photos and their thumbnails.
6. `src-tauri/capabilities/default.json` permissions: `core:default`, `dialog:default`.
7. `rust-toolchain.toml` in the project root pins the Rust version.

## Where things live

- `src-tauri/src/lib.rs`: plugin registration, the shared database connection (`DbState`, `with_db`), and every Tauri command: one per database operation (named after the function in `db.rs` it calls), the media and thumbnail commands, the recording commands, and the family file and merge commands.
- `src-tauri/src/db.rs`: opening and migrating the database (`MIGRATIONS`, `open`) and every query. Plain `rusqlite` connections in, no Tauri types, with unit tests at the bottom that run against an in-memory database.
- `src-tauri/src/merge.rs`: reads both trees for the merge planner (`snapshot`) and applies an approved plan in one transaction (`apply`). Also Tauri-free and unit tested.
- `src-tauri/src/recorder.rs`: records the default microphone to a 64 kbps mono MP3 on a worker thread. `RecorderState` in `lib.rs` holds the recording in progress.
- `src-tauri/.cargo/config.toml`: sets Cargo's `build-dir` to a folder under `~/.cargo`. Do not remove it: the project path contains spaces, and LAME's libtool build fails with "install: target ... No such file or directory" when its build folder is inside it.
- `src-tauri/src/thumbnail.rs`: makes the small JPEG previews of photos (`image` crate; jpeg, png, gif, webp and bmp only).
- `src-tauri/src/rotate.rs`: turns a photo a quarter turn and writes it as a new file (JPEG at quality 95, PNG/BMP/WebP lossless; GIF and AVIF refused). The `rotate_photo` command swaps the new file name into the `media` row and deletes the old file.
- `src-tauri/src/family_file.rs`: packing and unpacking `.familytree` files. Plain paths in, no Tauri types, with unit tests at the bottom.
- `src-tauri/migrations/`: SQL migrations, embedded with `include_str!`.
- `src/db.ts`: every call into Rust, as thin typed wrappers around `invoke`. Components do not call `invoke` themselves.
- `tests/plan.test.ts`: the merge planner tests, with their own `tests/tsconfig.json`.
- `rust-toolchain.toml`: the pinned Rust version. `.github/workflows/release.yml` names the same version.
- `src/relations.ts`: `TreeIndex` lookup tables, ancestor/descendant checks, the candidate rules for linking existing people, and name/year helpers.
- `src/tree/layout.ts`: the auto layout.
- `src/tree/TreeView.tsx`, `nodes.tsx`, `AddRelativeDialog.tsx`: the canvas, person and union nodes, and the add-relative dialog.
- `src/person/PersonPage.tsx`: the person details page. It owns the person's events and photos and passes them down.
- `src/components/PersonChip.tsx`: the portrait-and-name pill used for relatives and for the people an event is shared with.
- `src/person/EventsCard.tsx`, `PhotoGrid.tsx`: the "Major events" card, one editable section per event, and the photo thumbnails inside it.
- `src/person/PhotoPage.tsx`: a photo's own page: caption, description, and attached recordings.
- `src/person/AudioPlayer.tsx`: the custom player for a recording (play button, position bar, time). The browser's own `controls` are not used.
- `src/person/RecorderControl.tsx`: the Record button, timer and level meter on the photo page.
- `README.md` and `src/help/HelpPage.tsx`: the user guide. It is written once, in the README between the `<!-- guide:start -->` and `<!-- guide:end -->` markers, and the Help page bundles that text at build time (`?raw` import, rendered with `marked`, styled by the `.guide` rules in `styles.css`). Each `##` heading is one Help section.
- `src/familyFile.ts`: the Open file, Merge file and Save file flows, and "Save a copy" for a photo or recording: dialogs, confirmation, remembered last path.
- `src/merge/plan.ts`: pure function `buildPlan(mine, theirs)` that works out what a merge would do. `src/merge/MergePage.tsx`: the review screen shown at startup while a merge is pending.
- `src/App.tsx`: owns the loaded tree data and `reload()`, and switches between the tree, a person page and a photo page (no router).
- `src/styles.css`: the Tailwind import, the theme tokens in `@theme` (colours such as `paper`, `surface`, `ink`, `muted`, `line`, `accent`, `danger`, and the `sans`/`serif` fonts), body defaults, and the React Flow overrides. Everything else is utility classes in the components.
- `src/components/ui.tsx`: shared styled pieces: `Button` (variants `default`/`primary`/`ghost`, sizes `md`/`sm`/`xs`), `Field`, `Card`, `TopBar`, and the `inputClass`/`controlClass` strings for form controls.

## Data model

Tables: `person`, `partnership`, `parent_child`, `event`, `event_participant`, `media`, `audio`. TypeScript types in `src/types.ts` use the column names unchanged (snake_case).

- Dates are free text ("abt. 1850"); `yearOf()` pulls out the first four-digit year.
- `partnership` stores the smaller id in `person_a_id`, so a couple exists once.
- A person has at most two parents. Adding a second parent also records the two parents as partners.
- `media.file_name` is a bare file name inside the media folder.
- An `event` is a major event (title, free-text date, description) shared by one or more people. `event_participant` is the source of truth for who is in it; an event and its photos appear on every participant's page. Events are shown in year order.
- `event.person_id` and `media.person_id` are leftovers that SQLite cannot drop (they carry foreign keys). They do not say whose page something is on, and the TypeScript types leave them out. Each must point at some current participant, because both cascade on delete: `remove_event_person_rows` in `db.rs` moves them to a remaining participant, and `delete_person` goes through it. Never delete a `person` row or an `event_participant` row any other way.
- Every photo (`media`) belongs to one event through `event_id`, and is listed for a person by joining through `event_participant`, not by `media.person_id`. The column is nullable in the schema but the app always sets it; there is no separate photos section.
- `audio` rows are recordings attached to a photo. Their files sit in the media folder beside the photos, so family files carry them without extra work. The TypeScript type is `Recording`, and events are `LifeEvent`, because `Audio` and `Event` are DOM names.
- Foreign keys declare cascades, but `db.rs` deletes child rows explicitly, inside a transaction, and returns the file names; the command in `lib.rs` removes the files after the commit. Deleting a person, event or photo must go through `delete_person`, `delete_event` or `delete_media` so no files are left behind.

On Linux the database is at `~/.config/com.mitchell.familytree/familytree.db` and photos are in `~/.local/share/com.mitchell.familytree/media/`. This is Mitchell's real family data: never delete or reset it without asking.

## Rules to keep

- **Migrations**: never edit a migration that has run, and assume it has: Mitchell often has `npm run tauri dev` open, which rebuilds and applies a new migration to the real database as soon as the file is saved. Get the SQL right on a scratch copy of the database first (`sqlite3 copy.db ".read migrations/00N_name.sql"`). The version reached is kept in SQLite's `user_version`; nothing checks an applied migration for edits, so a change to one silently never runs on existing databases.
- **Build memory**: `src-tauri/.cargo/config.toml` caps Cargo at 8 parallel jobs. The default of one per core (32) ran this machine out of its 30 GB of RAM during a release build and froze it. Do not remove the cap or pass a higher `-j` without asking. For the same reason `[profile.release]` in `Cargo.toml` has no `lto` or `codegen-units = 1`; do not add them back without asking.
- **Releases** are meant to be published by `.github/workflows/release.yml`, started by hand on GitHub: it runs `npm run app:build` on Linux and Windows and publishes the installers as release `v<version>` from `tauri.conf.json`. It has never run (the project is not in a git repository yet). A change to the build commands, the `installer/` folder or the Linux system libraries must be mirrored there.
- **The app version lives in three files** that should be kept the same: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`. Only `tauri.conf.json` affects the installer.
- **New migration**: add `00N_name.sql` and append it to `MIGRATIONS` in `db.rs`. Its position in the list is its version.
- **Old databases**: ones made before the move to rusqlite carry a `_sqlx_migrations` table. `migrate` in `db.rs` reads the version from it once and leaves the table alone.
- **New Rust command**: add it to `generate_handler!` in `lib.rs` and wrap the `invoke` call in `src/db.ts`. A database command is `#[tauri::command(async)]` and goes through `with_db`.
- **New query**: write it in `db.rs`, with a test. Anything that changes more than one row uses a transaction. Table and column names that come from the frontend must be checked against the schema first, as `checked_columns` in `merge.rs` does.
- **New plugin**: needs the npm package, the crate, `.plugin(...)` in `lib.rs`, and a permission in `capabilities/default.json`.
- **SQL placeholders** are `?1`, `?2`, ... There is one connection, behind a mutex in `DbState`.
- **Content security policy**: `app.security.csp` in `tauri.conf.json` only allows the app's own files, the asset protocol and blob/data URLs. It is not applied under `tauri dev`, only in a built app, so anything that loads from a new kind of source (a web font, a remote image, a script-injected stylesheet) must be tried in an installed build.
- **Rust version**: pinned in `rust-toolchain.toml`. To move to a newer one, change it there and in `release.yml`, then run `cargo test`.
- **Tests and CPU**: Mitchell does not want test runners using every core. `npm test` runs Node's runner with `--test-concurrency=1`; keep any new test tooling capped the same way, as Cargo is in `.cargo/config.toml`.
- **Confirmations** use `confirm` from `@tauri-apps/plugin-dialog`, not `window.confirm`.
- **Styling**: Tailwind's reset strips the browser look from `button`, `input`, `select` and `textarea`, so use `Button` or `inputClass` from `ui.tsx` instead of bare elements. Write class names out in full (no `` `border-l-${x}` ``); Tailwind only generates classes it can find as whole strings, and it only scans `src/`. Rules that target `.react-flow*` classes stay as plain CSS outside any `@layer`, because the library's stylesheet is unlayered and would win otherwise.
- **Recording** is done natively in Rust, not with the webview's `getUserMedia`/`MediaRecorder`: Tauri's Linux webview has media streams switched off, and the Windows side could not be tested from here. Recording goes to `recording-in-progress.mp3` in the data folder and is moved into the media folder on save. Leaving the photo page mid-recording saves it.
- **Audio** is played from a blob URL (`AudioPlayer.tsx`), not from `mediaUrl` directly: WebKitGTK on Linux cannot play media from the asset protocol. 
- **File picker filters** for photos and audio come from `src/fileFilters.ts`, which lists every extension in lower and upper case because Linux pickers match case-sensitively (`IMG0001.JPG` is hidden by a `jpg` filter). Its lists must match `IMAGE_EXTENSIONS` and `AUDIO_EXTENSIONS` in `lib.rs`, which do the real check.
- **A stored photo's file never changes in place.** Thumbnails, the webview's cache and merges all treat a file name as meaning one fixed picture, so anything that alters a photo (as rotation does) writes a new file under a new name and updates `media.file_name`. A merge does not compare `file_name`, so a rotation made in one copy of the tree is not carried into another by merging.
- **Thumbnails**: anything smaller than a full-page view of a photo must use the `Thumbnail` component or `useThumbnail` hook (`src/components/Thumbnail.tsx`), never `mediaUrl`. Photos are often 20+ megapixel scans, and decoding those for a grid or for tree portraits is what made the UI crawl. Thumbnails are a cache in the `thumbs` folder of the data directory, made on first use by `ensure_thumbnail` (at most 3 at once, limited in `db.ts`), never stored in family files, and cleared when a family file is opened. If a format cannot be decoded (AVIF), the full image is used instead.
- **Dev build speed**: `Cargo.toml` compiles dependencies at `opt-level = 3` in dev so image decoding is fast under `tauri dev`. The first build after a `cargo clean` is slower because of it.
- **User guide**: when a change alters what users see or do (a button label, a new feature, a message, a supported file type), update the guide section of `README.md` in the same change. Keep that section to headings, paragraphs, lists, bold and code: no links (they would navigate the app window away), images or tables. It is written for non-technical family members on Windows.
- **Full-size photos** are shown with `mediaUrl(fileName)` from `db.ts`. `initStorage()` must have run first (App does this at startup). It must also finish before the first database command, because it swaps in any staged family file and the database is opened on first use.

## Family files

The tree is shared by passing one `.familytree` file from person to person; everyone installs the app once. Passing it baton-style needs no reconciliation; when two copies have both been edited, they are combined with Merge file (see Merging).

- The file is a zip: `manifest.json` (`format`, `schema_version`), `familytree.db`, and `media/<file>` for every photo.
- **Save file**: Rust runs `VACUUM INTO` to get a consistent snapshot, then zips the snapshot and the media folder (`pack_tree` in `lib.rs`). It writes `<dest>.part` and renames, so a failed save never damages an existing file.
- **Open file**: Rust validates and unpacks the file into `pending-open/` in the data folder, the current tree is saved to `backups/before-open-<stamp>.familytree` (the newest 3 are kept, and they open like any family file), the database connection is closed, and the app restarts. `apply_pending_open` then replaces the database and media folder before the database is first opened.
- The swap happens at startup, before the database is opened, because Windows will not replace an open database file. `restart_into_staged` closes the connection first.
- Under `tauri dev`, opening a file exits the app instead of restarting it. Run `npm run tauri dev` again and the file is applied.
- A file whose `schema_version` is higher than this build's newest migration is refused. A file from an older build is migrated on open as usual.
- The archive layout version is `FORMAT_VERSION` in `family_file.rs`, now 2. Raise it if entries are added or renamed. It went from 1 to 2 with the move to rusqlite, so that builds based on the SQL plugin refuse newer files cleanly; files of either version open here.
- The rest of the family is on Windows and Mitchell is on Linux, so anything touching files must work on both: build paths with `Path::join`, never assume the config and data folders are the same, and close files before replacing them.

## Merging

**Merge file…** combines a family file with the current tree instead of replacing it.

- Flow: `stage_merge` unpacks the file into `pending-merge/` and marks it ready; `TreeView` calls `onMerge` and `App` shows `MergePage` (no restart; if the app is closed before the merge is decided, `pending_merge` brings the screen back at the next start); `merge_snapshots` opens the staged database (which migrates an older file) and returns both trees; `buildPlan` in `plan.ts` compares them; `apply_merge` carries out the plan; `finish_merge` clears up.
- Records match by id (every id is a random UUID, and copies descend from one file). Only in the file: inserted. Only in the tree: kept; a merge never deletes. In both: compared field by field over the editable columns listed in `FIELDS` in `plan.ts`; a blank on one side takes the other side's value, and two different non-blank values are a conflict the user settles per record ("mine" or "theirs").
- Parents: a union that would exceed two parents is a conflict; a link that would create an ancestor loop is skipped. After applying, every pair of co-parents gets a partnership row.
- Safety: a backup `before-merge-<stamp>` is always written first. When conflicts were settled, `overrides/<stamp>/` gets a copy of each tree that lost on anything; that folder is never pruned. The database changes are one transaction (`merge::apply`), so a failed merge leaves the tree unchanged, and photos copied in for it are removed again.
- Adding a user-editable column to `person`, `event`, `media` or `audio` means adding it to `FIELDS` in `plan.ts`, or merges will silently ignore differences in it. A new table needs adding to `Snapshot` and `INSERT_ORDER` in `plan.ts` and to `TABLES` in `merge.rs`.
- To check planner changes, add a case to `tests/plan.test.ts` and run `npm test`.

## Layout

Positions are never stored; `layoutTree()` recomputes everything whenever the data changes.

- People joined by partnerships, or by sharing a child, form a "block" that dagre treats as one wide node. This keeps partners adjacent and on the same row.
- Parent to child links between blocks give one row per generation.
- Inside a two-person block, each partner is placed on the side nearest their own parents.
- Each couple gets a small union node in the gap between them. Partner lines go sideways into it and children's lines hang from it. A single parent links straight down to the child.
- Person nodes have handles `top`, `bottom`, `left`, `right`; union nodes have `left`, `right`, `bottom`. Edges must name their handles.
- Card size is set once: `PERSON_WIDTH`/`PERSON_HEIGHT` (and `UNION_SIZE`) in `layout.ts`, which `nodes.tsx` applies as inline styles.
- Selection is held in `TreeView` state and passed to nodes through `TreeUiContext`; React Flow's own selection is turned off.

## Verifying changes

1. `npm run build` and `npm test`, and, if Rust changed, `cargo build` and `cargo test` in `src-tauri/`.
2. For layout changes, write a throwaway script in the scratchpad that imports `layoutTree` and `indexTree`, builds a sample family (grandparents on both sides, siblings, a married-in partner, someone with two partners, a single parent) and prints people per row plus an overlap count. Run it with `npx tsx`. Expect partners adjacent, one row per generation and zero overlaps.
3. For a launch check, run `npm run tauri dev` in the background and confirm the database file and `media` folder exist and the log shows no errors. Stop it afterwards with `pkill -x family-tree` and `pkill -f "tauri dev"`, each as its own command (`pkill -f target/debug/family-tree` also matches the shell running it).
4. There is no way to see or click the window from a session, so say plainly when UI behaviour has not been checked by hand.

## Not built yet

No GEDCOM import or export, no merging of two person records into one (duplicates after a merge are tidied by hand), no in-app browser for the overrides folder, no search box in the share-with-a-person picker (it is a plain list), no in-app list of the automatic backups, no `.familytree` file association (double-click to open), no tested Windows build (the workflow exists but has never run), no undo, no manual card positioning, no periodic automatic backups, and no frontend tests beyond the merge planner. The folder was not a git repository when the app was first built.
