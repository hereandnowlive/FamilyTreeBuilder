//! The database: opening it, bringing it up to date, and every query the app
//! runs against it.
//!
//! This is the counterpart of a repository class in C#. Nothing in here knows
//! about Tauri: every function takes a [`Connection`] and plain values, which
//! is what lets the tests at the bottom run against a database held in memory.
//! The Tauri commands that call into here live in `lib.rs`.
//!
//! SQLite itself is compiled into the app by the `rusqlite` crate (its
//! `bundled` feature), so the app does not depend on whatever SQLite the
//! computer happens to have installed.
//! https://docs.rs/rusqlite/
//!
//! Two rules hold throughout:
//!
//! - Anything that changes more than one row does so inside a transaction, so
//!   it either happens completely or not at all.
//! - A function that removes photos or recordings only removes their rows. It
//!   returns the file names, and the caller deletes the files once the change
//!   is safely committed. A file is never deleted for a row that survived.

use std::fs;
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, Params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::family_file::AnyResult;

/// Every database migration, oldest first. `include_str!` is a macro that
/// pastes the file's text into the program at compile time, so the `.sql`
/// files do not have to be shipped beside the app.
///
/// Never edit a migration that has shipped; add a new file to the end of this
/// list. The position in the list is the version: the first entry is version 1.
const MIGRATIONS: [&str; 4] = [
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_events.sql"),
    include_str!("../migrations/003_photos_in_events.sql"),
    include_str!("../migrations/004_shared_events.sql"),
];

/// The most parents one person can have. Must match MAX_PARENTS in src/relations.ts.
const MAX_PARENTS: usize = 2;

const NEWER_DATABASE: &str =
    "This tree was last used with a newer version of Family Tree Builder. Update the app, then open it again.";

/// One row of a query result, as a JSON object keyed by column name. Tauri
/// sends it to the frontend as it is, where it matches the types in
/// src/types.ts. It plays the part of `Dictionary<string, object?>` in C#.
///
/// Using one loose row type for every table, rather than a struct per table,
/// keeps the column list in one place (the SQL): a new column reaches the
/// frontend without any Rust changes.
pub type Row = serde_json::Map<String, Value>;

/// The newest migration version this build knows. It is written into every
/// family file so an older copy of the app can tell it must not open a newer file.
pub fn schema_version() -> i64 {
    // `as` converts between number types; `len()` returns `usize`.
    MIGRATIONS.len() as i64
}

/// Opens the database at `path`, creating it if it does not exist, and brings
/// it up to the current schema.
pub fn open(path: &Path) -> AnyResult<Connection> {
    // `if let Some(x) = ...` runs the block only when the `Option` holds a
    // value, like `if (x is not null)` in C#.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // `mut` because running migrations needs exclusive access to the connection.
    let mut conn = Connection::open(path)?;
    // WAL keeps recent writes in a "-wal" file beside the database, which is
    // how the database has always been stored. Foreign keys are off in SQLite
    // unless asked for, on every connection.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Runs every migration the database has not had yet.
///
/// The version reached so far is kept in SQLite's own `user_version` number,
/// a spare integer in the file header meant for exactly this.
/// https://www.sqlite.org/pragma.html#pragma_user_version
fn migrate(conn: &mut Connection) -> AnyResult<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    // Databases made before the app used rusqlite were migrated by the SQL
    // plugin, which recorded its progress in a table of its own. Carry that
    // over once. The table is left alone: it does no harm.
    if version == 0 && table_exists(conn, "_sqlx_migrations")? {
        version = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success",
            [],
            |row| row.get(0),
        )?;
        conn.pragma_update(None, "user_version", version)?;
    }

    if version > schema_version() {
        // `.into()` turns the text into the boxed error type of `AnyResult`.
        return Err(NEWER_DATABASE.into());
    }

    // `enumerate` pairs each migration with its index (like `Select((x, i) => ...)`
    // in LINQ) and `skip` passes over the ones already applied.
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        // Each migration and its version number are committed together, so a
        // migration that fails halfway leaves no trace and is retried next time.
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )
}

