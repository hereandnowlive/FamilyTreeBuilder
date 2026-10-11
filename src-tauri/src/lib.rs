// `mod` pulls in src/family_file.rs as a child module. Unlike a TypeScript import,
// a Rust file is not part of the program until some `mod` line declares it.
mod db;
mod family_file;
mod merge;
mod recorder;
mod rotate;
mod thumbnail;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use db::Row;
use recorder::Recorder;
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

/// The database file, inside the app's config folder.
const DB_FILE: &str = "familytree.db";

/// Where earlier versions of the app kept a copy of the database being merged
/// in. Nothing writes it any more; `finish_merge` still clears one away.
const LEGACY_MERGE_DB_FILE: &str = "merge-incoming.db";
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

/// The open database connection, shared by every command.
///
/// It starts as `None` and is opened the first time a command needs it (see
/// [`with_db`]), which is after `apply_pending_open` has had the chance to
/// swap in a family file. The `Mutex` means one command uses the database at
/// a time, so two commands can never interleave their statements.
struct DbState(Mutex<Option<Connection>>);

const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];
/// Formats the webview can play on both Windows and Linux.
const AUDIO_EXTENSIONS: [&str; 7] = ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"];

/// The kinds of file that can be attached to a person as a document. Must match
/// DOCUMENT_FILTER in src/fileFilters.ts.
///
/// This list is also a safety check. Opening a document hands it to whatever
/// program the computer uses for that kind of file, and for a program or a
/// script that would mean running it. A family file from someone else could
/// carry anything, so only these harmless kinds are ever opened. The
/// macro-carrying Office formats (.docm, .xlsm) are left out on purpose.
const DOCUMENT_EXTENSIONS: [&str; 13] = [
    "pdf", "doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp",
];

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

/// Full path of the database file. It is in the config folder, which on Linux
/// is a different folder from the data folder (on Windows the two are the
/// same). It has always been there, so it stays there.
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(text)?.join(DB_FILE))
}

/// Runs `work` with the database connection, opening the database first if
/// this is the first use, and turns any error into text for the frontend.
///
/// The signature is generic, like `T WithDb<T>(Func<Connection, T> work)` in
/// C#. `impl FnOnce(...)` accepts any closure that will be called once, and
/// `E: Display` accepts any error type that can be printed, so functions from
/// `db.rs` can be passed in whatever kind of error they return.
/// https://doc.rust-lang.org/book/ch13-01-closures.html
fn with_db<T, E: Display>(app: &AppHandle, work: impl FnOnce(&mut Connection) -> Result<T, E>) -> Result<T, String> {
    let state = app.state::<DbState>();
    // The lock is held until `slot` goes out of scope at the end of the function.
    let mut slot = state.0.lock().map_err(text)?;
    if slot.is_none() {
        *slot = Some(db::open(&db_path(app)?).map_err(text)?);
    }
    // `as_mut` borrows the connection inside the `Option` for changing.
    let conn = slot.as_mut().ok_or("The database is not open.")?;
    work(conn).map_err(text)
}

/// Closes the database connection, if it is open. The next command to use the
/// database opens it again.
fn close_db(app: &AppHandle) -> Result<(), String> {
    // Assigning `None` drops the old connection, and dropping a `Connection`
    // closes it: Rust runs a value's clean-up when it stops being owned,
    // like `Dispose` being called for you.
    // https://doc.rust-lang.org/book/ch15-03-drop.html
    *app.state::<DbState>().0.lock().map_err(text)? = None;
    Ok(())
}

/// Deletes stored photos and recordings from the media folder, with their
/// thumbnails. Called after the rows that used them have been deleted.
fn remove_media_files(app: &AppHandle, file_names: &[String]) -> Result<(), String> {
    for file_name in file_names {
        require_bare_file_name(file_name)?;
        family_file::remove_file_if_exists(&media_dir(app)?.join(file_name)).map_err(text)?;
        // A recording has no thumbnail, which "if exists" covers.
        family_file::remove_file_if_exists(&thumb_path(app, file_name)?).map_err(text)?;
    }
    Ok(())
}

// ---- tree, people and relationships ----------------------------------------
//
// Every database command is `(async)`, which runs it on a background thread.
// A plain command runs on the main thread, where waiting for the database
// lock (held by a long merge or save, say) would freeze the window.
// https://tauri.app/develop/calling-rust/#async-commands
//
// Tauri converts argument names for the frontend: `person_id` here is
// `personId` in the `invoke` call in src/db.ts.

