/** Actions used by both the sketch toolbar and keyboard shortcuts. */
import { useStore, type SketchTool } from "../model/store";
import { applyRelation, RELATION_LABELS, setDimensionDriven, setMeasureTo, toggleConstruction, type MeasureTo, type RelationTool } from "../sketch/ops";
import { patternCurves, readPatternSettings, readTransformSettings, transformCurves } from "../sketch/tools";
import { viewportApi } from "../viewport/Viewport";
import { linkAllEdges } from "../sketch/links";
import { addImage, changeText, deleteWithExtras, textById } from "../sketch/sketchText";
import { insertDxf, insertSummary, parseDxf } from "../sketch/dxf";
import { evaluate } from "../model/expr";
import type { SketchData } from "../sketch/types";

const sketchData = () => useStore.getState().editing?.draft.sketch?.data ?? null;

export function setSketchTool(tool: SketchTool) {
  viewportApi.sketch?.cancel();
  useStore.getState().setSketchTool(tool);
  const st = useStore.getState();
  if (tool === "mirror") st.setSketchMessage("Click the straight line to mirror about (a construction line works well).", "info");
  if (tool === "tangentArc") st.setSketchMessage("Click the end of a line or arc to carry on from.", "info");
  if (tool === "sketchPattern") {
    st.setSketchMessage("Click the lines, arcs and circles to repeat (or keep what's selected), then Make pattern.", "info");
    viewportApi.sketch?.refreshPreview();
  }
  if (tool === "sketchTransform") {
    st.setSketchMessage("Click the lines, arcs and circles to move (or keep what's selected), set how far, then Move.", "info");
    viewportApi.sketch?.refreshPreview();
  }
}

/** Pattern tool's "Make pattern" button: repeat the selected shapes. */
export function makeSketchPattern(): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return false;
  const curves = s.sketch.selection.filter((id) => data.curves.some((c) => c.id === id));
  const opts = readPatternSettings(data, s.sketch);
  const r = typeof opts === "string" ? { sketch: data, error: opts, curveIds: [] } : patternCurves(data, curves, opts);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true, selection: [] });
  const copies = Math.round(s.sketch.patternCount) - 1;
  s.setSketchMessage(`Made ${copies} ${copies === 1 ? "copy" : "copies"}. Click more shapes to make another pattern.`, "info");
  viewportApi.sketch?.refreshPreview();
  return true;
}

/** Move (or copy) the selected shapes by the amounts in the sketch panel. */
export function makeSketchTransform(): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return false;
  const curves = s.sketch.selection.filter((id) => data.curves.some((c) => c.id === id));
  const t = readTransformSettings(s.sketch);
  const r = typeof t === "string" ? { sketch: data, error: t, curveIds: [] } : transformCurves(data, curves, t);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true, selection: s.sketch.moveCopy ? r.curveIds : curves });
  s.setSketchMessage(s.sketch.moveCopy ? "Copied — the copies are selected, to move again." : "Moved. Move again, or Esc to finish.", "info");
  viewportApi.sketch?.refreshPreview();
  return true;
}

/** Change a pattern setting and redraw the preview. */
export function setPatternOption(patch: Parameters<ReturnType<typeof useStore.getState>["setSketchOptions"]>[0]) {
  useStore.getState().setSketchOptions(patch);
  viewportApi.sketch?.refreshPreview();
}

export function applySketchRelation(tool: RelationTool) {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const sel = s.sketch.selection.filter((id) => !data.constraints.some((c) => c.id === id));
  const r = applyRelation(data, tool, sel);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  s.updateSketch(r.sketch, { record: true });
  s.setSketchMessage(`${RELATION_LABELS[tool]} added.`, "info");
}

export function deleteSketchSelection(): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch || s.sketch.selection.length === 0) return false;
  s.updateSketch(deleteWithExtras(data, s.sketch.selection), { record: true, selection: [] });
  s.setSketchMessage(null);
  return true;
}

/** Q: toggle construction on the selection, or for new geometry when nothing is selected. */
export function toggleSketchConstruction() {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const curves = s.sketch.selection.filter((id) => data.curves.some((c) => c.id === id));
  const texts = s.sketch.selection.filter((id) => textById(data, id));
  if (curves.length || texts.length) {
    let next: SketchData = curves.length ? toggleConstruction(data, curves) : data;
    for (const id of texts) next = changeText(next, id, { construction: !textById(data, id)!.construction }).sketch;
    s.updateSketch(next, { record: true });
  } else {
    s.setSketchConstruction(!s.sketch.construction);
  }
}

/** Esc while sketching: drop a half-drawn shape, then leave the tool, then clear the selection. */
export function sketchEscape() {
  const s = useStore.getState();
  if (!s.sketch) return;
  if (s.sketch.provisional.length) {
    s.discardOfferedDimensions();
    return;
  }
  if (s.sketch.editingDimension) {
    s.setEditingDimension(null);
    return;
  }
  if (viewportApi.sketch?.cancel()) return;
  if (s.sketch.tool !== "select") {
    s.setSketchTool("select");
    return;
  }
  s.setSketchSelection([]);
  s.setSketchMessage(null);
}