/// Writes a complete, consistent copy of the database to `dest`, which must
/// not exist yet. `VACUUM INTO` is safe while the app is in use, which copying
/// the live file would not be.
pub fn snapshot_into(conn: &Connection, dest: &Path) -> AnyResult<()> {
    // A path is not guaranteed to be valid Unicode, so `to_str` returns an
    // `Option`. `ok_or` turns `None` into an error for `?` to return.
    let dest = dest.to_str().ok_or("The snapshot path is not valid text.")?;
    conn.execute("VACUUM INTO ?1", [dest])?;
    Ok(())
}

// ---- reading rows ----------------------------------------------------------

/// Runs a query and returns every row as a JSON object.
///
/// `impl Params` accepts anything rusqlite can bind to the `?1`, `?2`, ...
/// placeholders: `[]` for none, `[a, b]` when all are the same type, or the
/// `params!` macro for a mixture. Values are always bound, never pasted into
/// the SQL text, which is what rules out SQL injection.
/// https://docs.rs/rusqlite/latest/rusqlite/trait.Params.html
pub fn query(conn: &Connection, sql: &str, params: impl Params) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare(sql)?;
    // Copied into owned `String`s, because the names borrow from `statement`
    // and running the query below needs to borrow it mutably.
    // https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html
    let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();

    // The closure (Rust's lambda, written `|args| body`) turns one database
    // row into one JSON object.
    let rows = statement.query_map(params, |row| {
        let mut object = Row::new();
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), to_json(row.get_ref(index)?));
        }
        Ok(object)
    })?;
    // `rows` is a lazy iterator of `Result`s. Collecting into
    // `Result<Vec<_>, _>` stops at the first error and returns it.
    rows.collect()
}

/// Like [`query`], for a query with a single text column.
fn strings(conn: &Connection, sql: &str, params: impl Params) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params, |row| row.get(0))?;
    rows.collect()
}

/// Converts one SQLite value to JSON.
///
/// `match` must cover every case of the enum, and the compiler checks that it
/// does, which a C# `switch` does not.
/// https://doc.rust-lang.org/book/ch06-02-match.html
fn to_json(value: ValueRef) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => Value::from(number),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        // No table stores binary data.
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Converts a JSON value from the frontend to one SQLite can store.
pub fn from_json(value: &Value) -> AnyResult<rusqlite::types::Value> {
    use rusqlite::types::Value as Sql;
    Ok(match value {
        Value::Null => Sql::Null,
        Value::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Value::String(text) => Sql::Text(text.clone()),
        // A match arm can carry an extra `if` condition, called a guard.
        Value::Number(number) if number.is_i64() => Sql::Integer(number.as_i64().unwrap_or_default()),
        Value::Number(number) => Sql::Real(number.as_f64().unwrap_or_default()),
        Value::Array(_) | Value::Object(_) => return Err("A list or object cannot be stored in a column.".into()),
    })
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---- tree ------------------------------------------------------------------

/// Everything the tree screen needs.
///
/// `derive(Serialize)` generates the code that turns the struct into JSON.
/// `rename_all` makes `parent_links` arrive in TypeScript as `parentLinks`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    people: Vec<Row>,
    partnerships: Vec<Row>,
    parent_links: Vec<Row>,
}

pub fn load_tree(conn: &Connection) -> rusqlite::Result<Tree> {
    Ok(Tree {
        people: query(
            conn,
            "SELECT p.*, m.file_name AS portrait_file
             FROM person p
             LEFT JOIN media m ON m.id = p.portrait_media_id
             ORDER BY p.created_at, p.id",
            [],
        )?,
        partnerships: query(conn, "SELECT * FROM partnership", [])?,
        parent_links: query(conn, "SELECT * FROM parent_child", [])?,
    })
}

// ---- people ----------------------------------------------------------------

/// The editable fields of a person, as the frontend sends them (`PersonFields`
/// in src/types.ts). `derive(Deserialize)` generates the code that builds the
/// struct from JSON.
#[derive(Deserialize)]
pub struct PersonFields {
    pub given_name: String,
    pub family_name: String,
    pub sex: String,
    pub birth_date: String,
    pub birth_place: String,
    pub death_date: String,
    pub death_place: String,
    pub biography: String,
}

