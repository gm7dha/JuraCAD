/**
 * Saving and opening .juracad files on the user's computer (older
 * .partsmith files, from when the app was called PartSmith, open too).
 *
 * In Chrome and Edge this uses the browser's real Save / Open windows, and
 * after the first save, Save writes straight back to the same file. Other
 * browsers (Safari, Firefox) save by downloading and open with the normal
 * file picker.
 */
import { DESIGN_EXTENSIONS, FILE_EXTENSION, FILE_MIME, OLD_FILE_EXTENSION, OLD_FILE_MIME, nameFromFileName, readDocumentFile, serializeDocument } from "../model/fileFormat";
import { useStore } from "../model/store";
import { downloadFile, safeFileName } from "./download";
import { IMPORT_ACCEPT, readImport } from "../model/importFile";

// The File System Access API isn't in TypeScript's built-in types yet.
interface WritableFile {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFile>;
}
interface PickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (o: PickerOptions) => Promise<FileHandle>;
  showOpenFilePicker?: (o: PickerOptions) => Promise<FileHandle[]>;
};

const FILE_TYPES = [{ description: "JuraCAD design", accept: { [FILE_MIME]: [FILE_EXTENSION], "application/json": [FILE_EXTENSION] } }];

// Opening also accepts .partsmith files saved before the app was renamed.
const OPEN_TYPES = [
  {
    description: "JuraCAD design, or a STEP or STL model to import",
    accept: {
      [FILE_MIME]: [FILE_EXTENSION],
      [OLD_FILE_MIME]: [OLD_FILE_EXTENSION],
      "application/json": DESIGN_EXTENSIONS,
      "model/step": [".step", ".stp"],
      "model/stl": [".stl"],
    },
  },
];

/** STEP and STL files are imported into the design rather than opened. */
const isModelFile = (name: string) => /\.(step|stp|stl)$/i.test(name);

/** The file the design was last saved to or opened from (Chrome/Edge only). */
let currentHandle: FileHandle | null = null;

const isCancel = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Save the design. `saveAs` always asks where; otherwise the same file is reused when possible. */
export async function saveToFile(saveAs = false): Promise<void> {
  const s = useStore.getState();
  if (s.editing) {
    s.showToast("Finish or cancel the open feature first, then save.", "error");
    return;
  }
  const doc = s.history.present;
  const text = serializeDocument(doc);
  const suggested = `${safeFileName(doc.name, "JuraCAD design")}${FILE_EXTENSION}`;
  const w = window as PickerWindow;
  try {
    if (w.showSaveFilePicker) {
      if (!currentHandle || saveAs) currentHandle = await w.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
      const out = await currentHandle.createWritable();
      await out.write(new Blob([text], { type: FILE_MIME }));
      await out.close();
      useStore.getState().markSaved(currentHandle.name);
      useStore.getState().showToast(`Saved ${currentHandle.name}`, "success");
      return;
    }
    downloadFile(new Blob([text], { type: FILE_MIME }), suggested);
    useStore.getState().markSaved(suggested);
    useStore.getState().showToast(`Saved ${suggested} to your Downloads folder`, "success");
  } catch (e) {
    if (isCancel(e)) return;
    currentHandle = null;
    useStore.getState().showToast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Open a design file chosen by the user. */
export async function openFromFile(): Promise<void> {
  const s = useStore.getState();
  if (s.editing) {
    s.showToast("Finish or cancel the open feature first, then open a file.", "error");
    return;
  }
  const w = window as PickerWindow;
  try {
    if (w.showOpenFilePicker) {
      const [handle] = await w.showOpenFilePicker({ types: OPEN_TYPES });
      const file = await handle.getFile();
      if ((await openFile(file)) && !isModelFile(file.name)) currentHandle = handle;
      return;
    }
  } catch (e) {
    if (isCancel(e)) return;
    useStore.getState().showToast(`Couldn't open: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  // Other browsers: the ordinary file picker.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = `${DESIGN_EXTENSIONS.join(",")},application/json,${IMPORT_ACCEPT}`;
  input.className = "file-input";
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void openFile(file).then((ok) => ok && !isModelFile(file.name) && (currentHandle = null));
  };
  document.body.appendChild(input);
  input.click();
}

/** Open a file (from a picker, or dropped on the window). Returns true if it worked. */
export async function openFile(file: File): Promise<boolean> {
  const s = useStore.getState();
  if (s.editing) {
    s.showToast("Finish or cancel the open feature first, then open a file.", "error");
    return false;
  }
  // A STEP or STL file dropped or opened here is imported into the current design.
  if (isModelFile(file.name)) return importFile(file);
  const result = readDocumentFile(await file.text(), file.name);
  if (!result.ok) {
    s.showToast(result.error, "error");
    return false;
  }
  const doc = result.doc.name === "Untitled part" ? { ...result.doc, name: nameFromFileName(file.name) || result.doc.name } : result.doc;
  s.openDocument(doc, file.name);
  currentHandle = null;
  useStore.getState().showToast(`Opened ${file.name}. Undo brings back what you had before.`, "success");
  return true;
}

/** Forget the file (after New), so the next Save asks where to save. */
export function forgetFile(): void {
  currentHandle = null;
}

/**
 * Import a STEP or STL file: ask for one, then open the Import dialog with a
 * preview. With `replace`, the file swaps in for the one in the open Import dialog.
 */
export function chooseImportFile(replace = false): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMPORT_ACCEPT;
  input.className = "file-input";
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void importFile(file, replace);
  };
  document.body.appendChild(input);
  input.click();
}

/** Read a STEP or STL file and start importing it. Returns true if it worked. */
export async function importFile(file: File, replace = false): Promise<boolean> {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  if (s.editing && !(replace && draft?.type === "import")) {
    s.showToast("Finish or cancel the open feature first, then import.", "error");
    return false;
  }
  const result = readImport(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!result.ok) {
    useStore.getState().showToast(result.error, "error");
    return false;
  }
  if (replace && draft?.type === "import") useStore.getState().setDraftField({ import: result.file });
  else useStore.getState().startImport(result.file);
  return true;
}