#[tauri::command(async)]
fn load_tree(app: AppHandle) -> Result<db::Tree, String> {
    // `|conn| ...` is a closure. `with_db` calls it with the open connection.
    with_db(&app, |conn| db::load_tree(conn))
}

#[tauri::command(async)]
fn create_person(app: AppHandle, fields: db::PersonFields) -> Result<String, String> {
    with_db(&app, |conn| db::create_person(conn, &fields))
}

#[tauri::command(async)]
fn update_person(app: AppHandle, id: String, fields: db::PersonFields) -> Result<(), String> {
    with_db(&app, |conn| db::update_person(conn, &id, &fields))
}

#[tauri::command(async)]
fn delete_person(app: AppHandle, id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::delete_person(conn, &id))?;
    remove_media_files(&app, &files)
}

#[tauri::command(async)]
fn link_relative(
    app: AppHandle,
    anchor_id: String,
    kind: db::Relation,
    relative_id: String,
    co_parent_id: Option<String>,
) -> Result<(), String> {
    // `as_deref` turns `Option<String>` into `Option<&str>`: a borrowed view
    // of the text instead of the owned string.
    with_db(&app, |conn| db::link_relative(conn, &anchor_id, kind, &relative_id, co_parent_id.as_deref()))
}

#[tauri::command(async)]
fn remove_partnership(app: AppHandle, a: String, b: String) -> Result<(), String> {
    with_db(&app, |conn| db::remove_partnership(conn, &a, &b))
}

#[tauri::command(async)]
fn remove_parent_link(app: AppHandle, parent_id: String, child_id: String) -> Result<(), String> {
    with_db(&app, |conn| db::remove_parent_link(conn, &parent_id, &child_id))
}

// ---- major events ----------------------------------------------------------

#[tauri::command(async)]
fn list_events(app: AppHandle, person_id: String) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| db::list_events(conn, &person_id))
}

#[tauri::command(async)]
fn list_event_links(app: AppHandle, person_id: String) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| db::list_event_links(conn, &person_id))
}

#[tauri::command(async)]
fn create_event(app: AppHandle, person_id: String) -> Result<String, String> {
    with_db(&app, |conn| db::create_event(conn, &person_id))
}

#[tauri::command(async)]
fn add_event_person(app: AppHandle, event_id: String, person_id: String) -> Result<(), String> {
    with_db(&app, |conn| db::add_event_person(conn, &event_id, &person_id))
}

#[tauri::command(async)]
fn remove_event_person(app: AppHandle, event_id: String, person_id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::remove_event_person(conn, &event_id, &person_id))?;
    remove_media_files(&app, &files)
}

#[tauri::command(async)]
fn update_event(app: AppHandle, id: String, fields: db::EventFields) -> Result<(), String> {
    with_db(&app, |conn| db::update_event(conn, &id, &fields))
}

#[tauri::command(async)]
fn delete_event(app: AppHandle, id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::delete_event(conn, &id))?;
    remove_media_files(&app, &files)
}

// ---- photos and recordings -------------------------------------------------

#[tauri::command(async)]
fn get_media(app: AppHandle, id: String) -> Result<Option<Row>, String> {
    with_db(&app, |conn| db::get_media(conn, &id))
}

#[tauri::command(async)]
fn list_media(app: AppHandle, person_id: String) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| db::list_media(conn, &person_id))
}

#[tauri::command(async)]
fn update_caption(app: AppHandle, media_id: String, caption: String) -> Result<(), String> {
    with_db(&app, |conn| db::update_caption(conn, &media_id, &caption))
}

#[tauri::command(async)]
fn update_description(app: AppHandle, media_id: String, description: String) -> Result<(), String> {
    with_db(&app, |conn| db::update_description(conn, &media_id, &description))
}

#[tauri::command(async)]
fn set_portrait(app: AppHandle, person_id: String, media_id: Option<String>) -> Result<(), String> {
    with_db(&app, |conn| db::set_portrait(conn, &person_id, media_id.as_deref()))
}

