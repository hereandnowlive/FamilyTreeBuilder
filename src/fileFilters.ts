import type { DialogFilter } from "@tauri-apps/plugin-dialog";

/**
 * Linux file pickers match extensions case-sensitively, so "jpg" alone hides IMG0001.JPG.
 * Listing both cases makes the picker behave as it does on Windows.
 */
function filter(name: string, extensions: string[]): DialogFilter {
  return { name, extensions: [...extensions, ...extensions.map((ext) => ext.toUpperCase())] };
}

// The extension lists must match IMAGE_EXTENSIONS, AUDIO_EXTENSIONS and DOCUMENT_EXTENSIONS in src-tauri/src/lib.rs,
// which does the real check (ignoring case).
export const IMAGE_FILTER = filter("Images", ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);
export const AUDIO_FILTER = filter("Audio", ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"]);
export const DOCUMENT_FILTER = filter("Documents", [
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "txt",
  "xls",
  "xlsx",
  "ods",
  "csv",
  "ppt",
  "pptx",
  "odp",
]);
