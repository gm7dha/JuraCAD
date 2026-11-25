/**
 * Insert DXF / Insert SVG into the open sketch: read the file's text, add its
 * shapes at the panel's scale (one undo step, selected) and say what came in.
 * Kept apart from sketchActions.ts (which reaches the 3D view) so it's tested
 * against the real store.
 */
import { evaluate } from "../model/expr";
import { useStore } from "../model/store";
import { DxfError, insertDxf, insertSummary, MAX_DXF_SIZE, parseDxf, type InsertResult } from "../sketch/dxf";
import { insertSvg, MAX_SVG_SIZE, parseSvg, SvgError, svgSummary } from "../sketch/svg";

const sketchData = () => useStore.getState().editing?.draft.sketch?.data ?? null;

/** A number typed in the sketch panel (or a sum or variable), or null when it isn't one. */
function typedNumber(text: string | undefined, fallback: number): number | null {
  if (text === undefined || text.trim() === "") return fallback;
  const r = evaluate(text);
  return r.ok && Number.isFinite(r.value) ? r.value : null;
}

/** More shapes than this brought in at once: the message says extruding them all will be slow. */
export const MANY_SHAPES = 300;

/** Files bigger than this (bytes) aren't read at all. */
export function tooBig(kind: "dxf" | "svg", bytes: number): boolean {
  return bytes > (kind === "dxf" ? MAX_DXF_SIZE : MAX_SVG_SIZE);
}

/** Add a DXF or SVG drawing (its text) to the open sketch. Returns true when something came in. */
export function insertDrawingText(kind: "dxf" | "svg", text: string): boolean {
  const s = useStore.getState();
  if (!sketchData() || !s.sketch) return false;
  const label = kind === "dxf" ? "DXF" : "SVG";
  const scale = typedNumber(s.sketch.dxfScale, 1);
  if (scale === null || !(scale > 0)) {
    s.setSketchMessage("The scale must be a number more than 0 (1 = full size).", "error");
    return false;
  }
  if (tooBig(kind, text.length)) {
    s.setSketchMessage(`That ${label} file is too big to bring in (over 20 MB). Open it in a drawing program and save just the part you need.`, "error");
    return false;
  }
  let r: InsertResult;
  let summary: string;
  try {
    const now = sketchData();
    if (!now) return false;
    const construction = useStore.getState().sketch?.construction ?? false;
    if (kind === "dxf") {
      const drawing = parseDxf(text);
      r = insertDxf(now, drawing, scale, construction);
      summary = insertSummary(drawing, r.count, scale);
    } else {
      const drawing = parseSvg(text);
      r = insertSvg(now, drawing, scale, construction);
      summary = svgSummary(drawing, r.count, scale);
    }
  } catch (e) {
    useStore
      .getState()
      .setSketchMessage(e instanceof DxfError || e instanceof SvgError ? e.message : `That ${label} file couldn't be brought in — it may be damaged. Try saving it again from the program that made it.`, "error");
    return false;
  }
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  useStore.getState().updateSketch(r.sketch, { record: true, selection: r.curveIds });
  // Extruding hundreds of separate shapes at once is slow (each is joined on in turn).
  const many = r.count > MANY_SHAPES ? ` That's a lot of shapes: extruding them all at once can take minutes, so pick just the areas you need.` : "";
  useStore.getState().setSketchMessage(`${summary}${many} It's selected: use Move / copy to place it, or Delete to take it out again.`, "info");
  return true;
}