/// Adds a person and returns their new id.
pub fn create_person(conn: &Connection, fields: &PersonFields) -> rusqlite::Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO person (id, given_name, family_name, sex, birth_date, birth_place, death_date, death_place, biography)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            fields.given_name,
            fields.family_name,
            fields.sex,
            fields.birth_date,
            fields.birth_place,
            fields.death_date,
            fields.death_place,
            fields.biography
        ],
    )?;
    Ok(id)
}

pub fn update_person(conn: &Connection, id: &str, fields: &PersonFields) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE person SET given_name = ?2, family_name = ?3, sex = ?4, birth_date = ?5, birth_place = ?6,
                           death_date = ?7, death_place = ?8, biography = ?9
         WHERE id = ?1",
        params![
            id,
            fields.given_name,
            fields.family_name,
            fields.sex,
            fields.birth_date,
            fields.birth_place,
            fields.death_date,
            fields.death_place,
            fields.biography
        ],
    )?;
    Ok(())
}

/// Removes the person and every link to them. Events they shared with someone
/// else are kept for the others; events that were theirs alone go too, with
/// their photos and recordings. Returns the files that are no longer used.
///
/// `&mut Connection` (an exclusive borrow) is needed to start a transaction:
/// the compiler then guarantees nothing else uses the connection meanwhile.
pub fn delete_person(conn: &mut Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut files = Vec::new();

    // `&tx` works wherever a `&Connection` is wanted: a transaction can be
    // used as the connection it belongs to.
    for event_id in strings(&tx, "SELECT event_id FROM event_participant WHERE person_id = ?1", [id])? {
        files.extend(remove_event_person_rows(&tx, &event_id, id)?);
    }

    // Nothing should still belong to the person by now; this sweeps up anything that does.
    files.extend(strings(
        &tx,
        "SELECT file_name FROM media WHERE person_id = ?1
         UNION ALL
         SELECT file_name FROM audio WHERE media_id IN (SELECT id FROM media WHERE person_id = ?1)",
        [id],
    )?);
    tx.execute("DELETE FROM audio WHERE media_id IN (SELECT id FROM media WHERE person_id = ?1)", [id])?;
    tx.execute("DELETE FROM media WHERE person_id = ?1", [id])?;
    tx.execute("DELETE FROM event WHERE person_id = ?1", [id])?;
    tx.execute("DELETE FROM parent_child WHERE parent_id = ?1 OR child_id = ?1", [id])?;
    tx.execute("DELETE FROM partnership WHERE person_a_id = ?1 OR person_b_id = ?1", [id])?;
    tx.execute("DELETE FROM person WHERE id = ?1", [id])?;

    // Without `commit`, a transaction is rolled back when it goes out of
    // scope. That is what makes an early return through `?` above undo
    // everything done so far.
    // https://docs.rs/rusqlite/latest/rusqlite/struct.Transaction.html
    tx.commit()?;
    Ok(files)
}

// ---- relationships ---------------------------------------------------------

/// Records two people as a couple. The smaller id always goes first, so a
/// couple can only be stored once; `OR IGNORE` makes a repeat harmless.
///
/// `pub(crate)` makes the function visible to the rest of this app but not
/// beyond it, like `internal` in C#.
pub(crate) fn add_partnership(conn: &Connection, a: &str, b: &str) -> rusqlite::Result<()> {
    let (first, second) = if a < b { (a, b) } else { (b, a) };
    conn.execute(
        "INSERT OR IGNORE INTO partnership (id, person_a_id, person_b_id) VALUES (?1, ?2, ?3)",
        params![new_id(), first, second],
    )?;
    Ok(())
}

pub(crate) fn add_parent_link(conn: &Connection, parent_id: &str, child_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO parent_child (parent_id, child_id) VALUES (?1, ?2)",
        [parent_id, child_id],
    )?;
    Ok(())
}

/// How a relative being added is related to the person they are added to.
///
/// An `enum` here is like a C# enum or a TypeScript union of string literals
/// (`RelationKind` in src/types.ts). `rename_all` makes serde read
/// `"parent"` from the frontend as `Relation::Parent`.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    Parent,
    Partner,
    Child,
    Sibling,
}

