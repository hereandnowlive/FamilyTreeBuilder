import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { sep } from "@tauri-apps/api/path";
import Database from "@tauri-apps/plugin-sql";
import { INSERT_ORDER, type Choice, type MergePlan, type Row, type Snapshot } from "./merge/plan";
import { MAX_PARENTS, type TreeIndex } from "./relations";
import type {
  EventFields,
  EventLink,
  LifeEvent,
  Media,
  ParentLink,
  Partnership,
  Person,
  PersonFields,
  Recording,
  RelationKind,
  TreeData,
} from "./types";

// Must match DB_URL in src-tauri/src/lib.rs, where the migrations are registered.
const DB_URL = "sqlite:familytree.db";
// The tree from a family file that is being merged in. Must match MERGE_DB_URL in lib.rs.
const MERGE_DB_URL = "sqlite:merge-incoming.db";

let connection: Promise<Database> | null = null;
const db = () => (connection ??= Database.load(DB_URL));

const PERSON_SELECT = `
  SELECT p.*, m.file_name AS portrait_file
  FROM person p
  LEFT JOIN media m ON m.id = p.portrait_media_id`;

const PERSON_COLUMNS = [
  "given_name",
  "family_name",
  "sex",
  "birth_date",
  "birth_place",
  "death_date",
  "death_place",
  "biography",
] as const satisfies readonly (keyof PersonFields)[];

// ---- media files -----------------------------------------------------------

let mediaDir = "";
let thumbDir = "";
let storage: Promise<void> | null = null;

/**
 * Call at startup, before anything touches the database or renders a photo.
 * Repeat calls share one run, so a family file staged before the restart is swapped in exactly once.
 */
export function initStorage(): Promise<void> {
  return (storage ??= (async () => {
    await invoke("apply_pending_open");
    mediaDir = await invoke<string>("get_media_dir");
    thumbDir = await invoke<string>("get_thumbs_dir");
  })());
}

/**
 * URL the webview can load for a file stored in the app's media folder, at full size.
 * For anything smaller than a full-page view, use the Thumbnail component instead.
 */
export function mediaUrl(fileName: string): string {
  return convertFileSrc(mediaDir + sep() + fileName);
}

// ---- thumbnails ------------------------------------------------------------

// Each one decodes a full-size photo in Rust, so only a few are made at a time.
const THUMBNAIL_WORKERS = 3;
let thumbnailsRunning = 0;
const thumbnailQueue: (() => void)[] = [];

const thumbnailJobs = new Map<string, Promise<string>>();
const thumbnailUrls = new Map<string, string>();

async function makeThumbnail(fileName: string): Promise<string> {
  if (thumbnailsRunning < THUMBNAIL_WORKERS) thumbnailsRunning++;
  // Otherwise wait in line; whoever finishes hands their slot straight to us.
  else await new Promise<void>((resolve) => thumbnailQueue.push(resolve));
  try {
    await invoke("ensure_thumbnail", { fileName });
    return convertFileSrc(thumbDir + sep() + fileName + ".jpg");
  } catch {
    // A format the Rust side cannot decode: fall back to the full image.
    return mediaUrl(fileName);
  } finally {
    const next = thumbnailQueue.shift();
    if (next) next();
    else thumbnailsRunning--;
  }
}

/** URL of the small preview of a stored photo, creating the preview first if it does not exist yet. */
export function thumbnailUrl(fileName: string): Promise<string> {
  let job = thumbnailJobs.get(fileName);
  if (!job) {
    job = makeThumbnail(fileName).then((url) => {
      thumbnailUrls.set(fileName, url);
      return url;
    });
    thumbnailJobs.set(fileName, job);
  }
  return job;
}

/** The preview URL if it is already known this session, so a remounted image can show at once. */
export function cachedThumbnailUrl(fileName: string): string | undefined {
  return thumbnailUrls.get(fileName);
}

// ---- tree ------------------------------------------------------------------

export async function loadTree(): Promise<TreeData> {
  const d = await db();
  const [people, partnerships, parentLinks] = await Promise.all([
    d.select<Person[]>(`${PERSON_SELECT} ORDER BY p.created_at, p.id`),
    d.select<Partnership[]>("SELECT * FROM partnership"),
    d.select<ParentLink[]>("SELECT * FROM parent_child"),
  ]);
  return { people, partnerships, parentLinks };
}

// ---- people ----------------------------------------------------------------

