/**
 * The sketch's right-click menu (open state and its choices), Extrude / Revolve straight from the sketch toolbar, and
 * the dimension switches (diameter ↔ radius, centreline). The menu's contents are worked out by the pure
 * sketch/sketchMenu.ts; this runs them against the store.
 */
import { useSyncExternalStore } from "react";

import { useStore } from "../model/store";
import { setCentrelineDimension, switchRoundDimension } from "../sketch/dimensionKinds";
import { findRegions } from "../sketch/regions";
import { sketchHitsAt, sketchItemLabel, sketchMenuItems, type SketchMenuAction, type SketchMenuItem } from "../sketch/sketchMenu";
import { hiddenConstruction, type SketchKey } from "../sketch/sketchView";
import { viewportApi } from "../viewport/Viewport";
import { canPasteSketch, copySketchSelection, pasteIntoSketch } from "./sketchClipboardApp";
import { applySketchRelation, deleteSketchSelection, setSketchTool, sketchEscape, toggleSketchConstruction } from "./sketchActions";
import { setSketchLit, setSketchView, sketchViewNow } from "./sketchViewState";

export interface SketchMenuOpen {
  /** Window position (CSS px) it opens at. */
  at: { x: number; y: number };
  items: SketchMenuItem[];
  /** What's under the pointer (for Select other), nearest first. */
  under: string[];
  /** Showing the Select other list instead of the menu. */
  other?: { ids: string[]; labels: string[] };
}

let current: SketchMenuOpen | null = null;
const listeners = new Set<() => void>();

function setMenu(next: SketchMenuOpen | null): void {
  current = next;
  for (const l of listeners) l();
}

export function closeSketchMenu(): void {
  setSketchLit(null);
  setMenu(null);
}

export function sketchMenuNow(): SketchMenuOpen | null {
  return current;
}

export function useSketchMenu(): SketchMenuOpen | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

const sketchData = () => useStore.getState().editing?.draft.sketch?.data ?? null;

/**
 * Right-click (or a long press) in the sketch at window position `at`, sketch point `p`, things within `tol` mm.
 * A thing under the pointer that isn't picked is added to the selection first (as Onshape does). False = no sketch open.
 */
export function openSketchMenu(at: { x: number; y: number }, p: { x: number; y: number } | null, tol: number): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch || !s.editing?.draft.sketch?.plane) return false;
  // (Construction geometry hidden with Shift+P isn't under the pointer.)
  const hidden = sketchViewNow().hideConstruction ? hiddenConstruction(data, s.sketch.selection) : null;
  const under = p ? sketchHitsAt(data, p.x, p.y, tol).filter((id) => !hidden?.has(id)) : [];
  let selection = s.sketch.selection;
  const busy = !!viewportApi.sketch?.busy();
  if (!busy && under.length && !selection.includes(under[0])) {
    selection = [...selection, under[0]];
    s.setSketchSelection(selection);
  }
  const view = sketchViewNow();
  const items = sketchMenuItems(data, selection, { busy, canPaste: canPasteSketch(), showConstraints: view.constraints, showDimensions: view.dimensions, under: under.length });
  setMenu({ at, items, under });
  return true;
}

/**
 * Right-click (or a long press) on a relation badge or a dimension's number: it joins the selection (as anything else
 * under the pointer does) and the menu opens there.
 */
export function openSketchMenuOn(id: string, at: { x: number; y: number }): boolean {
  const s = useStore.getState();
  if (!s.sketch) return false;
  if (!viewportApi.sketch?.busy() && !s.sketch.selection.includes(id)) s.setSketchSelection([...s.sketch.selection, id]);
  return openSketchMenu(at, null, 0);
}

