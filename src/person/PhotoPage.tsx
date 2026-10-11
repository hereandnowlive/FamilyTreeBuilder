import { useCallback, useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Button, Card, Field, TopBar, inputClass } from "../components/ui";
import {
  deleteMedia,
  deleteRecording,
  getMedia,
  importRecording,
  listRecordings,
  mediaUrl,
  rotatePhoto,
  setPortrait,
  updateCaption,
  updateDescription,
  updateRecordingTitle,
} from "../db";
import { saveCopyWithDialog } from "../familyFile";
import { AUDIO_FILTER } from "../fileFilters";
import { displayName } from "../relations";
import type { Media, Person, Recording } from "../types";
import { AudioPlayer } from "./AudioPlayer";
import { RecorderControl } from "./RecorderControl";

interface Props {
  person: Person;
  mediaId: string;
  reload: () => Promise<void>;
  /** Returns to the person's page. */
  onBack: () => void;
}

export function PhotoPage({ person, mediaId, reload, onBack }: Props) {
  const [photo, setPhoto] = useState<Media | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The recording just made with the Record button, so it can be pointed out in the list.
  const [justRecordedId, setJustRecordedId] = useState<string | null>(null);
  // True while a turned copy of the photo is being saved, which takes a moment for a large scan.
  const [rotating, setRotating] = useState(false);
  const fail = (e: unknown) => setError(String(e));

  const refreshRecordings = useCallback(() => listRecordings(mediaId).then(setRecordings, fail), [mediaId]);

  useEffect(() => {
    getMedia(mediaId).then((found) => (found ? setPhoto(found) : onBack()), fail);
    refreshRecordings();
  }, [mediaId, onBack, refreshRecordings]);

  // The list can be longer than the window, so bring a new recording into view once it is listed.
  useEffect(() => {
    if (justRecordedId) document.getElementById(`recording-${justRecordedId}`)?.scrollIntoView({ block: "nearest" });
  }, [justRecordedId]);

  if (!photo) return error ? <div className="p-8 text-danger">{error}</div> : null;

  const isPortrait = person.portrait_media_id === photo.id;

  async function togglePortrait() {
    await setPortrait(person.id, isPortrait ? null : mediaId);
    await reload();
  }

  async function rotate(clockwise: boolean) {
    setRotating(true);
    setError(null);
    try {
      const fileName = await rotatePhoto(photo!, clockwise);
      setPhoto({ ...photo!, file_name: fileName });
      // The tree and the person page show this photo too, if it is the portrait.
      await reload();
    } catch (e) {
      fail(e);
    }
    setRotating(false);
  }

  async function removePhoto() {
    const extra = recordings.length > 0 ? " Its recordings will be removed too." : "";
    if (!(await confirm(`Delete this photo?${extra} This cannot be undone.`, { title: "Delete photo", kind: "warning" })))
      return;
    await deleteMedia(photo!);
    await reload();
    onBack();
  }

  async function addRecordings() {
    const picked = await open({
      multiple: true,
      filters: [AUDIO_FILTER],
    });
    if (!picked) return;
    try {
      for (const path of picked) await importRecording(mediaId, path);
    } catch (e) {
      fail(e);
    }
    await refreshRecordings();
  }

  /** Reloads the list after a recording is saved and works out which entry is the new one. */
  async function showNewRecording() {
    const known = new Set(recordings.map((recording) => recording.id));
    try {
      const latest = await listRecordings(mediaId);
      setRecordings(latest);
      setJustRecordedId(latest.find((recording) => !known.has(recording.id))?.id ?? null);
    } catch (e) {
      fail(e);
    }
  }

  async function removeRecording(recording: Recording) {
    if (!(await confirm("Remove this recording? The copy stored in the app will be deleted.", { kind: "warning" })))
      return;
    await deleteRecording(recording);
    await refreshRecordings();
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <Button onClick={onBack}>← {displayName(person)}</Button>
        <div className="flex-1" />
        {rotating && <span className="text-muted">Saving the turned photo…</span>}
        <Button disabled={rotating} title="Turn the photo a quarter turn to the left" onClick={() => rotate(false)}>
          ⟲ Rotate left
        </Button>
        <Button disabled={rotating} title="Turn the photo a quarter turn to the right" onClick={() => rotate(true)}>
          ⟳ Rotate right
        </Button>
        <Button onClick={togglePortrait}>{isPortrait ? "★ Portrait" : "☆ Use as portrait"}</Button>
        <Button onClick={() => saveCopyWithDialog(photo.file_name, photo.caption || "Photo").catch(fail)}>
          Save a copy…
        </Button>
        <Button className="text-danger" onClick={removePhoto}>
          Delete photo
        </Button>
      </TopBar>

      <main className="flex-1 overflow-y-auto px-4 pt-6 pb-12">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5">
          {error && <p className="text-danger">{error}</p>}

          <img
            className={`mx-auto max-h-[70vh] max-w-full rounded-lg ${rotating ? "opacity-50" : ""}`}
            src={mediaUrl(photo.file_name)}
            alt={photo.caption}
          />

          <Card
            title="Recordings"
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RecorderControl mediaId={mediaId} onSaved={showNewRecording} onError={setError} />
                <Button onClick={addRecordings}>+ Add audio</Button>
              </div>
            }
          >
            {recordings.length === 0 ? (
              <p className="text-muted">
                No recordings yet. Record yourself talking about this photo, or add an audio file you already have.
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {recordings.map((recording) => (
                  <li
                    className="flex flex-col gap-2"
                    key={recording.id}
                    id={`recording-${recording.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        className={inputClass}
                        placeholder="Name this recording…"
                        aria-label="Recording name"
                        defaultValue={recording.title}
                        onBlur={(e) => updateRecordingTitle(recording.id, e.target.value).catch(fail)}
                      />
                      <Button
                        variant="ghost"
                        className="flex-none"
                        onClick={() => saveCopyWithDialog(recording.file_name, recording.title || "Recording").catch(fail)}
                      >
                        Save a copy…
                      </Button>
                      <Button
                        variant="ghost"
                        className="flex-none text-danger"
                        onClick={() => removeRecording(recording)}
                      >
                        Remove
                      </Button>
                    </div>
                    <AudioPlayer fileName={recording.file_name} />
                    {recording.id === justRecordedId && (
                      <p className="text-accent">
                        ✓ Your recording is saved with this photo. Press play to hear it back, or type a name for it
                        above.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="About this photo">
            <div className="flex flex-col gap-3">
              <Field label="Caption">
                <input
                  className={inputClass}
                  placeholder="A short title, shown under the photo"
                  defaultValue={photo.caption}
                  onBlur={(e) => updateCaption(photo.id, e.target.value).catch(fail)}
                />
              </Field>
              <Field label="Description">
                <textarea
                  className={`${inputClass} resize-y font-serif text-base leading-[1.6]`}
                  rows={8}
                  placeholder="Who is in it, where and when it was taken, the story behind it…"
                  defaultValue={photo.description}
                  onBlur={(e) => updateDescription(photo.id, e.target.value).catch(fail)}
                />
              </Field>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
