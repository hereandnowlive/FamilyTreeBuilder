import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../db";

/** 75 -> "1:15" */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Plays a stored recording: a round play button, a bar that shows and sets the position, and the time.
 *
 * The file is fetched and handed to the player as a blob URL because WebKitGTK, the webview on
 * Linux, cannot play media straight from Tauri's asset protocol. The controls are drawn here
 * instead of using the browser's own, which look different on every system and show an unexplained
 * spinner while they work out how long a recording is.
 */
export function AudioPlayer({ fileName }: { fileName: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  // Null until known. A recording made in the app carries no length, so the webview may only
  // find out once it has been played to the end.
  const [duration, setDuration] = useState<number | null>(null);

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
      .catch(() => !cancelled && setStatus("failed"));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileName]);

  if (status === "failed") return <p className="text-danger">This recording could not be played on this computer.</p>;

  const ready = status === "ready";
  const noteDuration = (element: HTMLAudioElement) => {
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
  };

  function toggle() {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) return element.pause();
    // Only one recording plays at a time.
    for (const other of document.querySelectorAll("audio")) if (other !== element) other.pause();
    element.play().catch(() => setStatus("failed"));
  }

  function seek(seconds: number) {
    if (!audio.current) return;
    audio.current.currentTime = seconds;
    setTime(seconds);
  }

  const percent = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-paper px-3 py-2">
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="auto"
          onLoadedMetadata={(e) => noteDuration(e.currentTarget)}
          onDurationChange={(e) => noteDuration(e.currentTarget)}
          onCanPlay={() => setStatus("ready")}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onEnded={(e) => {
            // Having reached the end, the length is known for certain.
            setDuration(e.currentTarget.currentTime);
            setPlaying(false);
            seek(0);
          }}
          onError={() => setStatus("failed")}
        />
      )}

      <button
        className="flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-accent/45 disabled:cursor-default disabled:opacity-45"
        disabled={!ready}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        onClick={toggle}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
          {playing ? <path d="M3 2h4v12H3zM9 2h4v12H9z" /> : <path d="M4 2l10 6-10 6z" />}
        </svg>
      </button>

      {/* The bar is drawn with plain elements; an invisible slider on top of it takes the mouse and keyboard. */}
      <div className="relative flex h-6 flex-1 items-center">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
        {duration !== null && (
          <>
            <div
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface bg-accent shadow-sm"
              style={{ left: `${percent}%` }}
            />
            <input
              type="range"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label="Position in the recording"
              min={0}
              max={duration}
              step={0.1}
              value={Math.min(time, duration)}
              onChange={(e) => seek(Number(e.target.value))}
            />
          </>
        )}
      </div>

      <span className="flex-none text-xs text-muted tabular-nums">
        {!ready ? "Getting it ready…" : duration !== null ? `${clock(time)} / ${clock(duration)}` : clock(time)}
      </span>
    </div>
  );
}
