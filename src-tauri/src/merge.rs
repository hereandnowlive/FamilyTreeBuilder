//! Merging a family file into the current tree: reading both trees for
//! comparison, and carrying out the plan the user approved.
//!
//! The planning itself is in TypeScript (src/merge/plan.ts). It compares the
//! two snapshots from [`snapshot`] and produces a plan, which comes back here
//! to be applied by [`apply`] in a single transaction: a merge either happens
//! completely or leaves the tree exactly as it was.
//!
//! Like `db.rs`, nothing in here knows about Tauri.

use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;

use crate::db::{self, Row};
use crate::family_file::AnyResult;

/// Every table, in an order that satisfies their foreign keys when rows are
/// inserted. Must match INSERT_ORDER in src/merge/plan.ts.
const TABLES: [&str; 8] = [
    "person",
    "document",
    "event",
    "event_participant",
    "media",
    "audio",
    "partnership",
    "parent_child",
];

/// The tables whose rows have an `id` column and fields a user can edit.
const RECORD_TABLES: [&str; 5] = ["person", "document", "event", "media", "audio"];

/// Every row of every table, by table name (`Snapshot` in plan.ts).
///
/// `&'static str` is a string that lives for the whole run of the program,
/// which the table names above do because they are written into it.
/// https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html#the-static-lifetime
pub type Snapshot = HashMap<&'static str, Vec<Row>>;

/// Reads a whole tree for the planner.
pub fn snapshot(conn: &Connection) -> rusqlite::Result<Snapshot> {
    let mut tables = Snapshot::new();
    for table in TABLES {
        tables.insert(table, db::query(conn, &format!("SELECT * FROM {table}"), [])?);
    }
    Ok(tables)
}

/// The parts of a `MergePlan` from plan.ts that are needed to carry it out.
/// Fields of the plan that are only for display are not listed, and serde
/// skips them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Rows that exist only in the file, by table name.
    inserts: HashMap<String, Vec<Row>>,
    /// Blank fields in the current tree that the file has a value for.
    fills: Vec<Update>,
    conflicts: Vec<RecordConflict>,
    parent_conflicts: Vec<ParentConflict>,
    /// Photo and recording files to copy in for the inserted rows.
    pub files: Vec<String>,
}

#[derive(Deserialize)]
struct Update {
    table: String,
    id: String,
    set: Row,
}

/// The same record was changed differently on each side.
#[derive(Deserialize)]
struct RecordConflict {
    key: String,
    table: String,
    id: String,
    /// The columns to overwrite, with the file's values, if the user chose the file's side.
    theirs: Row,
}

/// Combining both sides' parents would give someone more than two.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentConflict {
    key: String,
    child_id: String,
    /// The parent ids to end up with if the user chose the file's side.
    their_parent_ids: Vec<String>,
}

/// Which side the user chose for a conflict (`Choice` in plan.ts).
///
/// `PartialEq` lets two values be compared with `==`, which an enum cannot do
/// unless it is derived.
#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Mine,
    Theirs,
}

/// Carries out a merge plan. `choices` holds the user's decision for every
/// conflict, by its key.
pub fn apply(conn: &mut Connection, plan: &Plan, choices: &HashMap<String, Choice>) -> AnyResult<()> {
    let tx = conn.transaction()?;
    let chose_theirs = |key: &String| choices.get(key) == Some(&Choice::Theirs);

    for table in TABLES {
        // A table the plan has no rows for is simply absent from the map.
        for row in plan.inserts.get(table).into_iter().flatten() {
            insert_row(&tx, table, row)?;
        }
    }
    for fill in &plan.fills {
        update_row(&tx, &fill.table, &fill.id, &fill.set)?;
    }
    for conflict in &plan.conflicts {
        if chose_theirs(&conflict.key) {
            update_row(&tx, &conflict.table, &conflict.id, &conflict.theirs)?;
        }
    }
    for conflict in &plan.parent_conflicts {
        if !chose_theirs(&conflict.key) {
            continue;
        }
        tx.execute("DELETE FROM parent_child WHERE child_id = ?1", [&conflict.child_id])?;
        for parent_id in &conflict.their_parent_ids {
            db::add_parent_link(&tx, parent_id, &conflict.child_id)?;
        }
    }

    // Two parents of one child are always stored as a couple; the merge can create new such pairs.
    let pairs = db::query(
        &tx,
        "SELECT x.parent_id AS a, y.parent_id AS b FROM parent_child x
         JOIN parent_child y ON y.child_id = x.child_id AND x.parent_id < y.parent_id",
        [],
    )?;
    for pair in &pairs {
        // `as_str` returns `Some` only for a JSON string, which these always are.
        if let (Some(a), Some(b)) = (pair["a"].as_str(), pair["b"].as_str()) {
            db::add_partnership(&tx, a, b)?;
        }
    }

    // Reaching here means every step worked. Any `?` above returns early
    // instead, and the transaction is rolled back as it goes out of scope.
    tx.commit()?;
    Ok(())
}

