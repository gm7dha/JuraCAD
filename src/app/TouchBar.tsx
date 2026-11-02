/**
 * The touch bar: a small row of buttons over the 3D view (or the drawing sheet)
 * that stands in for the keyboard on a tablet — Esc, Delete, P (planes), N
 * (look straight at), F (fit) and the held keys "Add to selection" (Ctrl/⌘) and
 * Shift ("No snapping" while sketching). Only shown on touch screens: with a
 * mouse and keyboard nothing changes.
 *
 * The plain keys are sent as the very key presses the shortcuts already handle
 * (`pressKey`), so a button always does exactly what the key does.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { activeAssembly, activeDrawing, useStore } from "../model/store";
import { viewportApi } from "../viewport/Viewport";
import { setTouchKey, subscribeTouchKeys, touchKeys } from "../viewport/touchKeys";

/** Send a key press to the app's keyboard shortcuts, as if typed (not into a text box). */
export function pressKey(key: string, code = ""): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
}

/** Is this a touch screen? True for a finger-first device (iPad, Android tablet), or once a finger has touched the page. */
export function useTouchScreen(): boolean {
  const [touch, setTouch] = useState(() => {
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (touch) return;
    const seen = (e: PointerEvent) => {
      if (e.pointerType === "touch") setTouch(true);
    };
    window.addEventListener("pointerdown", seen, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", seen, { capture: true });
  }, [touch]);
  return touch;
}

function TouchToggle({ on, label, title, onChange }: { on: boolean; label: string; title: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`touch-key toggle${on ? " on" : ""}`} aria-pressed={on} title={title} onClick={() => onChange(!on)}>
      {label}
    </button>
  );
}

function TouchKey({ label, title, onClick, disabled }: { label: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="touch-key" title={title} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

export function TouchBar() {
  const touch = useTouchScreen();
  const keys = useSyncExternalStore(subscribeTouchKeys, touchKeys);
  const sketching = useStore((s) => s.sketch !== null);
  const drawing = useStore((s) => activeDrawing(s) !== null);
  const assembly = useStore((s) => activeAssembly(s) !== null);
  const canDelete = useStore((s) =>
    s.sketch ? s.sketch.selection.length > 0 : activeDrawing(s) ? s.selectedDims.length > 0 : activeAssembly(s) ? s.asmSelection.length > 0 && !s.mateDraft : !!s.selectedFeatureId && !s.editing,
  );
  const dialog = useStore((s) => s.dialog);
  // "No snapping" / "Shift" is let go when a sketch opens or closes or the drawing tab changes, so it doesn't surprise later.
  useEffect(() => () => setTouchKey("free", false), [sketching, drawing]);
  if (!touch || (dialog && dialog !== "insert")) return null;

  return (
    <div className="touch-bar" role="toolbar" aria-label="Touch keys" data-own-touch>
      <TouchToggle
        on={keys.add}
        label="Add to selection"
        title="While this is on, tapping adds to (or takes off) what's selected — like holding Ctrl or ⌘ with a mouse"
        onChange={(on) => setTouchKey("add", on)}
      />
      {(sketching || drawing) && (
        <TouchToggle
          on={keys.free}
          label={sketching ? "No snapping" : "Shift"}
          title={
            sketching
              ? "While this is on, drawing and dragging don't snap or line up with anything — like holding Shift"
              : "Like holding Shift: dragging a dimension's number lifts it off its line, or keeps an angle's angle"
          }
          onChange={(on) => setTouchKey("free", on)}
        />
      )}
      <TouchKey label={sketching ? "Back" : "Clear"} title={sketching ? "Stop what the tool is doing (like Esc)" : "Step back or clear the selection (like Esc)"} onClick={() => pressKey("Escape")} />
      <TouchKey label="Delete" title="Delete what's selected (like the Delete key)" onClick={() => pressKey("Delete")} disabled={!canDelete} />
      {!drawing && !assembly && !sketching && <TouchKey label="Planes" title="Show or hide all the planes (like P)" onClick={() => pressKey("p")} />}
      {!drawing && !assembly && (
        <TouchKey
          label="Look at"
          title="Look straight at the sketch, or the selected face or plane (like N)"
          onClick={() => {
            const plane = useStore.getState().editing?.draft.sketch?.plane;
            if (sketching && plane) viewportApi.current?.viewNormalToSketch(plane);
            else pressKey("n");
          }}
        />
      )}
      {sketching && <TouchKey label="Fit" title="Zoom to fit (like F)" onClick={() => viewportApi.current?.fit()} />}
    </div>
  );
}