export async function createPerson(fields: PersonFields): Promise<string> {
  const id = crypto.randomUUID();
  const placeholders = PERSON_COLUMNS.map((_, i) => `$${i + 2}`).join(", ");
  await (await db()).execute(
    `INSERT INTO person (id, ${PERSON_COLUMNS.join(", ")}) VALUES ($1, ${placeholders})`,
    [id, ...PERSON_COLUMNS.map((column) => fields[column])],
  );
  return id;
}

export async function updatePerson(id: string, fields: PersonFields): Promise<void> {
  const assignments = PERSON_COLUMNS.map((column, i) => `${column} = $${i + 2}`).join(", ");
  await (await db()).execute(`UPDATE person SET ${assignments} WHERE id = $1`, [
    id,
    ...PERSON_COLUMNS.map((column) => fields[column]),
  ]);
}

/**
 * Removes the person and every link to them. Events they shared with someone else are kept for
 * the others; events that were theirs alone go too, with their photos and recordings.
 */
export async function deletePerson(id: string): Promise<void> {
  const d = await db();
  const links = await d.select<EventLink[]>("SELECT * FROM event_participant WHERE person_id = $1", [id]);
  for (const link of links) await removeEventPerson(link.event_id, id);

  // Nothing should still belong to the person by now; this sweeps up anything that does.
  const ownMedia = "SELECT id FROM media WHERE person_id = $1";
  const files = await d.select<{ file_name: string }[]>(
    `SELECT file_name FROM media WHERE person_id = $1
     UNION ALL SELECT file_name FROM audio WHERE media_id IN (${ownMedia})`,
    [id],
  );
  await d.execute(`DELETE FROM audio WHERE media_id IN (${ownMedia})`, [id]);
  await d.execute("DELETE FROM media WHERE person_id = $1", [id]);
  await d.execute("DELETE FROM event WHERE person_id = $1", [id]);
  await d.execute("DELETE FROM parent_child WHERE parent_id = $1 OR child_id = $1", [id]);
  await d.execute("DELETE FROM partnership WHERE person_a_id = $1 OR person_b_id = $1", [id]);
  await d.execute("DELETE FROM person WHERE id = $1", [id]);
  await Promise.all(files.map(deleteMediaFile));
}

// ---- relationships ---------------------------------------------------------

async function addPartnership(a: string, b: string): Promise<void> {
  const [first, second] = a < b ? [a, b] : [b, a];
  await (await db()).execute(
    "INSERT OR IGNORE INTO partnership (id, person_a_id, person_b_id) VALUES ($1, $2, $3)",
    [crypto.randomUUID(), first, second],
  );
}

async function addParentLink(parentId: string, childId: string): Promise<void> {
  await (await db()).execute(
    "INSERT OR IGNORE INTO parent_child (parent_id, child_id) VALUES ($1, $2)",
    [parentId, childId],
  );
}

/**
 * Links `relativeId` to `anchorId` as the given kind of relative.
 * `coParentId` only applies to "child": the child's other parent.
 */
export async function linkRelative(
  index: TreeIndex,
  anchorId: string,
  kind: RelationKind,
  relativeId: string,
  coParentId?: string,
): Promise<void> {
  const anchorParents = index.parentsOf.get(anchorId) ?? [];
  switch (kind) {
    case "partner":
      await addPartnership(anchorId, relativeId);
      break;
    case "parent":
      if (anchorParents.length >= MAX_PARENTS) throw new Error("This person already has two parents.");
      await addParentLink(relativeId, anchorId);
      // Two parents of the same child are drawn (and stored) as a couple.
      for (const existing of anchorParents) await addPartnership(existing, relativeId);
      break;
    case "child":
      await addParentLink(anchorId, relativeId);
      if (coParentId) await addParentLink(coParentId, relativeId);
      break;
    case "sibling":
      for (const parent of anchorParents) await addParentLink(parent, relativeId);
      break;
  }
}

export async function removePartnership(a: string, b: string): Promise<void> {
  const [first, second] = a < b ? [a, b] : [b, a];
  await (await db()).execute(
    "DELETE FROM partnership WHERE person_a_id = $1 AND person_b_id = $2",
    [first, second],
  );
}

export async function removeParentLink(parentId: string, childId: string): Promise<void> {
  await (await db()).execute(
    "DELETE FROM parent_child WHERE parent_id = $1 AND child_id = $2",
    [parentId, childId],
  );
}

// ---- major events ----------------------------------------------------------

