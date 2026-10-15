/** Actions used by both the sketch toolbar and keyboard shortcuts. */
import { useStore, type SketchTool } from "../model/store";
import { applyRelation, deleteItems, RELATION_LABELS, toggleConstruction, type RelationTool } from "../sketch/ops";
import { patternCurves, readPatternSettings, readTransformSettings, transformCurves } from "../sketch/tools";
import { viewportApi } from "../viewport/Viewport";

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
  s.updateSketch(deleteItems(data, s.sketch.selection), { record: true, selection: [] });
  s.setSketchMessage(null);
  return true;
}

/** Q: toggle construction on the selection, or for new geometry when nothing is selected. */
export function toggleSketchConstruction() {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const curves = s.sketch.selection.filter((id) => data.curves.some((c) => c.id === id));
  if (curves.length) {
    s.updateSketch(toggleConstruction(data, curves), { record: true });
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