/** Run one of the menu's choices (the menu closes first). */
export function runSketchMenu(action: SketchMenuAction): void {
  const open = current;
  closeSketchMenu();
  const s = useStore.getState();
  const id = () => s.sketch?.selection.find((x) => sketchData()?.constraints.some((c) => c.id === x)) ?? null;
  switch (action.kind) {
    case "finish":
      sketchEscape();
      break;
    case "relation":
      applySketchRelation(action.relation);
      break;
    case "construction":
      toggleSketchConstruction();
      break;
    case "copy":
      copySketchSelection();
      break;
    case "paste":
      pasteIntoSketch();
      break;
    case "delete":
      deleteSketchSelection();
      break;
    case "roundSwitch": {
      const d = id();
      if (d) switchSketchRoundDimension(d);
      break;
    }
    case "centreline": {
      const d = id();
      if (d) setSketchCentreline(d, action.on);
      break;
    }
    case "showConstraints": {
      const show = !sketchViewNow().constraints;
      setSketchView({ constraints: show });
      s.setSketchMessage(show ? "Constraints shown." : "Constraints hidden — they still hold the shapes. Right-click and choose Show all constraints to see them again.", "info");
      break;
    }
    case "showDimensions": {
      const show = !sketchViewNow().dimensions;
      setSketchView({ dimensions: show });
      s.setSketchMessage(show ? "Dimensions shown." : "Dimensions hidden — they still set the sizes. Right-click and choose Show all dimensions to see them again.", "info");
      break;
    }
    case "selectOther": {
      const data = sketchData();
      if (!open || !data) break;
      setMenu({ ...open, other: { ids: open.under, labels: open.under.map((x) => sketchItemLabel(data, x)) } });
      break;
    }
  }
}

/** Select other's choice: just that one picked (or added, with Ctrl/⌘/Shift). */
export function pickSketchOther(id: string, add: boolean): void {
  closeSketchMenu();
  const s = useStore.getState();
  if (!s.sketch) return;
  const sel = s.sketch.selection;
  s.setSketchSelection(add ? (sel.includes(id) ? sel : [...sel, id]) : [id]);
}

/** A circle's or arc's dimension: diameter ↔ radius, the circle the same size. */
export function switchSketchRoundDimension(id: string): void {
  const s = useStore.getState();
  const data = sketchData();
  if (!data) return;
  const r = switchRoundDimension(data, id);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  s.updateSketch(r.sketch, { record: true });
  const now = r.sketch.constraints.find((c) => c.id === id);
  s.setSketchMessage(now?.type === "radius" ? "Shown as a radius now." : "Shown as a diameter now.", "info");
}

/** A point-to-construction-line dimension measured across the line, as a diameter (for revolve profiles), or not. */
export function setSketchCentreline(id: string, on: boolean): void {
  const s = useStore.getState();
  const data = sketchData();
  if (!data) return;
  const r = setCentrelineDimension(data, id, on);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  s.updateSketch(r.sketch, { record: true });
  s.setSketchMessage(on ? "Measured as a diameter across the centreline now: the size the turned part comes out." : "Measured to the centreline now.", "info");
}

/** The sketch toolbar's Extrude / Revolve: finish the sketch and open the feature with its closed shapes. */
export function finishSketchInto(type: "extrude" | "revolve"): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.editing?.draft.sketch?.plane) return false;
  if (!findRegions(data).regions.length) {
    s.setSketchMessage(`${type === "extrude" ? "Extrude" : "Revolve"} needs a closed outline: draw one first (a rectangle, a circle, or lines that join up).`, "error");
    return false;
  }
  if (!s.commitDraft()) return false;
  // The sketch just finished is the one highlighted in the list, so the feature takes it (and the areas left free).
  useStore.getState().startCreate(type);
  return true;
}

/** One of the extra sketch keys (sketch/sketchView.ts SKETCH_KEYS). */
export function runSketchKey(k: SketchKey): void {
  const a = k.action;
  if ("relation" in a) applySketchRelation(a.relation);
  else if ("tool" in a) setSketchTool(a.tool);
  else toggleSketchConstructionShown();
}

/** Shift+P: hide construction geometry, or show it again. */
export function toggleSketchConstructionShown(): void {
  const hide = !sketchViewNow().hideConstruction;
  setSketchView({ hideConstruction: hide });
  useStore.getState().setSketchMessage(hide ? "Construction geometry hidden — Shift+P shows it again." : "Construction geometry shown.", "info");
}
