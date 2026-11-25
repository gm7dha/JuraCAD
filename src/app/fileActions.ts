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
import { IMPORT_ACCEPT, readImport, USUAL_REDUCE } from "../model/importFile";
import { reduceStlFile } from "./stlReduce";
import { meshExtras, meshFileToStl, meshFormatOf } from "../model/meshImport";
import type { ImportedFile } from "../model/types";

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
    description: "JuraCAD design, or a STEP, STL, 3MF or OBJ model to import",
    accept: {
      [FILE_MIME]: [FILE_EXTENSION],
      [OLD_FILE_MIME]: [OLD_FILE_EXTENSION],
      "application/json": DESIGN_EXTENSIONS,
      "model/step": [".step", ".stp"],
      "model/stl": [".stl"],
      "model/3mf": [".3mf"],
      "model/obj": [".obj"],
    },
  },
];

/** STEP, STL, 3MF and OBJ files are imported into the design rather than opened. */
const isModelFile = (name: string) => /\.(step|stp|stl|3mf|obj)$/i.test(name);

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
  // Looking at an old version: the current design (with every version) is what's saved, and comes back on screen.
  if (s.versionView) {
    s.leaveVersionView();
    s.showToast("Back to the current design, which is what gets saved.", "info");
  }
  const doc = useStore.getState().history.present;
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
  // A STEP, STL, 3MF or OBJ file dropped or opened here is imported into the current design.
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
 * Import a STEP, STL, 3MF or OBJ file: ask for one, then open the Import dialog with a
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

/** Read a STEP, STL, 3MF or OBJ file and start importing it. Returns true if it worked. */
export async function importFile(file: File, replace = false): Promise<boolean> {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  if (s.editing && !(replace && draft?.type === "import")) {
    s.showToast("Finish or cancel the open feature first, then import.", "error");
    return false;
  }
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let extras: Pick<ImportedFile, "from" | "unitMm"> = {};
  // 3MF and OBJ files are read as triangles and brought in as an STL would be (model/meshImport.ts).
  const meshKind = meshFormatOf(file.name);
  if (meshKind) {
    const mesh = await meshFileToStl(file.name, bytes, meshKind);
    if (!mesh.ok) {
      useStore.getState().showToast(mesh.error, "error");
      return false;
    }
    bytes = mesh.stl;
    extras = meshExtras(mesh);
    if (mesh.skipped) {
      useStore.getState().showToast(`${mesh.skipped} slicer part${mesh.skipped === 1 ? "" : "s"} (modifiers, negative parts or support blockers) left out — only the shape is brought in.`, "info");
    }
  }
  const from = meshKind ?? undefined;
  const result = readImport(file.name, bytes, from, extras.unitMm);
  if (!result.ok) {
    useStore.getState().showToast(result.error, "error");
    return false;
  }
  let imported: ImportedFile;
  if (result.ok === "reduce") {
    // Too detailed to be a solid as it is: reduced first (only the reduced shape goes into the design).
    useStore
      .getState()
      .showToast(
        `${file.name} has ${result.triangles.toLocaleString("en-GB")} triangles — more than a solid can have — so it's being reduced to about ${USUAL_REDUCE.toLocaleString("en-GB")}. This can take a little while…`,
        "info",
      );
    try {
      imported = await reduceStlFile(file.name, bytes, USUAL_REDUCE);
      if (from) imported = { ...imported, ...extras };
    } catch (e) {
      useStore.getState().showToast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
    const now = useStore.getState();
    if (now.editing && !(replace && now.editing.draft?.type === "import")) {
      now.showToast("Finish or cancel the open feature first, then import.", "error");
      return false;
    }
  } else imported = result.file;
  const s2 = useStore.getState();
  if (replace && s2.editing?.draft?.type === "import") s2.setDraftField({ import: imported });
  else s2.startImport(imported);
  return true;
}