/// The names of the row's columns, after checking that each one really is a
/// column of `table`.
///
/// Values can be bound to `?` placeholders but table and column names cannot;
/// they have to be written into the SQL text. These names arrive from the
/// frontend, so they are only used once the database has confirmed them.
///
/// The `'a` is a lifetime: it tells the compiler the returned names are
/// borrowed from `row`, so `row` must stay alive while they are in use.
/// https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html
fn checked_columns<'a>(conn: &Connection, table: &str, allowed: &[&str], row: &'a Row) -> AnyResult<Vec<&'a str>> {
    if !allowed.contains(&table) {
        return Err(format!("The merge plan names a table that cannot be merged: {table}.").into());
    }
    let known: HashSet<String> = db::query(conn, "SELECT name FROM pragma_table_info(?1)", [table])?
        .iter()
        .filter_map(|column| column["name"].as_str().map(str::to_owned))
        .collect();

    let columns: Vec<&str> = row.keys().map(String::as_str).collect();
    if let Some(unknown) = columns.iter().find(|column| !known.contains(**column)) {
        return Err(format!("The merge plan names a column that {table} does not have: {unknown}.").into());
    }
    Ok(columns)
}

/// Adds one row from the file. A row that is somehow already there is left as it is.
fn insert_row(conn: &Connection, table: &str, row: &Row) -> AnyResult<()> {
    let columns = checked_columns(conn, table, &TABLES, row)?;
    // "?1, ?2, ?3", one placeholder per column.
    let placeholders: Vec<String> = (1..=columns.len()).map(|n| format!("?{n}")).collect();
    // `collect` can gather `Result`s into one `Result` holding the whole list,
    // stopping at the first error.
    let values = row.values().map(db::from_json).collect::<AnyResult<Vec<_>>>()?;

    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO {table} ({}) VALUES ({})",
            columns.join(", "),
            placeholders.join(", ")
        ),
        params_from_iter(values),
    )?;
    Ok(())
}

