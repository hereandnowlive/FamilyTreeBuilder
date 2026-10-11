//! Family files: the whole tree packed into one `.familytree` file that can be
//! handed from one family member to the next.
//!
//! A family file is an ordinary zip archive containing:
//!
//! - `manifest.json`: which version of the app wrote the file
//! - `familytree.db`: a copy of the SQLite database
//! - `media/<file>`: every stored photo
//!
//! Nothing in this module knows about Tauri. Every function takes plain paths,
//! which is what lets the tests at the bottom run against temporary folders.
//! The Tauri commands that call into here live in `lib.rs`.
//!
//! `//!` comments like this one document the enclosing module (the file),
//! where `///` documents the item that follows it.
//! Modules: https://doc.rust-lang.org/book/ch07-02-defining-modules-to-control-scope-and-privacy.html

use std::error::Error;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// File extension of a family file, without the dot.
pub const EXTENSION: &str = "familytree";

const MANIFEST_ENTRY: &str = "manifest.json";
const DB_ENTRY: &str = "familytree.db";
const MEDIA_PREFIX: &str = "media/";

/// Version of the archive layout itself. Raise it if the entries above change.
///
/// Version 2 has the same entries as version 1, and both open the same way.
/// The number went up because the database inside no longer carries the
/// bookkeeping table that early versions of the app (the ones built on the
/// SQL plugin) need to open one, and this makes those versions say "saved by
/// a newer version" instead of failing oddly.
const FORMAT_VERSION: u32 = 2;

/// Every SQLite database file starts with these 16 bytes.
/// The `b"..."` prefix makes a byte string (`&[u8; 16]`) instead of text.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Empty file written into the staging folder once it is safe to swap in.
const READY_MARKER: &str = "ready";

const NOT_A_FAMILY_FILE: &str = "This is not a Family Tree Builder file.";
const NEWER_VERSION: &str =
    "This file was saved by a newer version of Family Tree Builder. Update the app, then open it again.";

/// Result type for this module: the error can be any error type at all.
///
/// `Box<dyn Error>` is the nearest thing Rust has to catching the base
/// `Exception` class in C#. It lets `?` be used on I/O, zip and JSON errors
/// in the same function without converting each one by hand.
/// https://doc.rust-lang.org/rust-by-example/error/multiple_error_types/boxing_errors.html
pub type AnyResult<T> = Result<T, Box<dyn Error>>;

/// The contents of `manifest.json`.
///
/// `derive` asks the compiler to generate the trait implementations: here the
/// serde code that turns the struct into JSON and back, much like
/// `System.Text.Json` does by reflection, but generated at compile time.
/// https://docs.rs/serde/latest/serde/
#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    /// Highest database migration applied when the file was saved. An older
    /// app must refuse a newer file, because it cannot run migrations backwards.
    schema_version: i64,
}

/// Writes a family file to `dest` from a database snapshot and the media folder.
///
/// The archive is written to `<dest>.part` first and renamed at the end, so a
/// save that fails halfway never destroys a good file already at `dest`.
pub fn pack(snapshot: &Path, media_dir: &Path, dest: &Path, schema_version: i64) -> AnyResult<()> {
    // Paths are not guaranteed to be UTF-8, so the suffix is appended to the
    // OS-native string rather than through `format!`.
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);

    let result = write_archive(snapshot, media_dir, &part, schema_version);
    if result.is_err() {
        // `let _ =` deliberately ignores the outcome: the original error is the
        // one worth reporting, not a failure to tidy up after it.
        let _ = fs::remove_file(&part);
        return result;
    }
    fs::rename(&part, dest)?;
    Ok(())
}