// Who is in an event is recorded in event_participant. The person_id columns on event and media
// are leftovers that cannot be dropped; each must point at some current participant, because
// deleting the person it points at cascades. removeEventPerson() keeps that true.

const EVENTS_OF_PERSON = "SELECT event_id FROM event_participant WHERE person_id = $1";

/** The events the person is part of, whether theirs alone or shared. */
export async function listEvents(personId: string): Promise<LifeEvent[]> {
  return (await db()).select<LifeEvent[]>(
    `SELECT id, title, event_date, description FROM event
     WHERE id IN (${EVENTS_OF_PERSON}) ORDER BY created_at, id`,
    [personId],
  );
}

/** Every membership row of the person's events, so the page can show who each one is shared with. */
export async function listEventLinks(personId: string): Promise<EventLink[]> {
  return (await db()).select<EventLink[]>(
    `SELECT * FROM event_participant WHERE event_id IN (${EVENTS_OF_PERSON})`,
    [personId],
  );
}

export async function createEvent(personId: string): Promise<string> {
  const d = await db();
  const id = crypto.randomUUID();
  await d.execute("INSERT INTO event (id, person_id) VALUES ($1, $2)", [id, personId]);
  await d.execute("INSERT INTO event_participant (event_id, person_id) VALUES ($1, $2)", [id, personId]);
  return id;
}

/** Shares the event with another person, so it appears on their page too. */
export async function addEventPerson(eventId: string, personId: string): Promise<void> {
  await (await db()).execute(
    "INSERT OR IGNORE INTO event_participant (event_id, person_id) VALUES ($1, $2)",
    [eventId, personId],
  );
}

/**
 * Takes the event off one person's page. It stays for everyone else it is shared with;
 * if there is nobody else, the event is deleted along with its photos.
 */
export async function removeEventPerson(eventId: string, personId: string): Promise<void> {
  const d = await db();
  const others = await d.select<EventLink[]>(
    "SELECT * FROM event_participant WHERE event_id = $1 AND person_id <> $2 LIMIT 1",
    [eventId, personId],
  );
  if (others.length === 0) return deleteEvent(eventId);

  // Hand anything recorded against the leaving person to someone who is staying.
  const heir = others[0].person_id;
  await d.execute("UPDATE event SET person_id = $3 WHERE id = $1 AND person_id = $2", [eventId, personId, heir]);
  await d.execute("UPDATE media SET person_id = $3 WHERE event_id = $1 AND person_id = $2", [
    eventId,
    personId,
    heir,
  ]);
  await d.execute("DELETE FROM event_participant WHERE event_id = $1 AND person_id = $2", [eventId, personId]);
}

export async function updateEvent(id: string, fields: EventFields): Promise<void> {
  await (await db()).execute(
    "UPDATE event SET title = $2, event_date = $3, description = $4 WHERE id = $1",
    [id, fields.title, fields.event_date, fields.description],
  );
}

/** Removes the event for everyone, along with its photos and their recordings (rows and files). */
export async function deleteEvent(id: string): Promise<void> {
  const d = await db();
  const photos = await d.select<Media[]>("SELECT * FROM media WHERE event_id = $1", [id]);
  for (const photo of photos) await deleteMedia(photo);
  await d.execute("DELETE FROM event_participant WHERE event_id = $1", [id]);
  await d.execute("DELETE FROM event WHERE id = $1", [id]);
}

// ---- photos ----------------------------------------------------------------

function deleteMediaFile(file: { file_name: string }): Promise<void> {
  return invoke("delete_media_file", { fileName: file.file_name });
}

export async function getMedia(id: string): Promise<Media | undefined> {
  const rows = await (await db()).select<Media[]>("SELECT * FROM media WHERE id = $1", [id]);
  return rows[0];
}

/** The photos in all of the person's events, including ones added from another person's page. */
export async function listMedia(personId: string): Promise<Media[]> {
  return (await db()).select<Media[]>(
    `SELECT * FROM media WHERE event_id IN (${EVENTS_OF_PERSON}) ORDER BY created_at, id`,
    [personId],
  );
}

/** Copies the image at `sourcePath` into the app's media folder and adds it to the person's event. */
export async function importPhoto(personId: string, sourcePath: string, eventId: string): Promise<string> {
  const fileName = await invoke<string>("import_photo", { source: sourcePath });
  const id = crypto.randomUUID();
  await (await db()).execute(
    "INSERT INTO media (id, person_id, event_id, file_name) VALUES ($1, $2, $3, $4)",
    [id, personId, eventId, fileName],
  );
  return id;
}

