// Every call into the Rust side of the app. Components do not call `invoke` themselves.
//
// The database lives in Rust (src-tauri/src/db.rs). Each function here is a thin wrapper around
// the command of the same name in src-tauri/src/lib.rs. Tauri converts argument names on the way:
// `personId` here arrives as `person_id` there.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { sep } from "@tauri-apps/api/path";
import type { Choice, MergePlan, Snapshot } from "./merge/plan";
import type {
  EventFields,
  EventLink,
  LifeEvent,
  Media,
  PersonDocument,
  PersonFields,
  Recording,
  RelationKind,
  TreeData,
} from "./types";

// ---- media files -----------------------------------------------------------

let mediaDir = "";
let thumbDir = "";
let storage: Promise<void> | null = null;

/**
 * Call at startup, before anything touches the database or renders a photo: the first step swaps
 * in a family file staged before the restart, which must happen before the database is opened.
 * Repeat calls share one run.
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

export function loadTree(): Promise<TreeData> {
  return invoke<TreeData>("load_tree");
}

// ---- people ----------------------------------------------------------------

/** Adds a person and returns their new id. */
export function createPerson(fields: PersonFields): Promise<string> {
  return invoke<string>("create_person", { fields });
}

export function updatePerson(id: string, fields: PersonFields): Promise<void> {
  return invoke("update_person", { id, fields });
}

/**
 * Removes the person and every link to them. Events they shared with someone else are kept for
 * the others; events that were theirs alone go too, with their photos and recordings.
 */
export function deletePerson(id: string): Promise<void> {
  return invoke("delete_person", { id });
}

// ---- relationships ---------------------------------------------------------

/**
 * Links `relativeId` to `anchorId` as the given kind of relative.
 * `coParentId` only applies to "child": the child's other parent.
 */
export function linkRelative(
  anchorId: string,
  kind: RelationKind,
  relativeId: string,
  coParentId?: string,
): Promise<void> {
  return invoke("link_relative", { anchorId, kind, relativeId, coParentId });
}

export function removePartnership(a: string, b: string): Promise<void> {
  return invoke("remove_partnership", { a, b });
}

export function removeParentLink(parentId: string, childId: string): Promise<void> {
  return invoke("remove_parent_link", { parentId, childId });
}

// ---- major events ----------------------------------------------------------

/** The events the person is part of, whether theirs alone or shared. */
export function listEvents(personId: string): Promise<LifeEvent[]> {
  return invoke<LifeEvent[]>("list_events", { personId });
}

/** Every membership row of the person's events, so the page can show who each one is shared with. */
export function listEventLinks(personId: string): Promise<EventLink[]> {
  return invoke<EventLink[]>("list_event_links", { personId });
}

/** Adds an empty event to the person and returns its id. */
export function createEvent(personId: string): Promise<string> {
  return invoke<string>("create_event", { personId });
}

/** Shares the event with another person, so it appears on their page too. */
export function addEventPerson(eventId: string, personId: string): Promise<void> {
  return invoke("add_event_person", { eventId, personId });
}

/**
 * Takes the event off one person's page. It stays for everyone else it is shared with;
 * if there is nobody else, the event is deleted along with its photos.
 */
export function removeEventPerson(eventId: string, personId: string): Promise<void> {
  return invoke("remove_event_person", { eventId, personId });
}

export function updateEvent(id: string, fields: EventFields): Promise<void> {
  return invoke("update_event", { id, fields });
}

/** Removes the event for everyone, along with its photos and their recordings (rows and files). */
export function deleteEvent(id: string): Promise<void> {
  return invoke("delete_event", { id });
}

// ---- photos ----------------------------------------------------------------

export async function getMedia(id: string): Promise<Media | undefined> {
  return (await invoke<Media | null>("get_media", { id })) ?? undefined;
}

/** The photos in all of the person's events, including ones added from another person's page. */
export function listMedia(personId: string): Promise<Media[]> {
  return invoke<Media[]>("list_media", { personId });
}

/** Copies the image at `sourcePath` into the app's media folder and adds it to the person's event. */
export function importPhoto(personId: string, sourcePath: string, eventId: string): Promise<string> {
  return invoke<string>("import_photo", { personId, source: sourcePath, eventId });
}

export function updateCaption(mediaId: string, caption: string): Promise<void> {
  return invoke("update_caption", { mediaId, caption });
}

export function updateDescription(mediaId: string, description: string): Promise<void> {
  return invoke("update_description", { mediaId, description });
}

export function setPortrait(personId: string, mediaId: string | null): Promise<void> {
  return invoke("set_portrait", { personId, mediaId });
}

