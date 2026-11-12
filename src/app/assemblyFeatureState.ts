/**
 * The app's side of assembly features and Edit in context (the pure rules are
 * src/assembly/assemblyFeatures.ts and inContext.ts):
 *
 * - `useAsmFeatures`: what the 3D view shows of the assembly on show — each
 *   copy its own features cut (asked of the geometry worker, `assemblyCuts`,
 *   whenever the assembly or its parts change; never while a part is dragged),
 *   which copies lost material (the parts list says "modified in assembly")
 *   and each feature's problem; the dialog that makes a Hole or a Cut.
 * - context parts (Edit in context): the meshes of the other assembly parts
 *   shown in each Part Studio, kept from each rebuild (`keepContextParts`, the
 *   Part Studios not rebuilt keeping theirs, as the store does with parts).
 * - the actions (`editInContext`, `updateContextNow`, …), each one undo step
 *   through the store's `changeDocument`.
 */
import { create } from "zustand";
import { useEffect, useMemo } from "react";

import { addAssemblyFeatures, assemblyExtrudeCut, assemblyFeaturesOf, assemblyHole, assemblySketch, deleteAssemblyFeatures, setFeatureParts } from "../assembly/assemblyFeatures";
import { updateAssembly } from "../assembly/assembly";
import { contextPartOf, removeContext, setContextHidden, takeContext, updateContext } from "../assembly/inContext";
import { instancesForKernel } from "../assembly/placed";
import type { Placement } from "../assembly/math";
import { getKernel } from "../kernel/connect";
import type { AssemblyCutsResult, PartMesh } from "../kernel/protocol";
import { activeAssembly, activeStudioId, useStore } from "../model/store";
import type { Assembly, EditContext } from "../model/types";
import { addCircle, addPoint, addRectangle } from "../sketch/ops";
import type { SketchPlane } from "../sketch/planes";
import { emptySketch, type SketchData } from "../sketch/types";
import { useSolvedAssembly } from "./assemblySolve";

/** What the Hole / Cut dialog is making (null = closed). */
export interface AsmCutDraft {
  kind: "hole" | "cut";
  /** The face clicked (in the assembly's coordinates), once one is. */
  plane: SketchPlane | null;
  label: string;
  /** Where the holes go (hole) or the shapes' middles (cut), in the face's own x, y. */
  points: [number, number][];
  diameter: number;
  /** A cut's shape: a rectangle `width` × `height` or a circle `diameter` across, centred on each point. */
  shape: "rectangle" | "circle";
  width: number;
  height: number;
  throughAll: boolean;
  depth: number;
  flip: boolean;
  /** The copies to cut (keys); null = every top-level part it reaches. */
  parts: string[] | null;
}

interface AsmFeatureState {
  /** The assembly the cut meshes are for, and what the worker said. */
  cuts: { assembly: Assembly; result: AssemblyCutsResult } | null;
  /** Edit in context: the context parts of each Part Studio, from the latest rebuilds. */
  contextParts: PartMesh[];
  draft: AsmCutDraft | null;
}

export const useAsmFeatures = create<AsmFeatureState>(() => ({ cuts: null, contextParts: [], draft: null }));

const NO_MESHES: PartMesh[] = [];
const NO_CUT_MESHES: Record<string, PartMesh> = {};
const NO_KEYS: ReadonlySet<string> = new Set();

/** After a rebuild: the context parts of the Part Studios rebuilt, the others' kept. */
export function keepContextParts(built: PartMesh[] | undefined, rebuilt: string[] | undefined, order: string[] | undefined): void {
  const was = useAsmFeatures.getState().contextParts;
  const fresh = built ?? NO_MESHES;
  const next = rebuilt && order ? [...order.flatMap((id) => (rebuilt.includes(id) ? fresh.filter((p) => p.studioId === id) : was.filter((p) => p.studioId === id)))] : fresh;
  if (next.length === 0 && was.length === 0) return;
  useAsmFeatures.setState({ contextParts: next });
}