/// Overwrites the given columns of one record.
fn update_row(conn: &Connection, table: &str, id: &str, set: &Row) -> AnyResult<()> {
    let columns = checked_columns(conn, table, &RECORD_TABLES, set)?;
    // "name = ?2, title = ?3": ?1 is the id.
    let assignments: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{column} = ?{}", index + 2))
        .collect();

    let mut values = vec![rusqlite::types::Value::Text(id.to_owned())];
    for value in set.values() {
        values.push(db::from_json(value)?);
    }

    conn.execute(
        &format!("UPDATE {table} SET {} WHERE id = ?1", assignments.join(", ")),
        params_from_iter(values),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::{memory_db, person};
    use serde_json::json;

    /// Builds a plan the way it arrives from the frontend: as JSON.
    fn plan(value: serde_json::Value) -> Plan {
        serde_json::from_value(value).unwrap()
    }

    fn names(conn: &Connection) -> Vec<String> {
        let mut names: Vec<String> = db::query(conn, "SELECT given_name FROM person", [])
            .unwrap()
            .iter()
            .map(|row| row["given_name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn applies_inserts_fills_and_the_chosen_side_of_conflicts() {
        let mut conn = memory_db();
        let ada = person(&conn, "Ada");
        let ben = person(&conn, "Ben");

        let plan = plan(json!({
            "inserts": {
                "person": [{ "id": "new-1", "given_name": "Cy" }, { "id": "new-2", "given_name": "Di" }],
                "parent_child": [
                    { "parent_id": "new-1", "child_id": ada },
                    { "parent_id": "new-2", "child_id": ada },
                ],
            },
            "fills": [{ "table": "person", "id": ada, "set": { "birth_place": "Leeds" } }],
            "conflicts": [
                { "key": "person:ada", "table": "person", "id": ada, "theirs": { "family_name": "Theirs" } },
                { "key": "person:ben", "table": "person", "id": ben, "theirs": { "family_name": "Theirs" } },
            ],
            "parentConflicts": [],
            "files": [],
            "possibleDuplicates": [],
            "skippedLinks": 0,
        }));
        let choices = HashMap::from([
            ("person:ada".to_owned(), Choice::Theirs),
            ("person:ben".to_owned(), Choice::Mine),
        ]);

        apply(&mut conn, &plan, &choices).unwrap();

        assert_eq!(names(&conn), ["Ada", "Ben", "Cy", "Di"]);
        let people = db::query(&conn, "SELECT * FROM person WHERE id IN (?1, ?2) ORDER BY given_name", [&ada, &ben]).unwrap();
        assert_eq!(people[0]["birth_place"], "Leeds");
        assert_eq!(people[0]["family_name"], "Theirs");
        assert_eq!(people[1]["family_name"], "");
        // Ada's two new parents were recorded as a couple.
        let couples = db::query(&conn, "SELECT * FROM partnership", []).unwrap();
        assert_eq!(couples.len(), 1);
    }

    #[test]
    fn choosing_the_files_parents_replaces_the_existing_ones() {
        let mut conn = memory_db();
        let child = person(&conn, "Child");
        let (old, new_a, new_b) = (person(&conn, "Old"), person(&conn, "NewA"), person(&conn, "NewB"));
        db::add_parent_link(&conn, &old, &child).unwrap();

        let plan = plan(json!({
            "inserts": {},
            "fills": [],
            "conflicts": [],
            "parentConflicts": [{ "key": "parents:c", "childId": child, "theirParentIds": [new_a, new_b] }],
            "files": [],
        }));
        apply(&mut conn, &plan, &HashMap::from([("parents:c".to_owned(), Choice::Theirs)])).unwrap();

        let mut parents: Vec<String> = db::query(&conn, "SELECT parent_id FROM parent_child", [])
            .unwrap()
            .iter()
            .map(|row| row["parent_id"].as_str().unwrap().to_owned())
            .collect();
        parents.sort();
        let mut expected = vec![new_a, new_b];
        expected.sort();
        assert_eq!(parents, expected);
    }

    #[test]
    fn a_merge_that_fails_partway_changes_nothing() {
        let mut conn = memory_db();
        person(&conn, "Ada");

        // The first insert is fine; the second names a column that does not exist.
        let plan = plan(json!({
            "inserts": { "person": [{ "id": "new-1", "given_name": "Cy" }, { "id": "new-2", "nonsense": "x" }] },
            "fills": [],
            "conflicts": [],
            "parentConflicts": [],
            "files": [],
        }));

        assert!(apply(&mut conn, &plan, &HashMap::new()).is_err());
        assert_eq!(names(&conn), ["Ada"]);
    }

    #[test]
    fn refuses_names_that_are_not_real_tables_or_columns() {
        let mut conn = memory_db();
        let ada = person(&conn, "Ada");

        let bad_table = plan(json!({
            "inserts": {}, "conflicts": [], "parentConflicts": [], "files": [],
            "fills": [{ "table": "sqlite_master", "id": "x", "set": { "name": "y" } }],
        }));
        assert!(apply(&mut conn, &bad_table, &HashMap::new()).is_err());

        let bad_column = plan(json!({
            "inserts": {}, "conflicts": [], "parentConflicts": [], "files": [],
            "fills": [{ "table": "person", "id": ada, "set": { "given_name = 'x' --": "y" } }],
        }));
        assert!(apply(&mut conn, &bad_column, &HashMap::new()).is_err());
        assert_eq!(names(&conn), ["Ada"]);
    }

    #[test]
    fn a_snapshot_has_every_table() {
        let conn = memory_db();
        person(&conn, "Ada");
        let snapshot = snapshot(&conn).unwrap();
        assert_eq!(snapshot.len(), TABLES.len());
        assert_eq!(snapshot["person"].len(), 1);
    }
}
