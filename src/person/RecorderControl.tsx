import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { discardRecording, recordingLevel, saveRecording, startRecording } from "../db";

interface Props {
  /** The photo a finished recording is attached to. */
  mediaId: string;
  onSaved: () => void;
  onError: (message: string) => void;
}

function recordingTitle(): string {
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `Recorded ${date}`;
}

/** Meter position for a peak level of 0 to 1. Loudness is heard in decibels, so the bar is drawn on that scale. */
function meterPercent(peak: number): number {
  const decibels = 20 * Math.log10(Math.max(peak, 0.00001));
  return Math.min(100, Math.max(0, ((decibels + 60) / 60) * 100));
}

/** A Record button that turns into a timer, level meter and Save/Discard while recording from the microphone. */
export function RecorderControl({ mediaId, onSaved, onError }: Props) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  // Read by the unmount cleanup, which would otherwise only see the first render's state.
  const active = useRef(false);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
      recordingLevel().then(setLevel, () => {});
    }, 100);
    return () => clearInterval(timer);
  }, [recording]);

  // Leaving the page mid-recording keeps what was said rather than throwing it away.
  useEffect(
    () => () => {
      if (active.current) saveRecording(mediaId, recordingTitle()).catch(() => {});
    },
    [mediaId],
  );

  async function start() {
    setBusy(true);
    try {
      await startRecording();
      active.current = true;
      setSeconds(0);
      setLevel(0);
      setRecording(true);
    } catch (e) {
      onError(String(e));
    }
    setBusy(false);
  }

  async function stop(keep: boolean) {
    setBusy(true);
    active.current = false;
    try {
      if (keep) await saveRecording(mediaId, recordingTitle());
      else await discardRecording();
    } catch (e) {
      onError(String(e));
    }
    setRecording(false);
    setBusy(false);
    if (keep) onSaved();
  }

  if (!recording) {
    return (
      <Button disabled={busy} onClick={start}>
        <span className="text-danger">●</span> Record
      </Button>
    );
  }

  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="flex items-center gap-2">
      <span className="animate-pulse text-danger">●</span>
      <span className="w-10 tabular-nums">{time}</span>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-line" title="Microphone level">
        <div className="h-full bg-accent" style={{ width: `${meterPercent(level)}%` }} />
      </div>
      <Button variant="primary" disabled={busy} onClick={() => stop(true)}>
        Stop and save
      </Button>
      <Button disabled={busy} onClick={() => stop(false)}>
        Discard
      </Button>
    </div>
  );
}
