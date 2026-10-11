import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { desktopDir, join } from "@tauri-apps/api/path";
import { exportMediaFile, openFamilyFile, saveFamilyFile, startMerge } from "./db";

const EXTENSION = "familytree";
const FILTERS = [{ name: "Family Tree Builder file", extensions: [EXTENSION] }];
// The file last opened or saved, offered again as the place to save to.
const LAST_FILE_KEY = "lastFamilyFile";

/** Asks where to save, then writes the whole tree there as one file. */
export async function saveFamilyFileWithDialog(): Promise<void> {
  let dest = await save({
    title: "Save family file",
    defaultPath: localStorage.getItem(LAST_FILE_KEY) ?? `Family Tree.${EXTENSION}`,
    filters: FILTERS,
  });
  if (!dest) return;
  // Not every platform's save dialog adds the extension.
  if (!dest.toLowerCase().endsWith(`.${EXTENSION}`)) dest += `.${EXTENSION}`;

  await saveFamilyFile(dest);
  localStorage.setItem(LAST_FILE_KEY, dest);
  await message(`Saved to:\n${dest}\n\nSend this file to the next person. It holds everyone in the tree and all the photos.`, {
    title: "Family file saved",
  });
}

/**
 * Asks for a family file and replaces the tree in the app with it. The app restarts on success.
 * `hasData` says whether there is a tree worth confirming over and backing up.
 */
export async function openFamilyFileWithDialog(hasData: boolean): Promise<void> {
  const path = await open({ title: "Open family file", multiple: false, filters: FILTERS });
  if (!path) return;

  if (hasData) {
    const ok = await confirm(
      "Opening this file replaces the tree that is in the app now with the one in the file.\n\n" +
        "If you have made changes that are not in the file, they will not be carried over. " +
        "A backup of the current tree is kept, so nothing is lost for good.",
      { title: "Open family file", kind: "warning", okLabel: "Replace my tree" },
    );
    if (!ok) return;
  }

  localStorage.setItem(LAST_FILE_KEY, path);
  await openFamilyFile(path, hasData ? timeStamp() : null);
}

/** A stamp for naming backups: 2026-10-11T06:12:33.000Z -> 2026-10-11-06-12-33 */
export function timeStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

/**
 * Asks for a family file to merge into the current tree and gets it ready. Returns true if the
 * merge screen should now be shown, where the user sees what would change before anything does;
 * false if they cancelled.
 */
export async function mergeFamilyFileWithDialog(): Promise<boolean> {
  const path = await open({ title: "Merge a family file", multiple: false, filters: FILTERS });
  if (!path) return false;
  await startMerge(path);
  return true;
}

/**
 * Asks where to save a copy of a stored photo or recording, starting on the Desktop.
 * `suggestedName` is the file name to offer, without an extension.
 */
export async function saveCopyWithDialog(fileName: string, suggestedName: string): Promise<void> {
  const extension = fileName.split(".").pop() ?? "";
  // Characters that Windows does not allow in file names.
  const name = suggestedName.trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  let dest = await save({
    title: "Save a copy",
    defaultPath: await join(await desktopDir(), `${name}.${extension}`),
    filters: [{ name: `${extension.toUpperCase()} file`, extensions: [extension, extension.toUpperCase()] }],
  });
  if (!dest) return;
  if (!dest.toLowerCase().endsWith(`.${extension}`)) dest += `.${extension}`;
  await exportMediaFile(fileName, dest);
  await message(`Saved to:\n${dest}`, { title: "Copy saved" });
}

