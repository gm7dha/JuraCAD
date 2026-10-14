/** Actions used by both the sketch toolbar and keyboard shortcuts. */
import { useStore, type SketchTool } from "../model/store";
import { applyRelation, deleteItems, RELATION_LABELS, toggleConstruction, type RelationTool } from "../sketch/ops";
import { viewportApi } from "../viewport/Viewport";

const sketchData = () => useStore.getState().editing?.draft.sketch?.data ?? null;

export function setSketchTool(tool: SketchTool) {
  viewportApi.sketch?.cancel();
  useStore.getState().setSketchTool(tool);
  if (tool === "mirror") useStore.getState().setSketchMessage("Click the straight line to mirror about (a construction line works well).", "info");
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