/// Links `relative_id` to `anchor_id` as the given kind of relative.
/// `co_parent_id` only applies to a child: the child's other parent.
pub fn link_relative(
    conn: &mut Connection,
    anchor_id: &str,
    relation: Relation,
    relative_id: &str,
    co_parent_id: Option<&str>,
) -> AnyResult<()> {
    let tx = conn.transaction()?;
    let anchor_parents = strings(&tx, "SELECT parent_id FROM parent_child WHERE child_id = ?1", [anchor_id])?;

    match relation {
        Relation::Partner => add_partnership(&tx, anchor_id, relative_id)?,
        Relation::Parent => {
            if anchor_parents.len() >= MAX_PARENTS {
                return Err("This person already has two parents.".into());
            }
            add_parent_link(&tx, relative_id, anchor_id)?;
            // Two parents of the same child are drawn (and stored) as a couple.
            for existing in &anchor_parents {
                add_partnership(&tx, existing, relative_id)?;
            }
        }
        Relation::Child => {
            add_parent_link(&tx, anchor_id, relative_id)?;
            if let Some(co_parent) = co_parent_id {
                add_parent_link(&tx, co_parent, relative_id)?;
            }
        }
        Relation::Sibling => {
            for parent in &anchor_parents {
                add_parent_link(&tx, parent, relative_id)?;
            }
        }
    }

    tx.commit()?;
    Ok(())
}

pub fn remove_partnership(conn: &Connection, a: &str, b: &str) -> rusqlite::Result<()> {
    let (first, second) = if a < b { (a, b) } else { (b, a) };
    conn.execute(
        "DELETE FROM partnership WHERE person_a_id = ?1 AND person_b_id = ?2",
        [first, second],
    )?;
    Ok(())
}

pub fn remove_parent_link(conn: &Connection, parent_id: &str, child_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM parent_child WHERE parent_id = ?1 AND child_id = ?2",
        [parent_id, child_id],
    )?;
    Ok(())
}

// ---- major events ----------------------------------------------------------

// Who is in an event is recorded in event_participant. The person_id columns on
// event and media are leftovers that cannot be dropped; each must point at some
// current participant, because deleting the person it points at cascades.
// `remove_event_person_rows` keeps that true.

const EVENTS_OF_PERSON: &str = "SELECT event_id FROM event_participant WHERE person_id = ?1";

/// The editable fields of an event (`EventFields` in src/types.ts).
#[derive(Deserialize)]
pub struct EventFields {
    pub title: String,
    pub event_date: String,
    pub description: String,
}

/// The events the person is part of, whether theirs alone or shared.
pub fn list_events(conn: &Connection, person_id: &str) -> rusqlite::Result<Vec<Row>> {
    // `format!` builds a string, like `$"..."` in C#. Only the fixed subquery
    // above is spliced in; the person's id is still bound as `?1`.
    query(
        conn,
        &format!(
            "SELECT id, title, event_date, description FROM event
             WHERE id IN ({EVENTS_OF_PERSON}) ORDER BY created_at, id"
        ),
        [person_id],
    )
}

/// Every membership row of the person's events, so the page can show who each one is shared with.
pub fn list_event_links(conn: &Connection, person_id: &str) -> rusqlite::Result<Vec<Row>> {
    query(
        conn,
        &format!("SELECT * FROM event_participant WHERE event_id IN ({EVENTS_OF_PERSON})"),
        [person_id],
    )
}

/// Adds an empty event to the person and returns its id.
pub fn create_event(conn: &mut Connection, person_id: &str) -> rusqlite::Result<String> {
    let tx = conn.transaction()?;
    let id = new_id();
    tx.execute("INSERT INTO event (id, person_id) VALUES (?1, ?2)", [&id, person_id])?;
    tx.execute("INSERT INTO event_participant (event_id, person_id) VALUES (?1, ?2)", [&id, person_id])?;
    tx.commit()?;
    Ok(id)
}

/// Shares the event with another person, so it appears on their page too.
pub fn add_event_person(conn: &Connection, event_id: &str, person_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO event_participant (event_id, person_id) VALUES (?1, ?2)",
        [event_id, person_id],
    )?;
    Ok(())
}