/// Does the actual zip writing for [`pack`].
fn write_archive(snapshot: &Path, media_dir: &Path, part: &Path, schema_version: i64) -> AnyResult<()> {
    let mut zip = ZipWriter::new(File::create(part)?);
    let compressed = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // Photos are already compressed, so they are stored as-is. That keeps saving fast.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let manifest = Manifest { format: FORMAT_VERSION, schema_version };
    zip.start_file(MANIFEST_ENTRY, compressed)?;
    zip.write_all(serde_json::to_string(&manifest)?.as_bytes())?;

    zip.start_file(DB_ENTRY, compressed)?;
    // `io::copy` streams from a reader to a writer, like `Stream.CopyTo` in C#,
    // so a large file is never held in memory all at once.
    io::copy(&mut File::open(snapshot)?, &mut zip)?;

    if media_dir.is_dir() {
        for entry in fs::read_dir(media_dir)? {
            // Each directory entry is itself a `Result`, because reading it can fail.
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            // `let ... else` binds on success and runs the `else` block otherwise.
            // A name that is not valid UTF-8 cannot have come from this app, so skip it.
            // https://doc.rust-lang.org/rust-by-example/flow_control/let_else.html
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            zip.start_file(format!("{MEDIA_PREFIX}{file_name}"), stored)?;
            io::copy(&mut File::open(entry.path())?, &mut zip)?;
        }
    }

    // Writes the zip's index. Without this call the file is not a valid archive.
    zip.finish()?;
    Ok(())
}

/// Checks that `source` is a family file this app can read and unpacks it into
/// the `staging` folder. The app's live data is not touched.
///
/// The staged copy only replaces the live data after [`mark_ready`] and then
/// [`apply_pending`] on the next start.
pub fn stage(source: &Path, staging: &Path, max_schema_version: i64) -> AnyResult<()> {
    if staging.exists() {
        fs::remove_dir_all(staging)?;
    }
    let media = staging.join("media");
    fs::create_dir_all(&media)?;

    // `map_err(|_| ...)` swaps the library's technical error for a message a
    // family member can act on. `?` then turns the `&str` into a `Box<dyn Error>`.
    let mut archive = ZipArchive::new(File::open(source)?).map_err(|_| NOT_A_FAMILY_FILE)?;

    // The inner block limits how long `entry` borrows `archive`: the borrow ends
    // at the closing brace, which frees `archive` for the loop below.
    // https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html
    let manifest: Manifest = {
        let entry = archive.by_name(MANIFEST_ENTRY).map_err(|_| NOT_A_FAMILY_FILE)?;
        serde_json::from_reader(entry).map_err(|_| NOT_A_FAMILY_FILE)?
    };
    if manifest.format > FORMAT_VERSION || manifest.schema_version > max_schema_version {
        return Err(NEWER_VERSION.into());
    }

    let mut found_db = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        // `into_owned` copies the name into a `String` of our own, so `entry`
        // is no longer borrowed and can be read from further down.
        let name = entry.name()?.into_owned();

        // Only known entries are extracted, each to a path built here. A path
        // stored inside the archive is never trusted, which is what stops a
        // crafted file from writing outside the staging folder ("zip slip").
        let target = if name == DB_ENTRY {
            found_db = true;
            staging.join(DB_ENTRY)
        } else if let Some(file_name) = name.strip_prefix(MEDIA_PREFIX).filter(|f| is_bare_file_name(f)) {
            media.join(file_name)
        } else {
            continue;
        };
        io::copy(&mut entry, &mut File::create(target)?)?;
    }

    let mut header = [0u8; 16];
    let is_database = found_db
        && File::open(staging.join(DB_ENTRY))?.read_exact(&mut header).is_ok()
        && &header == SQLITE_MAGIC;
    if !is_database {
        return Err(NOT_A_FAMILY_FILE.into());
    }
    Ok(())
}

/// Marks a staged family file as complete, so the next start swaps it in.
pub fn mark_ready(staging: &Path) -> AnyResult<()> {
    File::create(staging.join(READY_MARKER))?;
    Ok(())
}

/// Whether a staged family file has been marked complete with [`mark_ready`].
pub fn is_ready(staging: &Path) -> bool {
    staging.join(READY_MARKER).exists()
}