/** Turn the selected dimension into a reference one (shows the size only), or back into a driving one. */
export function toggleSketchDimensionDriven() {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const id = s.sketch.selection.find((x) => data.constraints.some((c) => c.id === x));
  const c = data.constraints.find((x) => x.id === id);
  if (!c) return;
  const r = setDimensionDriven(data, c.id, !c.driven);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  s.updateSketch(r.sketch, { record: true });
  s.setSketchMessage(c.driven ? "It sets the size again: double-click it to type a new size." : "It just shows the size now (in brackets) and won't change the sketch.", "info");
}

/** Measure the selected distance between circles/arcs (or one and a line) to their centres, nearest edges or furthest edges. */
export function setSketchMeasureTo(to: MeasureTo) {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const id = s.sketch.selection.find((x) => data.constraints.some((c) => c.id === x));
  if (!id) return;
  const r = setMeasureTo(data, id, to);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  if (r.sketch === data) return;
  s.updateSketch(r.sketch, { record: true });
  s.setSketchMessage(to === "centre" ? "Measured between the centres now." : to === "nearest" ? "Measured to the nearest edges now (the gap between them)." : "Measured to the furthest edges now (the overall size).", "info");
}

/** Copy every edge of the face the sketch is on into the sketch (Use), linked so they follow the part. */
export function copyFaceEdges(): boolean {
  const s = useStore.getState();
  const data = sketchData();
  const id = s.editing?.draft.id;
  const edges = id ? s.sketchLinks[id]?.edges : undefined;
  if (!data || !s.sketch || !edges?.length) return false;
  const r = linkAllEdges(data, edges);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true, selection: r.curveIds });
  s.setSketchMessage(`Used ${r.curveIds.length} edge${r.curveIds.length === 1 ? "" : "s"} of the face. They follow the part if it changes.`, "info");
  return true;
}

/** A number typed in the sketch panel (or a sum or variable), or null when it isn't one. */
function typedNumber(text: string | undefined, fallback: number): number | null {
  if (text === undefined || text.trim() === "") return fallback;
  const r = evaluate(text);
  return r.ok && Number.isFinite(r.value) ? r.value : null;
}

/** Insert DXF: read the file and add its drawing to the open sketch. */
export async function insertDxfFile(file: File): Promise<void> {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const scale = typedNumber(s.sketch.dxfScale, 1);
  if (scale === null || !(scale > 0)) {
    s.setSketchMessage("The scale must be a number more than 0 (1 = full size).", "error");
    return;
  }
  let drawing;
  try {
    drawing = parseDxf(await file.text());
  } catch (e) {
    s.setSketchMessage(e instanceof Error ? e.message : "That file couldn't be read.", "error");
    return;
  }
  const now = sketchData();
  if (!now) return;
  const r = insertDxf(now, drawing, scale, useStore.getState().sketch?.construction ?? false);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  useStore.getState().updateSketch(r.sketch, { record: true, selection: r.curveIds });
  useStore.getState().setSketchMessage(`${insertSummary(drawing, r.count, scale)} It's selected: use Move / copy to place it, or Delete to take it out again.`, "info");
}

/** Pictures bigger than this aren't laid on a sketch (they'd make the saved file huge). */
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/** Insert image: lay a picture on the sketch plane to trace over. */
export async function insertImageFile(file: File): Promise<void> {
  const s = useStore.getState();
  if (!sketchData() || !s.sketch) return;
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) {
    s.setSketchMessage("Choose a picture (PNG, JPEG, GIF, WebP or SVG).", "error");
    return;
  }
  if (file.size > MAX_PICTURE_BYTES) {
    s.setSketchMessage("That picture is too big (over 4 MB). Make it smaller and try again — it's only for tracing over.", "error");
    return;
  }
  const src = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  const size = src
    ? await new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 0, height: 0 });
        img.src = src;
      })
    : { width: 0, height: 0 };
  const data = sketchData();
  if (!data || !src) {
    s.setSketchMessage("That picture couldn't be read. Try a PNG or JPEG file.", "error");
    return;
  }
  // Its printed size at 96 dots per inch, kept between 10 and 500 mm.
  const width = Math.max(10, Math.min(500, Math.round((size.width * 25.4) / 96)));
  const r = addImage(data, src, size, width, [0, 0], file.name);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return;
  }
  useStore.getState().updateSketch(r.sketch, { record: true, selection: [r.imageId] });
  useStore.getState().setSketchTool("select");
  useStore.getState().setSketchSelection([r.imageId]);
  useStore.getState().setSketchMessage("Picture added. Drag it to move it; set its width and how see-through it is in the sketch panel. It's only for tracing over — it isn't extruded or saved in exports.", "info");
}

/** Ask for a file (of the kinds in `accept`) and pass it on. */
export function pickFile(accept: string, then: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) then(f);
  };
  input.click();
}