/// Turns a photo a quarter turn and saves it that way. Returns the name of
/// the file the photo is now stored in.
///
/// The turned picture is a new file under a new name, and the old one is
/// deleted. A new name matters: thumbnails and the webview both remember a
/// picture by its file name, and a merge treats two files with the same name
/// as the same picture.
#[tauri::command(async)]
fn rotate_photo(app: AppHandle, id: String, clockwise: bool) -> Result<String, String> {
    let media = media_dir(&app)?;
    let old = with_db(&app, |conn| db::media_file(conn, &id))?.ok_or("This photo is no longer in the tree.")?;
    require_bare_file_name(&old)?;

    let stem = uuid::Uuid::new_v4().to_string();
    let new = rotate::rotate(&media.join(&old), &media, &stem, clockwise).map_err(text)?;

    // `&new` is borrowed by the closure, so `new` can still be returned below.
    let swapped = with_db(&app, |conn| db::replace_media_file(conn, &id, &new));
    if swapped.is_err() {
        // No row points at the new file, so do not leave it behind.
        let _ = remove_media_files(&app, std::slice::from_ref(&new));
    }
    // The row is safely pointing at the new file before the old one goes.
    remove_media_files(&app, &[swapped?])?;
    Ok(new)
}

#[tauri::command(async)]
fn delete_media(app: AppHandle, id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::delete_media(conn, &id))?;
    remove_media_files(&app, &files)
}

#[tauri::command(async)]
fn list_recordings(app: AppHandle, media_id: String) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| db::list_recordings(conn, &media_id))
}

#[tauri::command(async)]
fn update_recording_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    with_db(&app, |conn| db::update_recording_title(conn, &id, &title))
}

#[tauri::command(async)]
fn delete_recording(app: AppHandle, id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::delete_recording(conn, &id))?;
    remove_media_files(&app, &files)
}

// ---- documents -------------------------------------------------------------

#[tauri::command(async)]
fn list_documents(app: AppHandle, person_id: String) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| db::list_documents(conn, &person_id))
}

/// Copies a document (a PDF, a Word file and so on) into the media folder and
/// attaches it to the person.
#[tauri::command(async)]
fn import_document(app: AppHandle, person_id: String, source: String, title: String) -> Result<(), String> {
    let file_name = import_file(
        &app,
        &source,
        &DOCUMENT_EXTENSIONS,
        "Not a supported kind of document. PDF, Word, Excel, PowerPoint, OpenDocument and text files can be added.",
    )?;
    let result = with_db(&app, |conn| db::add_document(conn, &person_id, &file_name, &title));
    if result.is_err() {
        // No row points at the copy, so do not leave it behind.
        let _ = remove_media_files(&app, &[file_name]);
    }
    result
}

#[tauri::command(async)]
fn update_document_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    with_db(&app, |conn| db::update_document_title(conn, &id, &title))
}

#[tauri::command(async)]
fn delete_document(app: AppHandle, id: String) -> Result<(), String> {
    let files = with_db(&app, |conn| db::delete_document(conn, &id))?;
    remove_media_files(&app, &files)
}

/// Opens a stored document in the program the computer uses for that kind of
/// file: a PDF in the PDF viewer, a .docx in Word or LibreOffice.
///
/// The frontend sends the document's id, not a path, so the only files this
/// can ever open are ones recorded in the `document` table, and only if they
/// are one of the allowed kinds (see `DOCUMENT_EXTENSIONS`).
#[tauri::command(async)]
fn open_document(app: AppHandle, id: String) -> Result<(), String> {
    let file_name =
        with_db(&app, |conn| db::document_file(conn, &id))?.ok_or("This document is no longer in the tree.")?;
    require_bare_file_name(&file_name)?;

    let path = media_dir(&app)?.join(&file_name);
    // `is_some_and` is true only when there is an extension and it passes the test.
    let allowed = path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| DOCUMENT_EXTENSIONS.contains(&extension.to_lowercase().as_str()));
    if !allowed {
        return Err("This kind of file cannot be opened from the app. Use \"Save a copy\" instead.".into());
    }
    if !path.exists() {
        return Err("The file for this document is missing from the app's storage.".into());
    }
    // `open::that` asks the operating system to open the file, the same as
    // double-clicking it. https://docs.rs/open/
    open::that(&path).map_err(|e| format!("The computer could not open this document: {e}"))
}

// ---- media files -----------------------------------------------------------

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