/**
 * Turns the photo a quarter turn and saves it that way. Returns the name of the file it is now
 * stored in, which is a new one: use it in place of `media.file_name`.
 */
export function rotatePhoto(media: Media, clockwise: boolean): Promise<string> {
  return invoke<string>("rotate_photo", { id: media.id, clockwise });
}

/** Removes the photo and the recordings attached to it (rows and files). */
export function deleteMedia(media: Media): Promise<void> {
  return invoke("delete_media", { id: media.id });
}

// ---- recordings ------------------------------------------------------------

export function listRecordings(mediaId: string): Promise<Recording[]> {
  return invoke<Recording[]>("list_recordings", { mediaId });
}

/** The name of the file at `path`, without its folder or extension. Used as a starting title. */
function baseName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
}

/** Copies the audio file at `sourcePath` into the app's media folder and attaches it to the photo. */
export function importRecording(mediaId: string, sourcePath: string): Promise<void> {
  return invoke("import_recording", { mediaId, source: sourcePath, title: baseName(sourcePath) });
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
export function saveRecording(mediaId: string, title: string): Promise<void> {
  return invoke("save_recording", { mediaId, title });
}

/** Stops the recording in progress and throws it away. */
export function discardRecording(): Promise<void> {
  return invoke("discard_recording");
}

export function updateRecordingTitle(id: string, title: string): Promise<void> {
  return invoke("update_recording_title", { id, title });
}

export function deleteRecording(recording: Recording): Promise<void> {
  return invoke("delete_recording", { id: recording.id });
}

// ---- documents -------------------------------------------------------------

/** The files attached to a person, such as PDFs and Word documents. */
export function listDocuments(personId: string): Promise<PersonDocument[]> {
  return invoke<PersonDocument[]>("list_documents", { personId });
}

/** Copies the file at `sourcePath` into the app's media folder and attaches it to the person. */
export function importDocument(personId: string, sourcePath: string): Promise<void> {
  return invoke("import_document", { personId, source: sourcePath, title: baseName(sourcePath) });
}

export function updateDocumentTitle(id: string, title: string): Promise<void> {
  return invoke("update_document_title", { id, title });
}

/** Opens the document in the program the computer uses for that kind of file. */
export function openDocument(document: PersonDocument): Promise<void> {
  return invoke("open_document", { id: document.id });
}

/** Removes the document (row and file). */
export function deleteDocument(document: PersonDocument): Promise<void> {
  return invoke("delete_document", { id: document.id });
}

// ---- family files ----------------------------------------------------------

/** Saves the whole tree, photos included, as one family file at `dest`. */
export function saveFamilyFile(dest: string): Promise<void> {
  return invoke("write_family_file", { dest });
}

/**
 * Replaces the tree in the app with the one in the family file at `path`, then restarts the app.
 * Pass `backupStamp` to keep a copy of the current tree first; pass null when there is nothing to keep.
 */
export async function openFamilyFile(path: string, backupStamp: string | null): Promise<void> {
  // Validated and unpacked first, so a file that cannot be opened changes nothing.
  await invoke("stage_family_file", { path });
  if (backupStamp) await invoke("write_backup", { stamp: backupStamp });
  await invoke("restart_into_staged");
}

// ---- merging a family file -------------------------------------------------
// The planning is in merge/plan.ts. The steps here: startMerge() unpacks the file, the merge
// screen calls loadMergeSnapshots() and shows the plan, then applyMerge() or just finishMerge()
// to cancel.

/** Checks the family file at `path` and unpacks it ready for merging. The merge screen can be shown next. */
export function startMerge(path: string): Promise<void> {
  return invoke("stage_merge", { path });
}

/** Whether a family file is still waiting to be merged from the last time the app was open. Call after initStorage(). */
export function pendingMerge(): Promise<boolean> {
  return invoke<boolean>("pending_merge");
}

/** Everything in the current tree and everything in the file being merged. */
export function loadMergeSnapshots(): Promise<{ mine: Snapshot; theirs: Snapshot }> {
  return invoke("merge_snapshots");
}

/**
 * Carries out a merge plan. `choices` holds the user's decision for every conflict, by its key.
 * A backup of the current tree is always taken first. If any conflict was settled, a copy of each
 * tree that lost out is also kept in the overrides folder, whose path is returned (null if none).
 * The merge is all or nothing: if this fails, the tree is as it was.
 */
export function applyMerge(
  plan: MergePlan,
  choices: Record<string, Choice>,
  stamp: string,
): Promise<string | null> {
  return invoke<string | null>("apply_merge", { plan, choices, stamp });
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
