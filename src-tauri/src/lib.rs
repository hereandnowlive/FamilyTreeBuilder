// `mod` pulls in src/family_file.rs as a child module. Unlike a TypeScript import,
// a Rust file is not part of the program until some `mod` line declares it.
mod family_file;
mod recorder;
mod thumbnail;

use std::ffi::OsStr;
use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use recorder::Recorder;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};

// Must match the string passed to `Database.load` in src/db.ts.
const DB_URL: &str = "sqlite:familytree.db";
/// The file that `DB_URL` resolves to inside the app's config folder.
const DB_FILE: &str = "familytree.db";

/// A second database: the tree from a family file that is being merged in.
/// It gets the same migrations as the main one, so an older file is brought up
/// to the current schema before the two are compared. Must match
/// MERGE_DB_URL in src/db.ts.
const MERGE_DB_URL: &str = "sqlite:merge-incoming.db";
const MERGE_DB_FILE: &str = "merge-incoming.db";
/// Where a family file being merged is unpacked: its photos wait here until
/// the merge copies across the ones that are new.
const MERGE_STAGING_DIR: &str = "pending-merge";
/// Text file in the merge staging folder holding the path of the original
/// family file, in case a copy of it has to be kept (see `save_overrides`).
const MERGE_SOURCE_FILE: &str = "source.txt";
/// Copies of whichever tree lost out when a merge conflict was settled. Unlike
/// the backups folder this is never pruned, so nothing overridden is ever lost.
const OVERRIDES_DIR: &str = "overrides";

/// Temporary copy of the database made while saving a family file.
const SNAPSHOT_FILE: &str = "export-snapshot.db";
/// Where an opened family file waits until the app restarts.
const STAGING_DIR: &str = "pending-open";
/// Automatic copies of the tree taken just before a family file replaces it.
const BACKUPS_DIR: &str = "backups";
const BACKUPS_KEPT: usize = 3;
/// Cache of small preview copies of the photos. Safe to delete; see thumbnail.rs.
const THUMBS_DIR: &str = "thumbs";
/// Longest side of a thumbnail in pixels: about twice the largest size one is
/// shown at, so it stays sharp on high-density screens.
const THUMB_EDGE: u32 = 480;
/// Where a microphone recording is written until it is saved or discarded.
const RECORDING_FILE: &str = "recording-in-progress.mp3";

/// The microphone recording in progress, if there is one.
///
/// Tauri keeps one instance of this for the whole app (see `.manage(...)` in
/// `run`) and hands it to any command that asks for `State<RecorderState>`,
/// much like a singleton service from dependency injection in ASP.NET.
/// Commands can run on different threads, so the contents sit behind a `Mutex`:
/// a lock that lets one thread at a time in, and the only way to change shared data.
/// https://tauri.app/develop/state-management/
struct RecorderState(Mutex<Option<Recorder>>);

const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];
/// Formats the webview can play on both Windows and Linux.
const AUDIO_EXTENSIONS: [&str; 7] = ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"];

/// Turns any error into the plain `String` that Tauri sends back to the frontend,
/// where it arrives as the rejected promise's value.
///
/// `impl Display` accepts any type that can be printed as text, similar to a
/// generic constrained to an interface in C# (`where T : IFormattable`).
/// https://doc.rust-lang.org/book/ch10-02-traits.html#traits-as-parameters
fn text(error: impl Display) -> String {
    error.to_string()
}

/// The app's data folder, created if missing. Photos, backups and temporary
/// files live under it.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(text)?;
    fs::create_dir_all(&dir).map_err(text)?;
    Ok(dir)
}

/// Folder inside the app's data directory where imported photos are kept.
fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("media");
    fs::create_dir_all(&dir).map_err(text)?;
    Ok(dir)
}

/// Folder holding the thumbnail cache, created if missing.
fn thumbs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(THUMBS_DIR);
    fs::create_dir_all(&dir).map_err(text)?;
    Ok(dir)
}

/// Where the thumbnail for a stored photo lives. ".jpg" is added to the whole
/// name ("abc.png" becomes "abc.png.jpg"), which keeps the mapping one-to-one.
fn thumb_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    Ok(thumbs_dir(app)?.join(format!("{file_name}.jpg")))
}

