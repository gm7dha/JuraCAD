/**
 * Copy, paste and duplicate in an open sketch: Ctrl/⌘ + C, V and D, and the sketch toolbar's Copy / Paste buttons.
 * What was copied is kept here (and in this browser, so it can be pasted into another sketch, Part Studio, design or
 * tab); the sketch controller then has the copy follow the pointer until a click puts it down. The rules are in
 * sketch/clipboard.ts.
 */
import { useStore } from "../model/store";
import { clipSummary, copySketchItems, readSketchClip, type SketchClip } from "../sketch/clipboard";
import { viewportApi } from "../viewport/Viewport";

const KEPT = "juracad.copiedSketch";
let copied: SketchClip | null = null;

/** What was last copied: this browser's newest copy (from any tab) first, else this tab's own. */
function keptClip(): SketchClip | null {
  try {
    const kept = readSketchClip(localStorage.getItem(KEPT));
    if (kept) return (copied = kept);
  } catch {
    // (No browser storage: this tab's own copy.)
  }
  return copied;
}

/** Copy what's picked in the open sketch. False when nothing that can be copied is picked. */
export function copySketchSelection(quiet = false): boolean {
  const s = useStore.getState();
  const data = s.editing?.draft.sketch?.data;
  if (!data || !s.sketch) return false;
  const clip = copySketchItems(data, s.sketch.selection);
  if (!clip) {
    if (!quiet) s.setSketchMessage("Pick the lines, circles, points or text to copy first.", "info");
    return false;
  }
  copied = clip;
  try {
    localStorage.setItem(KEPT, JSON.stringify(clip));
  } catch {
    // (A browser that won't keep it: it can still be pasted in this tab.)
  }
  if (!quiet) s.setSketchMessage(`Copied ${clipSummary(clip)} with the relations and dimensions between them. Paste with Ctrl+V (⌘V on a Mac), here or in another sketch.`, "info");
  return true;
}

/** Start placing what was last copied: it follows the pointer until a click. */
export function pasteIntoSketch(): boolean {
  const s = useStore.getState();
  if (!s.sketch || !s.editing?.draft.sketch?.plane) return false;
  const clip = keptClip();
  if (!clip) {
    s.setSketchMessage("Nothing copied yet: pick some shapes and press Ctrl+C (⌘C on a Mac) first.", "info");
    return false;
  }
  viewportApi.sketch?.startPaste(clip);
  return true;
}

/** Ctrl/⌘ + D: a copy of what's picked, following the pointer to be put down. */
export function duplicateSketchSelection(): boolean {
  if (!copySketchSelection(true)) {
    useStore.getState().setSketchMessage("Pick the lines, circles, points or text to duplicate first.", "info");
    return false;
  }
  return pasteIntoSketch();
}

/** Is there something copied to paste? */
export function hasCopiedSketch(): boolean {
  return keptClip() !== null;
}

/** Is there something copied to paste (the right-click menu offers Paste then)? */
export function canPasteSketch(): boolean {
  return !!keptClip();
}