/// Takes the event off one person's page. It stays for everyone else it is
/// shared with; if there is nobody else, the event is deleted along with its
/// photos. Returns the files that are no longer used.
pub fn remove_event_person(conn: &mut Connection, event_id: &str, person_id: &str) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let files = remove_event_person_rows(&tx, event_id, person_id)?;
    tx.commit()?;
    Ok(files)
}

/// The work of [`remove_event_person`], for a caller that is already inside a transaction.
fn remove_event_person_rows(conn: &Connection, event_id: &str, person_id: &str) -> rusqlite::Result<Vec<String>> {
    // `optional()` turns "the query found no row" from an error into `None`.
    let heir: Option<String> = conn
        .query_row(
            "SELECT person_id FROM event_participant WHERE event_id = ?1 AND person_id <> ?2 LIMIT 1",
            [event_id, person_id],
            |row| row.get(0),
        )
        .optional()?;

    // `let ... else` unwraps the `Option`, or runs the `else` block (which
    // must leave the function) when it is `None`.
    // https://doc.rust-lang.org/rust-by-example/flow_control/let_else.html
    let Some(heir) = heir else {
        return delete_event_rows(conn, event_id);
    };

    // Hand anything recorded against the leaving person to someone who is staying.
    conn.execute(
        "UPDATE event SET person_id = ?3 WHERE id = ?1 AND person_id = ?2",
        [event_id, person_id, &heir],
    )?;
    conn.execute(
        "UPDATE media SET person_id = ?3 WHERE event_id = ?1 AND person_id = ?2",
        [event_id, person_id, &heir],
    )?;
    conn.execute(
        "DELETE FROM event_participant WHERE event_id = ?1 AND person_id = ?2",
        [event_id, person_id],
    )?;
    Ok(Vec::new())
}

pub fn update_event(conn: &Connection, id: &str, fields: &EventFields) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE event SET title = ?2, event_date = ?3, description = ?4 WHERE id = ?1",
        params![id, fields.title, fields.event_date, fields.description],
    )?;
    Ok(())
}

/// Removes the event for everyone, along with its photos and their recordings.
/// Returns the files that are no longer used.
pub fn delete_event(conn: &mut Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let files = delete_event_rows(&tx, id)?;
    tx.commit()?;
    Ok(files)
}

fn delete_event_rows(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let mut files = Vec::new();
    for media_id in strings(conn, "SELECT id FROM media WHERE event_id = ?1", [id])? {
        files.extend(delete_media_rows(conn, &media_id)?);
    }
    conn.execute("DELETE FROM event_participant WHERE event_id = ?1", [id])?;
    conn.execute("DELETE FROM event WHERE id = ?1", [id])?;
    Ok(files)
}

// ---- photos ----------------------------------------------------------------

/// One photo's row, or `None` if there is no photo with that id. `None`
/// reaches the frontend as `null`.
pub fn get_media(conn: &Connection, id: &str) -> rusqlite::Result<Option<Row>> {
    // `pop` takes the last element out of the list: the only one, or none.
    Ok(query(conn, "SELECT * FROM media WHERE id = ?1", [id])?.pop())
}

/// The photos in all of the person's events, including ones added from another person's page.
pub fn list_media(conn: &Connection, person_id: &str) -> rusqlite::Result<Vec<Row>> {
    query(
        conn,
        &format!("SELECT * FROM media WHERE event_id IN ({EVENTS_OF_PERSON}) ORDER BY created_at, id"),
        [person_id],
    )
}

/// Records a photo already copied into the media folder, and returns its id.
pub fn add_media(conn: &Connection, person_id: &str, event_id: &str, file_name: &str) -> rusqlite::Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO media (id, person_id, event_id, file_name) VALUES (?1, ?2, ?3, ?4)",
        [&id, person_id, event_id, file_name],
    )?;
    Ok(id)
}

/// Points a photo's row at a different file in the media folder, and returns
/// the name of the file it used before. Fails if there is no such photo.
pub fn replace_media_file(conn: &mut Connection, id: &str, file_name: &str) -> AnyResult<String> {
    let tx = conn.transaction()?;
    let old: Option<String> = tx
        .query_row("SELECT file_name FROM media WHERE id = ?1", [id], |row| row.get(0))
        .optional()?;
    let old = old.ok_or("This photo is no longer in the tree.")?;
    tx.execute("UPDATE media SET file_name = ?2 WHERE id = ?1", [id, file_name])?;
    tx.commit()?;
    Ok(old)
}