export async function updateCaption(mediaId: string, caption: string): Promise<void> {
  await (await db()).execute("UPDATE media SET caption = $2 WHERE id = $1", [mediaId, caption]);
}

export async function updateDescription(mediaId: string, description: string): Promise<void> {
  await (await db()).execute("UPDATE media SET description = $2 WHERE id = $1", [mediaId, description]);
}

export async function setPortrait(personId: string, mediaId: string | null): Promise<void> {
  await (await db()).execute("UPDATE person SET portrait_media_id = $2 WHERE id = $1", [
    personId,
    mediaId,
  ]);
}

/** Removes the photo and the recordings attached to it (rows and files). */
export async function deleteMedia(media: Media): Promise<void> {
  const d = await db();
  const recordings = await listRecordings(media.id);
  await d.execute(
    "UPDATE person SET portrait_media_id = NULL WHERE portrait_media_id = $1",
    [media.id],
  );
  await d.execute("DELETE FROM audio WHERE media_id = $1", [media.id]);
  await d.execute("DELETE FROM media WHERE id = $1", [media.id]);
  await Promise.all([media, ...recordings].map(deleteMediaFile));
}

// ---- recordings ------------------------------------------------------------

export async function listRecordings(mediaId: string): Promise<Recording[]> {
  return (await db()).select<Recording[]>(
    "SELECT * FROM audio WHERE media_id = $1 ORDER BY created_at, id",
    [mediaId],
  );
}