/// Replaces the live database and media folder with a staged family file, if
/// one is waiting. Returns whether anything was replaced.
///
/// Must run before the database is opened. Each step is safe to repeat, so if
/// it fails partway the next start simply tries again.
pub fn apply_pending(staging: &Path, db_path: &Path, media_dir: &Path) -> AnyResult<bool> {
    if !staging.join(READY_MARKER).exists() {
        // A staging folder without the marker is left over from an open that
        // was cancelled or failed. It was never confirmed, so discard it.
        if staging.exists() {
            fs::remove_dir_all(staging)?;
        }
        return Ok(false);
    }

    // SQLite keeps recent writes in "-wal" and "-shm" files beside the database.
    // Ones left by the old database must not be replayed over the new one.
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = db_path.as_os_str().to_owned();
        sidecar.push(suffix);
        remove_file_if_exists(Path::new(&sidecar))?;
    }
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Copied rather than moved: the database folder can be on a different drive
    // from the staging folder, and a rename cannot cross drives.
    fs::copy(staging.join(DB_ENTRY), db_path)?;

    let staged_media = staging.join("media");
    if staged_media.exists() {
        if media_dir.exists() {
            fs::remove_dir_all(media_dir)?;
        }
        fs::rename(&staged_media, media_dir)?;
    }

    fs::remove_dir_all(staging)?;
    Ok(true)
}

