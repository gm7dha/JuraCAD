/** Actions used by both the sketch toolbar and keyboard shortcuts. */
import { patternGrid, readSecondDirection } from "../sketch/patternGrid";
import { useEditToolOptions } from "../sketch/editToolOptions";
import { editPattern, type PatternChange } from "../sketch/patternEdit";
import { activeFeatures, useStore, type SketchTool } from "../model/store";
import { sketchPlaneRefs } from "../sketch/planeRefsFor";
import { applyRelation, isPlaneCurve, relationMayTakeAWhile, RELATION_LABELS, setDimensionDriven, setMeasureTo, toggleConstruction, type MeasureTo, type RelationTool } from "../sketch/ops";
import { patternCurves, readPatternSettings, readTransformSettings } from "../sketch/tools";
import { readScale, transformCopy, transformSelection } from "../sketch/transformSelection";
import { viewportApi } from "../viewport/Viewport";
import { linkAllEdges, piercePoint, type RefEdge } from "../sketch/links";
import { addImage, changeText, deleteWithExtras, textById } from "../sketch/sketchText";
import { insertDrawingText, tooBig } from "./sketchInsertFile";
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
    st.setSketchMessage("Click the shapes to move (or keep what's picked), then drag the handles on them — the middle moves, the ring turns, the corner square scales — or type amounts and press Move.", "info");
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
  // Linear with a second direction ticked: rows × columns.
  const second = typeof opts !== "string" && opts.kind === "linear" ? readSecondDirection(useEditToolOptions.getState()) : null;
  const r =
    typeof opts === "string"
      ? { sketch: data, error: opts, curveIds: [] }
      : typeof second === "string"
        ? { sketch: data, error: second, curveIds: [] }
        : second
          ? patternGrid(data, curves, opts, second)
          : patternCurves(data, curves, opts);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true, selection: [] });
  const copies = Math.round(s.sketch.patternCount) * (second && typeof second !== "string" ? Math.round(second.count) : 1) - 1;
  s.setSketchMessage(`Made ${copies} ${copies === 1 ? "copy" : "copies"}. Click more shapes to make another pattern.`, "info");
  viewportApi.sketch?.refreshPreview();
  return true;
}

/** Show a pattern's settings in the sketch panel to change them (the menu's Edit pattern…). */
export function openPatternEditor(id: string): void {
  useEditToolOptions.getState().set({ editingPattern: id });
  useStore.getState().setSketchMessage("Change the pattern's count or spacing in the sketch panel, then Apply. Copies already there keep their dimensions and relations.", "info");
}

/** Change a pattern made earlier: its count, spacing (or angle) and second direction. */
export function applyPatternChange(id: string, change: PatternChange): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return false;
  const r = editPattern(data, id, change);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true });
  s.setSketchMessage("Pattern changed.", "info");
  return true;
}

/** Move (or copy) the selected shapes by the amounts in the sketch panel. */
export function makeSketchTransform(): boolean {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return false;
  const picked = s.sketch.selection;
  const t = readTransformSettings(s.sketch);
  const k = readScale(s.sketch.moveScale);
  const motion = typeof t === "string" ? t : typeof k === "string" ? k : { dx: t.dx, dy: t.dy, angle: t.angle, scale: k };
  const none = typeof motion !== "string" && motion.dx === 0 && motion.dy === 0 && motion.angle === 0 && motion.scale === 1;
  const r =
    typeof motion === "string"
      ? { sketch: data, error: motion, ids: [] }
      : none
        ? { sketch: data, error: "Type how far to move, turn or scale them — or drag the handles on them.", ids: [] }
        : (s.sketch.moveCopy ? transformCopy : transformSelection)(data, picked, motion);
  if (r.error) {
    s.setSketchMessage(r.error, "error");
    return false;
  }
  s.updateSketch(r.sketch, { record: true, selection: r.ids });
  s.setSketchMessage(s.sketch.moveCopy ? "Copied — the copies are selected, to move again." : "Moved. Move again, or Esc to finish.", "info");
  viewportApi.sketch?.refreshPreview();
  return true;
}

/** Change a pattern setting and redraw the preview. */
export function setPatternOption(patch: Parameters<ReturnType<typeof useStore.getState>["setSketchOptions"]>[0]) {
  useStore.getState().setSketchOptions(patch);
  viewportApi.sketch?.refreshPreview();
}

/** The open sketch's references: its face's edges, then everything else it can use (as the sketch controller has them). */
function sketchRefs(): RefEdge[] {
  const st = useStore.getState();
  const id = st.editing?.draft.id;
  const edges = (id && st.sketchLinks?.[id]?.edges) || [];
  const candidates = id && st.sketchCandidates?.id === id ? st.sketchCandidates.list : [];
  const plane = (id && st.sketchLinks?.[id]?.plane) || st.editing?.draft.sketch?.plane;
  const planes = id && plane ? sketchPlaneRefs(plane, activeFeatures(st), id, st.builtFrames) : [];
  return [...edges, ...candidates, ...planes];
}