/// Copies an image into the media folder and adds it to the event as a photo.
/// Returns the new photo's id.
#[tauri::command(async)]
fn import_photo(app: AppHandle, person_id: String, source: String, event_id: String) -> Result<String, String> {
    let file_name = import_file(&app, &source, &IMAGE_EXTENSIONS, "Not a supported image file")?;
    let result = with_db(&app, |conn| db::add_media(conn, &person_id, &event_id, &file_name));
    if result.is_err() {
        // No row points at the copy, so do not leave it behind.
        let _ = remove_media_files(&app, &[file_name]);
    }
    result
}

/// Copies an audio file into the media folder and attaches it to the photo.
#[tauri::command(async)]
fn import_recording(app: AppHandle, media_id: String, source: String, title: String) -> Result<(), String> {
    let file_name = import_file(&app, &source, &AUDIO_EXTENSIONS, "Not a supported audio file")?;
    attach_recording(&app, &media_id, file_name, &title)
}

/// Records a file already in the media folder as a recording on the photo, or
/// deletes the file if that fails.
///
/// `file_name` is taken by value (`String`, not `&str`): this function becomes
/// its owner, which is what lets it hand the name on to be deleted.
/// https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html
fn attach_recording(app: &AppHandle, media_id: &str, file_name: String, title: &str) -> Result<(), String> {
    let result = with_db(app, |conn| db::add_recording(conn, media_id, &file_name, title));
    if result.is_err() {
        let _ = remove_media_files(app, &[file_name]);
    }
    result
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
fn stop_recording(app: &AppHandle, state: &State<RecorderState>, keep: bool) -> Result<Option<String>, String> {
    // `take` moves the recorder out of the slot and leaves `None` behind. The
    // lock guard is a temporary here, so it is released at the end of this
    // statement and the mutex is not held while the file is being finished.
    let recorder = state
        .0
        .lock()
        .map_err(text)?
        .take()
        .ok_or("No recording is in progress.")?;

    let temp = data_dir(app)?.join(RECORDING_FILE);
    let result = recorder.finish();
    if !keep || result.is_err() {
        let _ = fs::remove_file(&temp);
        // Passes an error from `finish` on; a discarded recording is `Ok(None)`.
        return result.map(|()| None);
    }

    let file_name = format!("{}.mp3", uuid::Uuid::new_v4());
    fs::rename(&temp, media_dir(app)?.join(&file_name)).map_err(text)?;
    Ok(Some(file_name))
}

/// Stops the recording in progress and attaches it to the photo.
#[tauri::command(async)]
fn save_recording(app: AppHandle, state: State<RecorderState>, media_id: String, title: String) -> Result<(), String> {
    match stop_recording(&app, &state, true)? {
        Some(file_name) => attach_recording(&app, &media_id, file_name, &title),
        None => Ok(()),
    }
}

/// Stops the recording in progress and throws it away.
#[tauri::command(async)]
fn discard_recording(app: AppHandle, state: State<RecorderState>) -> Result<(), String> {
    // `map(|_| ())` keeps success or failure and drops the value inside.
    stop_recording(&app, &state, false).map(|_| ())
}

/// Packs the whole tree, photos included, into a family file at `dest`.
///
/// The database is copied first, to a temporary snapshot file, so the archive
/// holds one consistent moment even if the app is being used while it is
/// written. The database lock is only held for that copy, not while the
/// photos are zipped.
fn pack_tree(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let snapshot = data_dir(app)?.join(SNAPSHOT_FILE);
    // `VACUUM INTO` refuses to overwrite, so clear any snapshot left by a failed save.
    family_file::remove_file_if_exists(&snapshot).map_err(text)?;
    with_db(app, |conn| db::snapshot_into(conn, &snapshot))?;

    let result = family_file::pack(&snapshot, &media_dir(app)?, dest, db::schema_version());
    let _ = fs::remove_file(&snapshot);
    result.map_err(text)
}

/// Saves the whole tree as one family file at the path the user chose.
#[tauri::command(async)]
fn write_family_file(app: AppHandle, dest: String) -> Result<(), String> {
    pack_tree(&app, Path::new(&dest))
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

/// Saves the tree into the app's own backups folder and keeps only the most
/// recent few.
fn backup(app: &AppHandle, reason: &str, stamp: &str) -> Result<(), String> {
    let dir = data_dir(app)?.join(BACKUPS_DIR);
    fs::create_dir_all(&dir).map_err(text)?;
    pack_tree(app, &dir.join(backup_name(reason, stamp)))?;
    family_file::prune_backups(&dir, BACKUPS_KEPT).map_err(text)
}

/// Backs up the tree before a family file replaces it.
#[tauri::command(async)]
fn write_backup(app: AppHandle, stamp: String) -> Result<(), String> {
    backup(&app, "open", &stamp)
}

/// Checks the family file at `path` and unpacks it into the staging folder.
/// The current tree is untouched, so a bad file changes nothing.
#[tauri::command(async)]
fn stage_family_file(app: AppHandle, path: String) -> Result<(), String> {
    let staging = data_dir(&app)?.join(STAGING_DIR);
    family_file::stage(Path::new(&path), &staging, db::schema_version()).map_err(text)
}

/// Checks the family file at `path` and unpacks it ready to be merged into the
/// current tree. Nothing in the current tree changes.
///
/// Its database and photos stay in the staging folder: the database is read
/// from there for comparison, and the merge copies across the photos that are new.
#[tauri::command(async)]
fn stage_merge(app: AppHandle, path: String) -> Result<(), String> {
    let staging = data_dir(&app)?.join(MERGE_STAGING_DIR);
    family_file::stage(Path::new(&path), &staging, db::schema_version()).map_err(text)?;
    fs::write(staging.join(MERGE_SOURCE_FILE), &path).map_err(text)?;
    // Marked last, once everything is in place. The marker is what makes the
    // merge screen come back if the app is closed before the merge is decided.
    family_file::mark_ready(&staging).map_err(text)
}

/// Whether a family file is waiting to be merged, left from the last time the
/// app was open. The frontend asks at startup and shows the merge screen
/// instead of the tree if so.
#[tauri::command]
fn pending_merge(app: AppHandle) -> Result<bool, String> {
    if family_file::is_ready(&data_dir(&app)?.join(MERGE_STAGING_DIR)) {
        return Ok(true);
    }
    // Anything left without the marker is from a merge that never got going.
    finish_merge(app)?;
    Ok(false)
}

/// Both trees in full, for the frontend to compare: the current one and the
/// one in the file being merged.
///
/// The `json!` macro at the end builds the `{ mine, theirs }` object the
/// frontend receives, without declaring a struct for a shape used once.
#[tauri::command(async)]
fn merge_snapshots(app: AppHandle) -> Result<serde_json::Value, String> {
    // Opening the file's database also brings it up to the current schema if
    // it is from an older version. It is a staged copy, so changing it is fine.
    let incoming = db::open(&data_dir(&app)?.join(MERGE_STAGING_DIR).join(DB_FILE)).map_err(text)?;
    let theirs = merge::snapshot(&incoming).map_err(text)?;
    let mine = with_db(&app, |conn| merge::snapshot(conn))?;
    // `incoming` is closed when it goes out of scope here, which lets
    // `finish_merge` delete the file afterwards (Windows will not delete an open file).
    Ok(serde_json::json!({ "mine": mine, "theirs": theirs }))
}

/// Copies the named photos and recordings from the file being merged into the
/// media folder, and returns the ones that were not already there. Fails
/// before copying anything if one is missing, so the tree never ends up
/// pointing at a file that is not there.
fn merge_import_files(app: &AppHandle, file_names: &[String]) -> Result<Vec<String>, String> {
    let source = data_dir(app)?.join(MERGE_STAGING_DIR).join("media");
    let dest = media_dir(app)?;

    // `iter()` borrows each name; `try_for_each` stops at the first `Err`,
    // which `?` then returns from this function.
    file_names.iter().try_for_each(|name| require_bare_file_name(name))?;
    if let Some(missing) = file_names.iter().find(|name| !source.join(name).exists()) {
        return Err(format!("The file being merged is incomplete: {missing} is missing from it."));
    }

    let mut copied = Vec::new();
    for name in file_names {
        // File names are random and unique, so one that already exists here
        // is the same file.
        if !dest.join(name).exists() {
            fs::copy(source.join(name), dest.join(name)).map_err(text)?;
            copied.push(name.clone());
        }
    }
    Ok(copied)
}

/// Keeps a copy of each tree that was overridden while settling merge
/// conflicts, and returns the folder they were put in.
///
/// `mine` keeps the tree as it was before the merge (already saved as a backup
/// under the same `stamp`); `theirs` keeps the family file that was merged in.
fn save_overrides(app: &AppHandle, stamp: &str, mine: bool, theirs: bool) -> Result<String, String> {
    let data = data_dir(app)?;
    let dir = data.join(OVERRIDES_DIR).join(safe_name_part(stamp));
    fs::create_dir_all(&dir).map_err(text)?;

    if mine {
        let backup = data.join(BACKUPS_DIR).join(backup_name("merge", stamp));
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

/// Carries out a merge plan. `choices` holds the user's decision for every
/// conflict, by its key.
///
/// A backup of the current tree is always taken first. If any conflict was
/// settled, a copy of each tree that lost out is also kept in the overrides
/// folder, whose path is returned (`None`, which arrives as `null`, if there
/// were no conflicts).
///
/// The database changes are one transaction, so if anything fails the tree is
/// exactly as it was before.
#[tauri::command(async)]
fn apply_merge(
    app: AppHandle,
    plan: merge::Plan,
    choices: HashMap<String, merge::Choice>,
    stamp: String,
) -> Result<Option<String>, String> {
    backup(&app, "merge", &stamp)?;

    // `values()` walks the choices; `any` is LINQ's `Any`.
    let overrides_dir = if choices.is_empty() {
        None
    } else {
        // Whichever side was not chosen somewhere is the one that lost there.
        let mine_lost = choices.values().any(|choice| *choice == merge::Choice::Theirs);
        let theirs_lost = choices.values().any(|choice| *choice == merge::Choice::Mine);
        Some(save_overrides(&app, &stamp, mine_lost, theirs_lost)?)
    };

    let copied = merge_import_files(&app, &plan.files)?;
    let result = with_db(&app, |conn| merge::apply(conn, &plan, &choices));
    if result.is_err() {
        // The rows were rolled back, so take the photos back out as well.
        let _ = remove_media_files(&app, &copied);
    }
    result?;
    Ok(overrides_dir)
}

/// Clears away the file being merged, after the merge is done or cancelled.
#[tauri::command]
fn finish_merge(app: AppHandle) -> Result<(), String> {
    let staging = data_dir(&app)?.join(MERGE_STAGING_DIR);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(text)?;
    }
    remove_database(&db_path(&app)?.with_file_name(LEGACY_MERGE_DB_FILE))
}

/// Saves a copy of a stored photo or recording to a place the user chose.
#[tauri::command(async)]
fn export_media_file(app: AppHandle, file_name: String, dest: String) -> Result<(), String> {
    require_bare_file_name(&file_name)?;
    fs::copy(media_dir(&app)?.join(&file_name), &dest).map_err(text)?;
    Ok(())
}

/// Confirms the family file staged by [`stage_family_file`] and restarts the
/// app to swap it in.
///
/// Opening a file waits for a restart because the database and media folder
/// are swapped at startup, before anything has them open (Windows will not
/// let an open file be replaced). A merge needs no restart: it only adds to
/// the tree that is already open.
#[tauri::command]
fn restart_into_staged(app: AppHandle) -> Result<(), String> {
    family_file::mark_ready(&data_dir(&app)?.join(STAGING_DIR)).map_err(text)?;
    // Closed properly first, so SQLite folds its "-wal" file into the database.
    close_db(&app)?;
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
        .manage(RecorderState(Mutex::new(None)))
        .manage(DbState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_tree,
            create_person,
            update_person,
            delete_person,
            link_relative,
            remove_partnership,
            remove_parent_link,
            list_events,
            list_event_links,
            create_event,
            add_event_person,
            remove_event_person,
            update_event,
            delete_event,
            get_media,
            list_media,
            update_caption,
            update_description,
            set_portrait,
            rotate_photo,
            delete_media,
            list_recordings,
            update_recording_title,
            delete_recording,
            list_documents,
            import_document,
            update_document_title,
            delete_document,
            open_document,
            get_media_dir,
            import_photo,
            import_recording,
            get_thumbs_dir,
            ensure_thumbnail,
            start_recording,
            recording_level,
            save_recording,
            discard_recording,
            write_family_file,
            write_backup,
            stage_family_file,
            restart_into_staged,
            stage_merge,
            pending_merge,
            merge_snapshots,
            apply_merge,
            finish_merge,
            export_media_file,
            apply_pending_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