/// Rejects anything but a bare file name, so a name sent by the frontend can
/// never point outside the folder it is joined to.
fn require_bare_file_name(file_name: &str) -> Result<(), String> {
    if Path::new(file_name).file_name() != Some(OsStr::new(file_name)) {
        return Err("Invalid file name".into());
    }
    Ok(())
}

/// Keeps only letters, digits and dashes. Used on text from the frontend that
/// becomes part of a file or folder name.
fn safe_name_part(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// Deletes a SQLite database together with the "-wal" and "-shm" files SQLite
/// keeps beside it. Missing files are fine.
fn remove_database(path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let mut file = path.as_os_str().to_owned();
        file.push(suffix);
        family_file::remove_file_if_exists(Path::new(&file)).map_err(text)?;
    }
    Ok(())
}

/// Full path of the database file. The SQL plugin resolves `DB_URL` against the
/// config folder, which on Linux is a different folder from the data folder
/// (on Windows the two are the same).
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(text)?.join(DB_FILE))
}

/// Every database migration, oldest first.
/// Never edit a migration that has shipped; add a new one with the next version.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create initial tables",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "major events, photo descriptions and audio recordings",
            sql: include_str!("../migrations/002_events.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "move photos without an event into a Photos event",
            sql: include_str!("../migrations/003_photos_in_events.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "events can be shared by several people",
            sql: include_str!("../migrations/004_shared_events.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// The newest migration version this build knows. It is written into every
/// family file so an older copy of the app can tell it must not open a newer file.
fn schema_version() -> i64 {
    // An iterator chain, the counterpart of LINQ's `Select(...).Max()`. `max`
    // returns an `Option` because the list could be empty; `unwrap_or` supplies
    // the value to use in that case.
    migrations().iter().map(|m| m.version).max().unwrap_or(0)
}

#[tauri::command]
fn get_media_dir(app: AppHandle) -> Result<String, String> {
    Ok(media_dir(&app)?.to_string_lossy().into_owned())
}

/// Copies a file into the media folder under a new unique name and returns
/// that name. The original file is left untouched.
///
/// `allowed` is a slice (`&[&str]`): a borrowed view of an array of any length,
/// so the image list and the audio list can both be passed to it. It is the
/// counterpart of `ReadOnlySpan<string>` in C#.
/// https://doc.rust-lang.org/book/ch04-03-slices.html
fn import_file(app: &AppHandle, source: &str, allowed: &[&str], rejection: &str) -> Result<String, String> {
    let source = Path::new(source);
    // Each step in this chain works on an `Option` and passes `None` straight
    // through, like a run of `?.` in C# or TypeScript. `ok_or` at the end turns
    // "no acceptable extension" into the error.
    let extension = source
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_lowercase)
        .filter(|ext| allowed.contains(&ext.as_str()))
        .ok_or(rejection)?;

    let file_name = format!("{}.{}", uuid::Uuid::new_v4(), extension);
    fs::copy(source, media_dir(app)?.join(&file_name)).map_err(text)?;
    Ok(file_name)
}

/// Copies an image into the media folder and returns the new file name.
#[tauri::command]
fn import_photo(app: AppHandle, source: String) -> Result<String, String> {
    import_file(&app, &source, &IMAGE_EXTENSIONS, "Not a supported image file")
}

/// Copies an audio recording into the media folder and returns the new file name.
#[tauri::command]
fn import_audio(app: AppHandle, source: String) -> Result<String, String> {
    import_file(&app, &source, &AUDIO_EXTENSIONS, "Not a supported audio file")
}

/// Deletes one stored photo or recording from the media folder.
#[tauri::command]
fn delete_media_file(app: AppHandle, file_name: String) -> Result<(), String> {
    require_bare_file_name(&file_name)?;
    family_file::remove_file_if_exists(&media_dir(&app)?.join(&file_name)).map_err(text)?;
    // A recording has no thumbnail, which "if exists" covers.
    family_file::remove_file_if_exists(&thumb_path(&app, &file_name)?).map_err(text)
}

#[tauri::command]
fn get_thumbs_dir(app: AppHandle) -> Result<String, String> {
    Ok(thumbs_dir(&app)?.to_string_lossy().into_owned())
}

/// Makes the thumbnail for a stored photo unless it already exists.
///
/// Runs on a background thread (`async`) because decoding a large scan takes a
/// noticeable fraction of a second. The frontend limits how many of these run
/// at once.
#[tauri::command(async)]
fn ensure_thumbnail(app: AppHandle, file_name: String) -> Result<(), String> {
    require_bare_file_name(&file_name)?;
    let thumb = thumb_path(&app, &file_name)?;
    if thumb.exists() {
        return Ok(());
    }
    thumbnail::create(&media_dir(&app)?.join(&file_name), &thumb, THUMB_EDGE).map_err(text)
}

/// Starts recording from the default microphone.
#[tauri::command]
fn start_recording(app: AppHandle, state: State<RecorderState>) -> Result<(), String> {
    // `lock` waits for the mutex and returns a guard. The data is reached
    // through the guard, and the lock is released when the guard goes out of
    // scope at the end of the function, so there is no unlock call to forget.
    // https://doc.rust-lang.org/book/ch16-03-shared-state.html
    let mut slot = state.0.lock().map_err(text)?;
    if slot.is_some() {
        return Err("A recording is already in progress.".into());
    }
    // `*slot` writes through the guard into the `Option` it protects.
    *slot = Some(Recorder::start(data_dir(&app)?.join(RECORDING_FILE))?);
    Ok(())
}

/// How loud the microphone has been since the last call, from 0.0 to 1.0.
/// The frontend polls this to draw the level meter.
#[tauri::command]
fn recording_level(state: State<RecorderState>) -> f32 {
    match state.0.lock() {
        // `as_ref` borrows the recorder inside the `Option` instead of moving it out.
        Ok(slot) => slot.as_ref().map_or(0.0, Recorder::take_level),
        Err(_) => 0.0,
    }
}

/// Stops the recording in progress. With `keep`, moves the finished MP3 into
/// the media folder and returns its file name; otherwise discards it.
#[tauri::command(async)]
fn stop_recording(app: AppHandle, state: State<RecorderState>, keep: bool) -> Result<Option<String>, String> {
    // `take` moves the recorder out of the slot and leaves `None` behind. The
    // lock guard is a temporary here, so it is released at the end of this
    // statement and the mutex is not held while the file is being finished.
    let recorder = state
        .0
        .lock()
        .map_err(text)?
        .take()
        .ok_or("No recording is in progress.")?;

    let temp = data_dir(&app)?.join(RECORDING_FILE);
    let result = recorder.finish();
    if !keep || result.is_err() {
        let _ = fs::remove_file(&temp);
        // Passes an error from `finish` on; a discarded recording is `Ok(None)`.
        return result.map(|()| None);
    }

    let file_name = format!("{}.mp3", uuid::Uuid::new_v4());
    fs::rename(&temp, media_dir(&app)?.join(&file_name)).map_err(text)?;
    Ok(Some(file_name))
}

/// Step 1 of saving a family file: returns the path the frontend should write
/// a database snapshot to, using `VACUUM INTO`.
///
/// The snapshot is taken through the SQL plugin because it owns the open
/// database connection. `VACUUM INTO` gives a complete, consistent copy even
/// while the app is in use, which copying the live file would not guarantee.
#[tauri::command]
fn prepare_snapshot(app: AppHandle) -> Result<String, String> {
    let path = data_dir(&app)?.join(SNAPSHOT_FILE);
    // `VACUUM INTO` refuses to overwrite, so clear any snapshot left by a failed save.
    family_file::remove_file_if_exists(&path).map_err(text)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Packs the snapshot from [`prepare_snapshot`] and the media folder into a
/// family file at `dest`, then deletes the snapshot.
fn pack_snapshot(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let snapshot = data_dir(app)?.join(SNAPSHOT_FILE);
    let result = family_file::pack(&snapshot, &media_dir(app)?, dest, schema_version());
    let _ = fs::remove_file(&snapshot);
    result.map_err(text)
}

/// Step 2 of saving a family file: writes it to the path the user chose.
///
/// `(async)` runs the command on a background thread. A plain command runs on
/// the main thread, where copying many photos would freeze the window.
/// https://tauri.app/develop/calling-rust/#async-commands
#[tauri::command(async)]
fn write_family_file(app: AppHandle, dest: String) -> Result<(), String> {
    pack_snapshot(&app, Path::new(&dest))
}

/// Name of the automatic backup taken before `reason` ("open" or "merge").
fn backup_name(reason: &str, stamp: &str) -> String {
    format!(
        "before-{}-{}.{}",
        safe_name_part(reason),
        safe_name_part(stamp),
        family_file::EXTENSION
    )
}

/// Like [`write_family_file`], but saves into the app's own backups folder and
/// keeps only the most recent few. Called before a family file replaces the
/// tree or is merged into it.
#[tauri::command(async)]
fn write_backup(app: AppHandle, reason: String, stamp: String) -> Result<(), String> {
    let dir = data_dir(&app)?.join(BACKUPS_DIR);
    fs::create_dir_all(&dir).map_err(text)?;
    pack_snapshot(&app, &dir.join(backup_name(&reason, &stamp)))?;
    family_file::prune_backups(&dir, BACKUPS_KEPT).map_err(text)
}

/// Checks the family file at `path` and unpacks it into the staging folder.
/// The current tree is untouched, so a bad file changes nothing.
#[tauri::command(async)]
fn stage_family_file(app: AppHandle, path: String) -> Result<(), String> {
    let staging = data_dir(&app)?.join(STAGING_DIR);
    family_file::stage(Path::new(&path), &staging, schema_version()).map_err(text)
}

/// Checks the family file at `path` and unpacks it ready to be merged into the
/// current tree. Nothing in the current tree changes.
///
/// Its database goes beside the main one as a second database, and its photos
/// stay in the staging folder until the merge decides which of them are new.
#[tauri::command(async)]
fn stage_merge(app: AppHandle, path: String) -> Result<(), String> {
    let staging = data_dir(&app)?.join(MERGE_STAGING_DIR);
    family_file::stage(Path::new(&path), &staging, schema_version()).map_err(text)?;

    let merge_db = db_path(&app)?.with_file_name(MERGE_DB_FILE);
    remove_database(&merge_db)?;
    fs::copy(staging.join(DB_FILE), &merge_db).map_err(text)?;
    fs::write(staging.join(MERGE_SOURCE_FILE), &path).map_err(text)
}

/// Whether a family file is waiting to be merged. The frontend asks at
/// startup and shows the merge screen instead of the tree if so.
#[tauri::command]
fn pending_merge(app: AppHandle) -> Result<bool, String> {
    if family_file::is_ready(&data_dir(&app)?.join(MERGE_STAGING_DIR)) {
        return Ok(true);
    }
    // Anything left without the marker is from a merge that never got going.
    finish_merge(app)?;
    Ok(false)
}

/// Copies the named photos and recordings from the file being merged into the
/// media folder. Fails before copying anything if one is missing, so the tree
/// never ends up pointing at a file that is not there.
#[tauri::command(async)]
fn merge_import_files(app: AppHandle, file_names: Vec<String>) -> Result<(), String> {
    let source = data_dir(&app)?.join(MERGE_STAGING_DIR).join("media");
    let dest = media_dir(&app)?;

    // `iter()` borrows each name; `try_for_each` stops at the first `Err`,
    // which `?` then returns from this function.
    file_names.iter().try_for_each(|name| require_bare_file_name(name))?;
    if let Some(missing) = file_names.iter().find(|name| !source.join(name).exists()) {
        return Err(format!("The file being merged is incomplete: {missing} is missing from it."));
    }

    for name in &file_names {
        // File names are random and unique, so one that already exists here
        // is the same file.
        if !dest.join(name).exists() {
            fs::copy(source.join(name), dest.join(name)).map_err(text)?;
        }
    }
    Ok(())
}

/// Keeps a copy of each tree that was overridden while settling merge
/// conflicts, and returns the folder they were put in.
///
/// `mine` keeps the tree as it was before the merge (already saved as a backup
/// under the same `stamp`); `theirs` keeps the family file that was merged in.
#[tauri::command(async)]
fn save_overrides(app: AppHandle, stamp: String, mine: bool, theirs: bool) -> Result<String, String> {
    let data = data_dir(&app)?;
    let dir = data.join(OVERRIDES_DIR).join(safe_name_part(&stamp));
    fs::create_dir_all(&dir).map_err(text)?;

    if mine {
        let backup = data.join(BACKUPS_DIR).join(backup_name("merge", &stamp));
        let dest = dir.join(format!("my tree before the merge.{}", family_file::EXTENSION));
        fs::copy(backup, dest).map_err(text)?;
    }
    if theirs {
        let source = fs::read_to_string(data.join(MERGE_STAGING_DIR).join(MERGE_SOURCE_FILE)).map_err(text)?;
        let dest = dir.join(format!("the file that was merged in.{}", family_file::EXTENSION));
        fs::copy(source, dest).map_err(|e| format!("The merged file could not be copied to the overrides folder: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Clears away the file being merged, after the merge is done or cancelled.
/// The frontend must close its connection to the merge database first.
#[tauri::command]
fn finish_merge(app: AppHandle) -> Result<(), String> {
    let staging = data_dir(&app)?.join(MERGE_STAGING_DIR);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(text)?;
    }
    remove_database(&db_path(&app)?.with_file_name(MERGE_DB_FILE))
}

/// Saves a copy of a stored photo or recording to a place the user chose.
#[tauri::command(async)]
fn export_media_file(app: AppHandle, file_name: String, dest: String) -> Result<(), String> {
    require_bare_file_name(&file_name)?;
    fs::copy(media_dir(&app)?.join(&file_name), &dest).map_err(text)?;
    Ok(())
}

/// Confirms a staged family file and restarts the app to act on it: with
/// `merge` the one staged by [`stage_merge`], otherwise the one staged by
/// [`stage_family_file`].
///
/// Both wait for a restart for two reasons: the SQL plugin only runs
/// migrations the first time a database is opened in a process, and Windows
/// will not let a file be replaced while something still has it open.
#[tauri::command]
fn restart_into_staged(app: AppHandle, merge: bool) -> Result<(), String> {
    let staging = if merge { MERGE_STAGING_DIR } else { STAGING_DIR };
    family_file::mark_ready(&data_dir(&app)?.join(staging)).map_err(text)?;
    if tauri::is_dev() {
        // Under `tauri dev` a relaunched app would outlive the Vite dev server
        // and show a blank window, so just exit. The staged file is applied
        // the next time `npm run tauri dev` is started.
        app.exit(0);
        return Ok(());
    }
    // `restart` has the return type `!` ("never"): it does not come back, so
    // the compiler accepts it where a `Result` is expected.
    // https://doc.rust-lang.org/book/ch20-03-advanced-types.html#the-never-type-that-never-returns
    app.restart()
}

/// Swaps in a family file staged before the last restart, if there is one.
/// The frontend calls this at startup, before it opens the database.
#[tauri::command]
fn apply_pending_open(app: AppHandle) -> Result<bool, String> {
    let staging = data_dir(&app)?.join(STAGING_DIR);
    let applied =
        family_file::apply_pending(&staging, &db_path(&app)?, &media_dir(&app)?).map_err(text)?;
    if applied {
        // The old tree's thumbnails are of no use to the new one. Failing to
        // clear a cache is not worth stopping the app for, hence `let _`.
        let _ = fs::remove_dir_all(data_dir(&app)?.join(THUMBS_DIR));
    }
    Ok(applied)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .add_migrations(MERGE_DB_URL, migrations())
                .build(),
        )
        .manage(RecorderState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_media_dir,
            import_photo,
            import_audio,
            delete_media_file,
            get_thumbs_dir,
            ensure_thumbnail,
            start_recording,
            recording_level,
            stop_recording,
            prepare_snapshot,
            write_family_file,
            write_backup,
            stage_family_file,
            restart_into_staged,
            stage_merge,
            pending_merge,
            merge_import_files,
            save_overrides,
            finish_merge,
            export_media_file,
            apply_pending_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
