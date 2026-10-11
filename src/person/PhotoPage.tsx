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
  setPortrait,
  updateCaption,
  updateDescription,
  updateRecordingTitle,
} from "../db";
import { saveCopyWithDialog } from "../familyFile";
import { AUDIO_FILTER } from "../fileFilters";
import { displayName } from "../relations";
import type { Media, Person, Recording } from "../types";
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
  const fail = (e: unknown) => setError(String(e));

  const refreshRecordings = useCallback(() => listRecordings(mediaId).then(setRecordings, fail), [mediaId]);

  useEffect(() => {
    getMedia(mediaId).then((found) => (found ? setPhoto(found) : onBack()), fail);
    refreshRecordings();
  }, [mediaId, onBack, refreshRecordings]);

  if (!photo) return error ? <div className="p-8 text-danger">{error}</div> : null;

  const isPortrait = person.portrait_media_id === photo.id;

  async function togglePortrait() {
    await setPortrait(person.id, isPortrait ? null : mediaId);
    await reload();
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
            className="mx-auto max-h-[70vh] max-w-full rounded-lg"
            src={mediaUrl(photo.file_name)}
            alt={photo.caption}
          />

          <Card
            title="Recordings"
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RecorderControl mediaId={mediaId} onSaved={refreshRecordings} onError={setError} />
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
                  <li className="flex flex-col gap-2" key={recording.id}>
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

/**
 * Plays a stored recording. The file is fetched and handed to the player as a blob URL because
 * WebKitGTK, the webview on Linux, cannot play media straight from Tauri's asset protocol.
 */
function AudioPlayer({ fileName }: { fileName: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(mediaUrl(fileName))
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileName]);

  if (failed) return <p className="text-danger">This recording could not be played on this computer.</p>;
  if (!src) return <p className="text-muted">Loading recording…</p>;
  return <audio className="w-full" controls preload="metadata" src={src} onError={() => setFailed(true)} />;
}