export function applySketchRelation(tool: RelationTool) {
  const s = useStore.getState();
  const data = sketchData();
  if (!data || !s.sketch) return;
  const sel = s.sketch.selection.filter((id) => !data.constraints.some((c) => c.id === id));
  if (tool !== "pierce" && relationMayTakeAWhile(data, tool, sel)) {
    // On a busy sketch with curves this can take a second or two: say so first, and work it out once that's shown.
    s.setSketchMessage("Working…", "info");
    const go = () => {
      const now = useStore.getState();
      // The sketch was closed or changed meanwhile: nothing to do.
      if (sketchData() !== data || !now.sketch) {
        if (now.sketch?.message?.text === "Working…") now.setSketchMessage(`Nothing was changed: the sketch changed while ${RELATION_LABELS[tool].toLowerCase()} was being worked out. Try again.`, "info");
        return;
      }
      finishRelation(tool, applyRelation(data, tool, sel));
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(go, 0));
    else setTimeout(go, 0);
    return;
  }
  // Pierce needs to know where things from outside pass through the sketch (the engine lists those places).
  finishRelation(tool, tool === "pierce" ? piercePoint(data, sel, sketchRefs()) : applyRelation(data, tool, sel));
}

function finishRelation(tool: RelationTool, r: { sketch: SketchData; error?: string }) {
  const s = useStore.getState();
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
  const curves = s.sketch.selection.filter((id) => data.curves.some((c) => c.id === id && !isPlaneCurve(c)));
  const texts = s.sketch.selection.filter((id) => textById(data, id));
  if (!curves.length && !texts.length && s.sketch.selection.some((id) => isPlaneCurve(data.curves.find((c) => c.id === id)))) {
    s.setSketchMessage("A plane's line is a reference: it stays construction, so it can't be made solid.", "info");
    return;
  }
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
    // One Esc also ends a chain of lines (Onshape's): the next click starts a new line.
    viewportApi.sketch?.cancel();
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

/** Insert DXF: read the file and add its drawing to the open sketch. */
export async function insertDxfFile(file: File): Promise<void> {
  await insertDrawingFile("dxf", file);
}

/** Insert SVG: read the file and add its shapes to the open sketch. */
export async function insertSvgFile(file: File): Promise<void> {
  await insertDrawingFile("svg", file);
}

async function insertDrawingFile(kind: "dxf" | "svg", file: File): Promise<void> {
  const s = useStore.getState();
  if (!sketchData() || !s.sketch) return;
  if (tooBig(kind, file.size)) {
    s.setSketchMessage(`That ${kind.toUpperCase()} file is too big to bring in (over 20 MB). Open it in a drawing program and save just the part you need.`, "error");
    return;
  }
  insertDrawingText(kind, await file.text());
}

/** Picture files bigger than this aren't read at all. */
const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
/** Pictures are kept at most this many pixels across (or up). */
const MAX_PICTURE_PIXELS = 1600;

/** A picture made at most MAX_PICTURE_PIXELS across, as a JPEG (on white), when it's bigger than that or over 1 MB. */
async function shrinkPicture(src: string, size: { width: number; height: number }): Promise<string> {
  const big = Math.max(size.width, size.height);
  if (big <= MAX_PICTURE_PIXELS && src.length <= 1.4 * 1024 * 1024) return src;
  const k = Math.min(1, MAX_PICTURE_PIXELS / big);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * k));
  canvas.height = Math.max(1, Math.round(size.height * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = src;
  });
  if (!img) return src;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL("image/jpeg", 0.85);
  return out.length < src.length ? out : src;
}

/** Insert image: lay a picture on the sketch plane to trace over. */
export async function insertImageFile(file: File): Promise<void> {
  const s = useStore.getState();
  if (!sketchData() || !s.sketch) return;
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) {
    s.setSketchMessage("Choose a picture (PNG, JPEG, GIF, WebP or SVG).", "error");
    return;
  }
  if (file.size > MAX_PICTURE_BYTES) {
    s.setSketchMessage("That picture is too big (over 20 MB). Make it smaller and try again — it's only for tracing over.", "error");
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
  // Big pictures are made smaller (it's only for tracing over), so the saved file stays small.
  const shrunk = await shrinkPicture(src, size);
  // Its printed size at 96 dots per inch, kept between 10 and 500 mm.
  const width = Math.max(10, Math.min(500, Math.round((size.width * 25.4) / 96)));
  const r = addImage(data, shrunk, size, width, [0, 0], file.name);
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
