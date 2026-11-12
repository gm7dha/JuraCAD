/**
 * Copy and paste features in the app: Ctrl/⌘ + C and V (the browser's own copy and paste, so no permission is asked
 * for), and Copy / Paste in the feature list's right-click menus. A copy is also kept in this browser, so Paste in a
 * menu, another tab or another design works even when the clipboard can't be read. The rules are in
 * model/featureClipboard.ts.
 */
import { clipText, copyFeatures, missingVariables, pasteMessage, readClip, type FeatureClip } from "../model/featureClipboard";
import { activeAssembly, activeDrawing, activeFeatures, useStore } from "../model/store";
import { inPopup } from "./popupGuard";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

const KEPT = "juracad.copiedFeatures";

function keep(text: string): void {
  try {
    localStorage.setItem(KEPT, text);
  } catch {
    // (A browser that won't keep it: the system clipboard still has it.)
  }
}

function kept(): FeatureClip | null {
  try {
    return readClip(localStorage.getItem(KEPT));
  } catch {
    return null;
  }
}

/** Whether features can be copied or pasted now (a Part Studio on show, nothing open). */
function canUseFeatures(): boolean {
  const s = useStore.getState();
  return !s.editing && !s.sketch && !s.versionView && !activeAssembly(s) && !activeDrawing(s);
}

/** Copy features of the Part Studio on show; returns the text for the clipboard (null if nothing to copy). */
export function copyFeaturesNow(ids: string[]): string | null {
  const s = useStore.getState();
  const made = copyFeatures(activeFeatures(s), ids, s.history.present.variables ?? []);
  if (!made) return null;
  const text = clipText(made.clip);
  keep(text);
  const names = made.clip.features.filter((f) => ids.includes(f.id)).map((f) => f.name);
  const also = made.added.length ? ` (with ${made.added.join(", ")}, which ${names.length === 1 ? "it uses" : "they use"})` : "";
  s.showToast(`Copied ${names.join(", ")}${also}. Paste with Ctrl+V (⌘V on a Mac) here, in another Part Studio or in another design.`, "info");
  return text;
}

/** Copy from a menu: to this browser, and to the clipboard where the browser allows it. */
export function copyFromMenu(ids: string[]): void {
  if (!canUseFeatures()) return;
  const text = copyFeaturesNow(ids);
  if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Paste a clip: asks first when it uses variables this design doesn't have. */
export function pasteClip(clip: FeatureClip): void {
  const s = useStore.getState();
  if (!canUseFeatures()) {
    s.showToast("Close the dialog or sketch first, then paste into a Part Studio.");
    return;
  }
  const missing = missingVariables(clip, s.history.present.variables ?? []).map((v) => v.name);
  if (missing.length) {
    s.askPaste({ clip, missing });
    return;
  }
  finishPaste(clip, false);
}

/** Paste now (from the question, or straight away), adding the variables it uses if asked. */
export function finishPaste(clip: FeatureClip, addVariables: boolean): void {
  const s = useStore.getState();
  const skipped = addVariables ? [] : missingVariables(clip, s.history.present.variables ?? []).map((v) => v.name);
  const r = s.pasteFeatures(clip, addVariables);
  s.askPaste(null);
  if (r) s.showToast(pasteMessage(r, skipped), r.needsPick.length || skipped.length ? "info" : "success");
}

/** Paste from a menu: what was last copied in this browser. */
export function pasteFromMenu(): void {
  const clip = kept();
  if (!clip) {
    useStore.getState().showToast("Nothing copied yet: right-click a feature and choose Copy (or select it and press Ctrl+C).");
    return;
  }
  pasteClip(clip);
}

/** Is there something copied to paste (for greying out Paste in menus)? */
export function hasCopiedFeatures(): boolean {
  return kept() !== null;
}

/**
 * Ctrl/⌘ + C copies the feature selected in the list (onto the clipboard and into this browser); Ctrl/⌘ + V pastes
 * features from the clipboard (the browser's paste, so no permission is asked for), or — where a browser sends no paste
 * without a text box — what was last copied in this browser.
 */
export function startFeatureClipboard(): () => void {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const onKey = (e: KeyboardEvent) => {
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const key = e.key.toLowerCase();
    if (!mod || (key !== "c" && key !== "v") || isTyping(e.target) || inPopup(e.target, document) || useStore.getState().dialog || !canUseFeatures()) return;
    if (key === "c") {
      // Text picked on the page (a message, a label) is copied as usual.
      if (window.getSelection?.()?.toString()) return;
      const id = useStore.getState().selectedFeatureId;
      if (!id) return;
      const text = copyFeaturesNow([id]);
      if (text) {
        e.preventDefault();
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      }
      return;
    }
    // Wait a moment for the browser's paste; none (Safari away from a text box): this browser's copy.
    if (waiting) clearTimeout(waiting);
    waiting = setTimeout(() => {
      waiting = null;
      const clip = kept();
      if (clip) pasteClip(clip);
    }, 120);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isTyping(e.target) || !canUseFeatures()) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const clip = readClip(text);
    // Something else on the clipboard (words copied elsewhere): nothing is pasted. Nothing readable: this browser's copy.
    if (!clip && text) {
      if (waiting) clearTimeout(waiting);
      waiting = null;
      return;
    }
    if (waiting) clearTimeout(waiting);
    waiting = null;
    const use = clip ?? kept();
    if (!use) return;
    e.preventDefault();
    pasteClip(use);
  };
  window.addEventListener("keydown", onKey);
  document.addEventListener("paste", onPaste);
  return () => {
    if (waiting) clearTimeout(waiting);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("paste", onPaste);
  };
}