/** The context parts to draw in the Part Studio on show (those of contexts not hidden), the same array while nothing changes. */
let shownCache: { all: PartMesh[]; contexts: EditContext[] | undefined; studio: string | null; out: PartMesh[] } | null = null;
export function useShownContextParts(): PartMesh[] {
  const all = useAsmFeatures((s) => s.contextParts);
  const contexts = useStore((s) => s.history.present.contexts);
  const studio = useStore(activeStudioId);
  const inAssembly = useStore((s) => !!activeAssembly(s));
  if (inAssembly || !all.length || !contexts?.length) return NO_MESHES;
  if (shownCache && shownCache.all === all && shownCache.contexts === contexts && shownCache.studio === studio) return shownCache.out;
  const out = all.filter((p) => {
    const at = contextPartOf(p.id);
    const c = at ? contexts.find((x) => x.id === at.context) : undefined;
    return p.studioId === studio && !!c && !c.hidden;
  });
  shownCache = { all, contexts, studio, out: out.length ? out : NO_MESHES };
  return shownCache.out;
}

/**
 * Keeps the cut copies of the assembly on show up to date (called by the 3D view):
 * asks the worker once the assembly, its parts or where they're solved change.
 */
export function useAssemblyCuts(): { meshes: Record<string, PartMesh>; modified: ReadonlySet<string> } {
  const { assembly, solved } = useSolvedAssembly();
  const parts = useStore((s) => s.parts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  const dragging = useStore((s) => !!s.dragPreview);
  const cuts = useAsmFeatures((s) => s.cuts);
  useEffect(() => {
    if (!assembly || !assembly.features?.length || !solved || dragging) {
      if (!assembly?.features?.length && useAsmFeatures.getState().cuts) useAsmFeatures.setState({ cuts: null });
      return;
    }
    let live = true;
    const inputs = instancesForKernel(assembly, parts, assemblies ?? [], solved);
    const kernel = getKernel();
    kernel
      .whenIdle()
      .then(() => kernel.assemblyCuts(inputs))
      .then(
        (result) => {
          if (live) useAsmFeatures.setState({ cuts: { assembly, result } });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [assembly, parts, assemblies, solved, dragging]);
  return useMemo(() => {
    if (!assembly || !cuts || cuts.assembly.id !== assembly.id || !assembly.features?.length) return { meshes: NO_CUT_MESHES, modified: NO_KEYS };
    return { meshes: Object.fromEntries(cuts.result.meshes.map((m) => [m.id, m])), modified: new Set(cuts.result.cut) };
  }, [assembly, cuts]);
}

/** The copies the assembly on show's own features cut (for the parts list), as last worked out. */
export function useModifiedCopies(): ReadonlySet<string> {
  const assembly = useStore(activeAssembly);
  const cuts = useAsmFeatures((s) => s.cuts);
  return useMemo(() => (assembly?.features?.length && cuts && cuts.assembly.id === assembly.id ? new Set(cuts.result.cut) : NO_KEYS), [assembly, cuts]);
}

/** A cut copy's mesh as shown (its faces are what a click in the view names), if it's cut. */
export function cutMeshFor(key: string): PartMesh | undefined {
  const c = useAsmFeatures.getState().cuts;
  const asm = activeAssembly(useStore.getState());
  if (!c || !asm || c.assembly.id !== asm.id) return undefined;
  return c.result.meshes.find((m) => m.id === key);
}

// ---------------------------------------------------------------------------
// The Hole / Cut dialog

export function startAsmCut(kind: "hole" | "cut"): void {
  useAsmFeatures.setState({
    draft: { kind, plane: null, label: "", points: [], diameter: kind === "hole" ? 5 : 10, shape: "rectangle", width: 10, height: 10, throughAll: true, depth: 5, flip: false, parts: null },
  });
}

export const changeAsmCut = (patch: Partial<AsmCutDraft>): void => {
  const d = useAsmFeatures.getState().draft;
  if (d) useAsmFeatures.setState({ draft: { ...d, ...patch } });
};

export const cancelAsmCut = (): void => useAsmFeatures.setState({ draft: null });

/** The sketch a draft makes: points for holes, rectangles or circles centred on them for a cut. */
export function draftSketch(d: AsmCutDraft): SketchData {
  let data = emptySketch();
  for (const [x, y] of d.points) {
    if (d.kind === "hole") data = addPoint(data, { x, y }).sketch;
    else if (d.shape === "circle") data = addCircle(data, { x, y }, d.diameter / 2).sketch;
    else data = addRectangle(data, { x: x - d.width / 2, y: y - d.height / 2 }, { x: x + d.width / 2, y: y + d.height / 2 }).sketch;
  }
  return data;
}

/** Accept: the sketch and its Hole / Extrude go at the end of the assembly's features (one undo step). */
export function acceptAsmCut(): string | null {
  const d = useAsmFeatures.getState().draft;
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!d || !asm) return null;
  if (!d.plane) return "Click a flat face of a part first: that's where it's drawn.";
  if (!d.points.length) return d.kind === "hole" ? "Click on the face where each hole goes." : "Click on the face where the cut goes.";
  if (d.kind === "hole" && !(d.diameter > 0)) return "The diameter must be more than 0.";
  if (!d.throughAll && !(d.depth > 0)) return "The depth must be more than 0 (or tick Through all).";
  const sketch = assemblySketch(asm, d.plane, draftSketch(d));
  const list = { features: [...assemblyFeaturesOf(asm), sketch] };
  const tool =
    d.kind === "hole"
      ? assemblyHole(list, sketch.id, { diameter: d.diameter, throughAll: d.throughAll, depth: d.throughAll ? undefined : d.depth, flip: d.flip })
      : assemblyExtrudeCut(list, sketch.id, { throughAll: d.throughAll, depth: d.throughAll ? undefined : d.depth, flip: d.flip });
  s.changeDocument((doc) => addAssemblyFeatures(doc, asm.id, [sketch, tool], d.parts ? { [tool.id]: d.parts } : undefined));
  useAsmFeatures.setState({ draft: null });
  return null;
}

/** Delete assembly features (a sketch takes its holes and cuts with it). */
export function deleteAsmFeatures(ids: string[]): void {
  const asm = activeAssembly(useStore.getState());
  if (asm) useStore.getState().changeDocument((doc) => updateAssembly(doc, asm.id, (a) => deleteAssemblyFeatures(a, ids)));
}

export function toggleAsmFeatureSuppressed(id: string): void {
  const asm = activeAssembly(useStore.getState());
  if (!asm) return;
  useStore.getState().changeDocument((doc) => updateAssembly(doc, asm.id, (a) => ({ ...a, features: assemblyFeaturesOf(a).map((f) => (f.id === id ? { ...f, suppressed: !f.suppressed } : f)) })));
}

/** Which copies a feature cuts (null = every top-level part it reaches). */
export function setAsmFeatureParts(id: string, keys: string[] | null): void {
  const asm = activeAssembly(useStore.getState());
  if (asm) useStore.getState().changeDocument((doc) => updateAssembly(doc, asm.id, (a) => setFeatureParts(a, id, keys)));
}

// ---------------------------------------------------------------------------
// Edit in context

/** Right-click › Edit in context: take (or take again) the context and open the part's Part Studio. */
export function editInContext(key: string, places?: Record<string, Placement>): void {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm) return;
  const r = takeContext(s.history.present, asm.id, key, s.parts, places);
  if ("error" in r) {
    s.showToast(r.error, "error");
    return;
  }
  if (r.doc !== s.history.present) s.changeDocument(() => r.doc);
  s.setActiveTab(r.context.studioId);
  const n = r.context.parts.length;
  s.showToast(
    n
      ? `Editing in the context of ${r.context.name}: the other ${n === 1 ? "part is" : `${n} parts are`} shown faint, to sketch on and use edges from.`
      : `Editing in the context of ${r.context.name} — but its other parts are all in this Part Studio already, so none are added.`,
    "info",
  );
}

/** "Update context": where the parts are in the assembly now. */
export function updateContextNow(id: string): void {
  const s = useStore.getState();
  const r = updateContext(s.history.present, id, s.parts);
  if ("error" in r) {
    s.showToast(r.error, "error");
    return;
  }
  if (r.doc === s.history.present) s.showToast("Nothing has moved since: the context is up to date.", "info");
  else s.changeDocument(() => r.doc);
}

export function hideContext(id: string, hidden: boolean): void {
  useStore.getState().changeDocument((doc) => setContextHidden(doc, id, hidden));
}

export function forgetContext(id: string): void {
  useStore.getState().changeDocument((doc) => removeContext(doc, id));
}