/// Deletes all but the `keep` most recently written family files in `dir`.
pub fn prune_backups(dir: &Path, keep: usize) -> AnyResult<()> {
    let mut backups: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension() == Some(OsStr::new(EXTENSION)) {
            backups.push((entry.metadata()?.modified()?, path));
        }
    }
    // Tuples compare field by field, so this sorts by time. Reversed, newest is first.
    backups.sort();
    backups.reverse();
    // `into_iter` hands over ownership of each element; `skip` passes over the ones to keep.
    for (_, path) in backups.into_iter().skip(keep) {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Deletes a file, treating "it was not there" as success.
pub fn remove_file_if_exists(path: &Path) -> io::Result<()> {
    // `match` with a guard (`if ...`) on one arm: only the NotFound error is swallowed.
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// True when `name` is a plain file name with no folder parts, so joining it
/// to a folder cannot produce a path outside that folder.
fn is_bare_file_name(name: &str) -> bool {
    Path::new(name).file_name() == Some(OsStr::new(name))
}

/// Unit tests live beside the code they test. `#[cfg(test)]` compiles this
/// module only for `cargo test`, so none of it ships in the app.
/// https://doc.rust-lang.org/book/ch11-01-writing-tests.html
#[cfg(test)]
mod tests {
    // Brings everything from the parent module into scope, private items included.
    use super::*;

    /// A fresh, empty folder under the system temp directory.
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("family-tree-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Stand-in for a database: the SQLite header followed by recognisable bytes.
    fn fake_db(marker: &str) -> Vec<u8> {
        [SQLITE_MAGIC.as_slice(), marker.as_bytes()].concat()
    }

    #[test]
    fn save_then_open_replaces_database_and_photos() {
        let root = temp_dir();

        // The sender's data, packed into a family file.
        let sender_media = root.join("sender-media");
        fs::create_dir_all(&sender_media).unwrap();
        fs::write(sender_media.join("gran.jpg"), b"gran").unwrap();
        let snapshot = root.join("snapshot.db");
        fs::write(&snapshot, fake_db("sender")).unwrap();
        let file = root.join("Smith.familytree");
        pack(&snapshot, &sender_media, &file, 1).unwrap();
        assert!(!root.join("Smith.familytree.part").exists());

        // The receiver's existing data, including leftovers that must not survive.
        let db = root.join("config").join("familytree.db");
        let media = root.join("data").join("media");
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        fs::create_dir_all(&media).unwrap();
        fs::write(&db, fake_db("receiver")).unwrap();
        fs::write(root.join("config").join("familytree.db-wal"), b"stale").unwrap();
        fs::write(media.join("old.jpg"), b"old").unwrap();

        let staging = root.join("data").join("pending-open");
        stage(&file, &staging, 1).unwrap();

        // Staged but not confirmed: nothing is applied and the staging folder is discarded.
        assert!(!apply_pending(&staging, &db, &media).unwrap());
        assert_eq!(fs::read(&db).unwrap(), fake_db("receiver"));
        assert!(!staging.exists());

        stage(&file, &staging, 1).unwrap();
        mark_ready(&staging).unwrap();
        assert!(apply_pending(&staging, &db, &media).unwrap());

        assert_eq!(fs::read(&db).unwrap(), fake_db("sender"));
        assert_eq!(fs::read(media.join("gran.jpg")).unwrap(), b"gran");
        assert!(!media.join("old.jpg").exists());
        assert!(!root.join("config").join("familytree.db-wal").exists());
        assert!(!staging.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_files_it_should_not_open() {
        let root = temp_dir();
        let media = root.join("media");
        fs::create_dir_all(&media).unwrap();
        let snapshot = root.join("snapshot.db");
        let staging = root.join("pending-open");

        // Not a zip at all.
        let text = root.join("notes.familytree");
        fs::write(&text, b"hello").unwrap();
        assert_eq!(stage(&text, &staging, 1).unwrap_err().to_string(), NOT_A_FAMILY_FILE);

        // Saved by an app with a newer database schema.
        fs::write(&snapshot, fake_db("x")).unwrap();
        let newer = root.join("newer.familytree");
        pack(&snapshot, &media, &newer, 2).unwrap();
        assert_eq!(stage(&newer, &staging, 1).unwrap_err().to_string(), NEWER_VERSION);

        // The right layout, but the database entry is not a SQLite file.
        fs::write(&snapshot, b"not a database").unwrap();
        let broken = root.join("broken.familytree");
        pack(&snapshot, &media, &broken, 1).unwrap();
        assert_eq!(stage(&broken, &staging, 1).unwrap_err().to_string(), NOT_A_FAMILY_FILE);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_entries_that_point_outside_the_media_folder() {
        let root = temp_dir();
        let file = root.join("crafted.familytree");

        let mut zip = ZipWriter::new(File::create(&file).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(MANIFEST_ENTRY, options).unwrap();
        zip.write_all(br#"{"format":1,"schema_version":1}"#).unwrap();
        zip.start_file(DB_ENTRY, options).unwrap();
        zip.write_all(&fake_db("x")).unwrap();
        zip.start_file("media/../../escaped.txt", options).unwrap();
        zip.write_all(b"bad").unwrap();
        zip.start_file("media/sub/nested.jpg", options).unwrap();
        zip.write_all(b"bad").unwrap();
        zip.start_file("media/ok.jpg", options).unwrap();
        zip.write_all(b"ok").unwrap();
        zip.finish().unwrap();

        let staging = root.join("a").join("pending-open");
        stage(&file, &staging, 1).unwrap();

        assert!(staging.join("media").join("ok.jpg").exists());
        assert!(!root.join("escaped.txt").exists());
        assert!(!root.join("a").join("escaped.txt").exists());
        assert_eq!(fs::read_dir(staging.join("media")).unwrap().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_only_the_newest_backups() {
        let root = temp_dir();
        for name in ["a", "b", "c", "d"] {
            fs::write(root.join(format!("{name}.{EXTENSION}")), name).unwrap();
            // File times can be coarse, so space the writes out enough to order them.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        fs::write(root.join("unrelated.txt"), "keep").unwrap();

        prune_backups(&root, 2).unwrap();

        let mut left: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["c.familytree", "d.familytree", "unrelated.txt"]);

        fs::remove_dir_all(root).unwrap();
    }
}