/** Copies the audio file at `sourcePath` into the app's media folder and attaches it to the photo. */
export async function importRecording(mediaId: string, sourcePath: string): Promise<void> {
  const fileName = await invoke<string>("import_audio", { source: sourcePath });
  // Start the title off as the original file's name, without folder or extension.
  const title = (sourcePath.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
  await attachRecording(mediaId, fileName, title);
}

async function attachRecording(mediaId: string, fileName: string, title: string): Promise<void> {
  await (await db()).execute(
    "INSERT INTO audio (id, media_id, file_name, title) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), mediaId, fileName, title],
  );
}

/** Starts recording from the microphone. Fails if there is no microphone or a recording is already running. */
export function startRecording(): Promise<void> {
  return invoke("start_recording");
}

/** Loudest microphone level since the last call, from 0 to 1. */
export function recordingLevel(): Promise<number> {
  return invoke<number>("recording_level");
}

/** Stops the recording in progress and attaches it to the photo. */
export async function saveRecording(mediaId: string, title: string): Promise<void> {
  const fileName = await invoke<string | null>("stop_recording", { keep: true });
  if (fileName) await attachRecording(mediaId, fileName, title);
}

/** Stops the recording in progress and throws it away. */
export async function discardRecording(): Promise<void> {
  await invoke("stop_recording", { keep: false });
}

export async function updateRecordingTitle(id: string, title: string): Promise<void> {
  await (await db()).execute("UPDATE audio SET title = $2 WHERE id = $1", [id, title]);
}

export async function deleteRecording(recording: Recording): Promise<void> {
  await (await db()).execute("DELETE FROM audio WHERE id = $1", [recording.id]);
  await deleteMediaFile(recording);
}

// ---- family files ----------------------------------------------------------

/** Writes a consistent copy of the database where the Rust side expects to find it. */
async function snapshotDatabase(): Promise<void> {
  const snapshot = await invoke<string>("prepare_snapshot");
  await (await db()).execute("VACUUM INTO $1", [snapshot]);
}

/** Saves the whole tree, photos included, as one family file at `dest`. */
export async function saveFamilyFile(dest: string): Promise<void> {
  await snapshotDatabase();
  await invoke("write_family_file", { dest });
}

/**
 * Replaces the tree in the app with the one in the family file at `path`, then restarts the app.
 * Pass `backupStamp` to keep a copy of the current tree first; pass null when there is nothing to keep.
 */
export async function openFamilyFile(path: string, backupStamp: string | null): Promise<void> {
  // Validated and unpacked first, so a file that cannot be opened changes nothing.
  await invoke("stage_family_file", { path });
  if (backupStamp) {
    await snapshotDatabase();
    await invoke("write_backup", { reason: "open", stamp: backupStamp });
  }
  // Windows will not replace a database file that is still open.
  await (await db()).close();
  connection = null;
  await invoke("restart_into_staged", { merge: false });
}

// ---- merging a family file -------------------------------------------------
// The planning is in merge/plan.ts. The steps here: startMerge() unpacks the file and restarts,
// the merge screen calls loadMergeSnapshots() and shows the plan, then applyMerge() or just
// finishMerge() to cancel.

/** Unpacks the family file at `path` ready for merging, then restarts the app into the merge screen. */
export async function startMerge(path: string): Promise<void> {
  await invoke("stage_merge", { path });
  await (await db()).close();
  connection = null;
  await invoke("restart_into_staged", { merge: true });
}

/** Whether a family file is waiting to be merged. Call after initStorage(). */
export function pendingMerge(): Promise<boolean> {
  return invoke<boolean>("pending_merge");
}

async function readSnapshot(d: Database): Promise<Snapshot> {
  const table = (name: keyof Snapshot) => d.select<Row[]>(`SELECT * FROM ${name}`);
  const [person, event, event_participant, media, audio, partnership, parent_child] = await Promise.all(
    INSERT_ORDER.map(table),
  );
  return { person, event, event_participant, media, audio, partnership, parent_child };
}

/** Everything in the current tree and everything in the file being merged. */
export async function loadMergeSnapshots(): Promise<{ mine: Snapshot; theirs: Snapshot }> {
  // Loading the file's database also brings it up to the current schema if it is from an older version.
  const incoming = await Database.load(MERGE_DB_URL);
  try {
    return { mine: await readSnapshot(await db()), theirs: await readSnapshot(incoming) };
  } finally {
    // Closed straight away so the file can be deleted when the merge finishes.
    // The path is needed: close() with no argument closes every database, the tree's own included.
    await incoming.close(incoming.path);
  }
}

function insertRow(d: Database, table: keyof Snapshot, row: Row) {
  const columns = Object.keys(row);
  return d.execute(
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((column) => row[column]),
  );
}

function updateRow(d: Database, table: keyof Snapshot, id: string, set: Row) {
  const columns = Object.keys(set);
  return d.execute(
    `UPDATE ${table} SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(", ")} WHERE id = $1`,
    [id, ...columns.map((column) => set[column])],
  );
}

/**
 * Carries out a merge plan. `choices` holds the user's decision for every conflict, by its key.
 * A backup of the current tree is always taken first. If any conflict was settled, a copy of each
 * tree that lost out is also kept in the overrides folder, whose path is returned (null if none).
 */
export async function applyMerge(
  plan: MergePlan,
  choices: Record<string, Choice>,
  stamp: string,
): Promise<string | null> {
  const picked = Object.values(choices);
  const d = await db();

  // Everything that can fail without changing the tree comes first.
  await snapshotDatabase();
  await invoke("write_backup", { reason: "merge", stamp });
  const overridesDir =
    picked.length === 0
      ? null
      : await invoke<string>("save_overrides", {
          stamp,
          mine: picked.includes("theirs"),
          theirs: picked.includes("mine"),
        });
  await invoke("merge_import_files", { fileNames: plan.files });

  for (const table of INSERT_ORDER) {
    for (const row of plan.inserts[table]) await insertRow(d, table, row);
  }
  for (const fill of plan.fills) await updateRow(d, fill.table, fill.id, fill.set);
  for (const conflict of plan.conflicts) {
    if (choices[conflict.key] === "theirs") await updateRow(d, conflict.table, conflict.id, conflict.theirs);
  }
  for (const conflict of plan.parentConflicts) {
    if (choices[conflict.key] !== "theirs") continue;
    await d.execute("DELETE FROM parent_child WHERE child_id = $1", [conflict.childId]);
    for (const parentId of conflict.theirParentIds) await addParentLink(parentId, conflict.childId);
  }

  // Two parents of one child are always stored as a couple; the merge can create new such pairs.
  const pairs = await d.select<{ a: string; b: string }[]>(
    `SELECT x.parent_id AS a, y.parent_id AS b FROM parent_child x
     JOIN parent_child y ON y.child_id = x.child_id AND x.parent_id < y.parent_id`,
  );
  for (const { a, b } of pairs) await addPartnership(a, b);

  return overridesDir;
}

/** Clears away the file being merged, after applyMerge() or to cancel. */
export function finishMerge(): Promise<void> {
  return invoke("finish_merge");
}

// ---- saving copies out of the app ------------------------------------------

/** Copies a stored photo or recording to `dest`, a path outside the app that the user chose. */
export function exportMediaFile(fileName: string, dest: string): Promise<void> {
  return invoke("export_media_file", { fileName, dest });
}