/// The file a photo is stored in, or `None` if there is no photo with that id.
pub fn media_file(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT file_name FROM media WHERE id = ?1", [id], |row| row.get(0))
        .optional()
}

pub fn update_caption(conn: &Connection, media_id: &str, caption: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE media SET caption = ?2 WHERE id = ?1", [media_id, caption])?;
    Ok(())
}

pub fn update_description(conn: &Connection, media_id: &str, description: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE media SET description = ?2 WHERE id = ?1", [media_id, description])?;
    Ok(())
}

/// Chooses the person's portrait photo, or clears it with `None`.
pub fn set_portrait(conn: &Connection, person_id: &str, media_id: Option<&str>) -> rusqlite::Result<()> {
    // `params!` because the two values have different types (`&str` and
    // `Option<&str>`); a `None` is stored as NULL.
    conn.execute(
        "UPDATE person SET portrait_media_id = ?2 WHERE id = ?1",
        params![person_id, media_id],
    )?;
    Ok(())
}

/// Removes the photo and the recordings attached to it. Returns the files that
/// are no longer used.
pub fn delete_media(conn: &mut Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let files = delete_media_rows(&tx, id)?;
    tx.commit()?;
    Ok(files)
}

fn delete_media_rows(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let files = strings(
        conn,
        "SELECT file_name FROM media WHERE id = ?1
         UNION ALL
         SELECT file_name FROM audio WHERE media_id = ?1",
        [id],
    )?;
    conn.execute("UPDATE person SET portrait_media_id = NULL WHERE portrait_media_id = ?1", [id])?;
    conn.execute("DELETE FROM audio WHERE media_id = ?1", [id])?;
    conn.execute("DELETE FROM media WHERE id = ?1", [id])?;
    Ok(files)
}

// ---- recordings ------------------------------------------------------------

pub fn list_recordings(conn: &Connection, media_id: &str) -> rusqlite::Result<Vec<Row>> {
    query(conn, "SELECT * FROM audio WHERE media_id = ?1 ORDER BY created_at, id", [media_id])
}

/// Attaches a recording already in the media folder to a photo.
pub fn add_recording(conn: &Connection, media_id: &str, file_name: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO audio (id, media_id, file_name, title) VALUES (?1, ?2, ?3, ?4)",
        [&new_id(), media_id, file_name, title],
    )?;
    Ok(())
}

pub fn update_recording_title(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE audio SET title = ?2 WHERE id = ?1", [id, title])?;
    Ok(())
}

/// Removes a recording's row and returns its file, if the recording existed.
pub fn delete_recording(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    // `DELETE ... RETURNING` hands back the deleted row, so finding the file
    // name and deleting the row is one statement.
    strings(conn, "DELETE FROM audio WHERE id = ?1 RETURNING file_name", [id])
}

/// Unit tests live beside the code they test. `#[cfg(test)]` compiles this
/// module only for `cargo test`, so none of it ends up in the app.
/// https://doc.rust-lang.org/book/ch11-01-writing-tests.html
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh, fully migrated database that lives in memory and vanishes
    /// when the test ends.
    pub(crate) fn memory_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&mut conn).unwrap();
        conn
    }

    pub(crate) fn person(conn: &Connection, given_name: &str) -> String {
        let fields = PersonFields {
            given_name: given_name.into(),
            family_name: String::new(),
            sex: "unknown".into(),
            birth_date: String::new(),
            birth_place: String::new(),
            death_date: String::new(),
            death_place: String::new(),
            biography: String::new(),
        };
        create_person(conn, &fields).unwrap()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_new_database_gets_every_migration() {
        let conn = memory_db();
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, schema_version());
        assert!(table_exists(&conn, "event_participant").unwrap());
    }

    #[test]
    fn a_database_from_the_sql_plugin_is_adopted_without_rerunning_migrations() {
        // Build what the plugin left behind: the first two migrations applied
        // and recorded in its own table, with `user_version` still 0.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(MIGRATIONS[1]).unwrap();
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN NOT NULL);
             INSERT INTO _sqlx_migrations VALUES (1, 1), (2, 1);
             INSERT INTO person (id, given_name) VALUES ('p1', 'Ada');",
        )
        .unwrap();

        // Running migration 1 again would fail ("table person already exists"),
        // so success shows that only the missing ones ran.
        migrate(&mut conn).unwrap();

        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, schema_version());
        assert_eq!(count(&conn, "person"), 1);
        assert!(table_exists(&conn, "event_participant").unwrap());
    }

    #[test]
    fn a_database_from_a_newer_app_is_refused() {
        let mut conn = memory_db();
        conn.pragma_update(None, "user_version", schema_version() + 1).unwrap();
        assert_eq!(migrate(&mut conn).unwrap_err().to_string(), NEWER_DATABASE);
    }

    #[test]
    fn adding_a_second_parent_pairs_the_parents_and_a_third_is_refused() {
        let mut conn = memory_db();
        let child = person(&conn, "Child");
        let (mother, father, extra) = (person(&conn, "Mother"), person(&conn, "Father"), person(&conn, "Extra"));

        link_relative(&mut conn, &child, Relation::Parent, &mother, None).unwrap();
        link_relative(&mut conn, &child, Relation::Parent, &father, None).unwrap();
        assert_eq!(count(&conn, "parent_child"), 2);
        assert_eq!(count(&conn, "partnership"), 1);

        assert!(link_relative(&mut conn, &child, Relation::Parent, &extra, None).is_err());
        assert_eq!(count(&conn, "parent_child"), 2);
    }

    #[test]
    fn deleting_a_person_keeps_shared_events_and_removes_their_own() {
        let mut conn = memory_db();
        let (ada, ben) = (person(&conn, "Ada"), person(&conn, "Ben"));

        // Ada's own event with a photo and a recording on it.
        let own = create_event(&mut conn, &ada).unwrap();
        let own_photo = add_media(&conn, &ada, &own, "own.jpg").unwrap();
        add_recording(&conn, &own_photo, "own.mp3", "").unwrap();

        // An event Ada started and then shared with Ben, with a photo.
        let shared = create_event(&mut conn, &ada).unwrap();
        add_event_person(&conn, &shared, &ben).unwrap();
        add_media(&conn, &ada, &shared, "shared.jpg").unwrap();

        let mut files = delete_person(&mut conn, &ada).unwrap();
        files.sort();
        assert_eq!(files, ["own.jpg", "own.mp3"]);

        // The shared event and its photo now belong to Ben alone.
        assert_eq!(count(&conn, "person"), 1);
        assert_eq!(list_events(&conn, &ben).unwrap().len(), 1);
        let photos = list_media(&conn, &ben).unwrap();
        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0]["file_name"], "shared.jpg");
        assert_eq!(photos[0]["person_id"], ben.as_str());
        assert_eq!(count(&conn, "audio"), 0);
    }

    #[test]
    fn deleting_a_photo_clears_the_portrait_that_used_it() {
        let mut conn = memory_db();
        let ada = person(&conn, "Ada");
        let event = create_event(&mut conn, &ada).unwrap();
        let photo = add_media(&conn, &ada, &event, "a.jpg").unwrap();
        set_portrait(&conn, &ada, Some(&photo)).unwrap();

        assert_eq!(delete_media(&mut conn, &photo).unwrap(), ["a.jpg"]);

        let tree = load_tree(&conn).unwrap();
        assert_eq!(tree.people[0]["portrait_media_id"], Value::Null);
        assert_eq!(get_media(&conn, &photo).unwrap(), None);
    }

    #[test]
    fn replacing_a_photos_file_returns_the_old_one() {
        let mut conn = memory_db();
        let ada = person(&conn, "Ada");
        let event = create_event(&mut conn, &ada).unwrap();
        let photo = add_media(&conn, &ada, &event, "old.jpg").unwrap();

        assert_eq!(replace_media_file(&mut conn, &photo, "new.jpg").unwrap(), "old.jpg");
        assert_eq!(media_file(&conn, &photo).unwrap().as_deref(), Some("new.jpg"));
        assert!(replace_media_file(&mut conn, "no-such-photo", "x.jpg").is_err());
    }
}
