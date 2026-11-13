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

import {
  addAssemblyFeatures,
  assemblyEdgeFeature,
  assemblyExtrudeCut,
  assemblyFeaturesOf,
  assemblyHole,
  assemblySketch,
  deleteAssemblyFeatures,
  edgeNeeds,
  hasRef,
  modifiedCopies,
  setFeatureNeeds,
  storedEdgePicks,
  setFeatureParts,
} from "../assembly/assemblyFeatures";
import { findMesh, meshIdOf } from "../assembly/configured";
import { leavesOf } from "../assembly/subassembly";
import type { TopoPick } from "../geometry/topoRef";
import { settlePlacements, updateAssembly } from "../assembly/assembly";
import { contextGone, contextPartOf, removeContext, setContextHidden, takeContext, updateContext } from "../assembly/inContext";
import { cutMeshesFrom, hasAssemblyFeatures, instancesForKernel, storedCutInputs } from "../assembly/placed";
import { compose, type Placement } from "../assembly/math";
import { getKernel } from "../kernel/connect";
import type { AssemblyCutsResult, PartMesh } from "../kernel/protocol";
import { activeAssembly, activeStudioId, useStore } from "../model/store";
import type { Assembly, EditContext } from "../model/types";
import { addCircle, addPoint, addRectangle } from "../sketch/ops";
import type { SketchPlane } from "../sketch/planes";
import { emptySketch, type SketchData } from "../sketch/types";
import { useSolvedAssembly } from "./assemblySolve";
import { settleCutCopiesIn } from "../assembly/cutSettle";
import { carryCutMeshesOver, rememberCutMeshes, solveWithParts, type CutMeshes } from "../assembly/mates";

/** What the Hole / Cut dialog is making (null = closed). */
export interface AsmCutDraft {
  /** A Fillet / Chamfer rounds `edges` by `size`; a Hole / Cut uses the rest. */
  kind: "hole" | "cut" | "fillet" | "chamfer";
  /** A Fillet / Chamfer's edges clicked (partId = the copy's key, the edge in the part's own coordinates). */
  edges: TopoPick[];
  /** A Fillet's radius or a Chamfer's distance (mm). */
  size: number;
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
  /**
   * The mate solver's cut copies (each assembly's own copies cut by its own features, where the document has them —
   * see storedCutInputs), for the document's assemblies and the parts as they were when the worker cut them.
   */
  solverCuts: { assemblies: readonly Assembly[]; parts: readonly PartMesh[]; cuts: CutMeshes; signature: string } | null;
}

export const useAsmFeatures = create<AsmFeatureState>(() => ({ cuts: null, contextParts: [], draft: null, solverCuts: null }));

/** The solver's cut copies for the document now (the latest worked out while new ones are on their way). */
export function solverCutsNow(): CutMeshes | undefined {
  return useAsmFeatures.getState().solverCuts?.cuts;
}

/** What `storedCutInputs` gives for a state, worked out once (compared to decide whether the latest copies still hold). */
const signatures = new WeakMap<readonly Assembly[], WeakMap<readonly PartMesh[], string>>();
function signatureOf(assemblies: readonly Assembly[], parts: readonly PartMesh[]): string {
  let byParts = signatures.get(assemblies);
  if (!byParts) signatures.set(assemblies, (byParts = new WeakMap()));
  let sig = byParts.get(parts);
  if (sig === undefined) byParts.set(parts, (sig = JSON.stringify(storedCutInputs(assemblies, parts))));
  return sig;
}

// A state the worker hasn't cut yet (every edit makes a new assemblies array) is solved with the latest copies — kept
// for it when it would be cut exactly the same — so nothing jumps while the worker works.
carryCutMeshesOver((assemblies, parts) => {
  const was = useAsmFeatures.getState().solverCuts;
  if (!was || !assemblies.some((a) => a.features?.length)) return undefined;
  return { cuts: was.cuts, same: was.parts === parts && signatureOf(assemblies, parts) === was.signature };
});

/** The parts the drilled copies were last settled for (once per rebuild, never again for the same parts). */
let settledFor: readonly PartMesh[] | null = null;

/**
 * After a rebuild, drilled copies a Part Studio change moved (the base a plate is fastened to made wider) are stored
 * where the solve now puts them (settleCutCopies), without an undo step of their own — so the solver's copies are cut
 * where they're shown, and a pin mated into a hole stays in the hole shown. Once per set of parts: the settle changes
 * the assemblies, not the parts, so it never runs again for its own change.
 */
function settleAfterRebuild(list: readonly Assembly[], parts: readonly PartMesh[], cuts: CutMeshes): void {
  if (settledFor === parts) return;
  const s = useStore.getState();
  // (Not now — an old version on show, a drag, or the design changed meanwhile: the next answer for these parts settles.)
  if (s.versionView || s.dragPreview || s.history.present.assemblies !== list) return;
  settledFor = parts;
  const next = settleCutCopiesIn(s.history.present, parts, cuts);
  if (next !== s.history.present) s.changeVersions(() => next);
}

/**
 * Keeps the mate solver's cut copies up to date: whenever the document's assemblies or the parts change, the worker
 * cuts each assembly's copies where the document has them. They depend on the document alone (never on a solve), so
 * a mate on a drilled hole settles at once.
 */
function useSolverCuts(): void {
  const parts = useStore((s) => s.parts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  const dragging = useStore((s) => !!s.dragPreview);
  useEffect(() => {
    if (dragging) return;
    const list = assemblies ?? [];
    const inputs = list.some((a) => a.features?.length) ? storedCutInputs(list, parts) : [];
    if (!inputs.length) {
      if (useAsmFeatures.getState().solverCuts) useAsmFeatures.setState({ solverCuts: null });
      return;
    }
    const signature = signatureOf(list, parts);
    const was = useAsmFeatures.getState().solverCuts;
    if (was && was.signature === signature && was.parts === parts) {
      // (The same copies to cut: kept, said for the new assemblies too.)
      if (was.assemblies !== list) {
        rememberCutMeshes(list, parts, was.cuts);
        useAsmFeatures.setState({ solverCuts: { ...was, assemblies: list } });
      }
      return;
    }
    let live = true;
    const kernel = getKernel();
    kernel
      .whenIdle()
      .then(() => kernel.assemblyCuts(inputs))
      .then(
        (result) => {
          if (!live) return;
          const cuts = cutMeshesFrom(result.meshes);
          rememberCutMeshes(list, parts, cuts);
          useAsmFeatures.setState({ solverCuts: { assemblies: list, parts, cuts, signature } });
          settleAfterRebuild(list, parts, cuts);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [parts, assemblies, dragging]);
}

const NO_MESHES: PartMesh[] = [];
const NO_CUT_MESHES: Record<string, PartMesh> = {};
const NO_KEYS: ReadonlyMap<string, number | undefined> = new Map();

/** After a rebuild: the context parts of the Part Studios placed again (`changed`), the others' kept. */
export function keepContextParts(built: PartMesh[] | undefined, changed: string[] | undefined, order: string[] | undefined): void {
  const was = useAsmFeatures.getState().contextParts;
  if (!changed?.length && (!order || was.every((p) => order.includes(p.studioId ?? "")))) return;
  const fresh = built ?? NO_MESHES;
  const keep = was.filter((p) => !changed?.includes(p.studioId ?? "") && (!order || order.includes(p.studioId ?? "")));
  const next = [...keep, ...fresh];
  if (next.length === 0 && was.length === 0) return;
  useAsmFeatures.setState({ contextParts: next.length ? next : NO_MESHES });
}

/** The context parts to draw in the Part Studio on show (those of contexts not hidden), the same array while nothing changes. */
let shownCache: { all: PartMesh[]; contexts: EditContext[] | undefined; assemblies: Assembly[] | undefined; studio: string | null; out: PartMesh[] } | null = null;
export function useShownContextParts(): PartMesh[] {
  const all = useAsmFeatures((s) => s.contextParts);
  const contexts = useStore((s) => s.history.present.contexts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  const studio = useStore(activeStudioId);
  const inAssembly = useStore((s) => !!activeAssembly(s));
  if (inAssembly || !all.length || !contexts?.length) return NO_MESHES;
  if (shownCache && shownCache.all === all && shownCache.contexts === contexts && shownCache.assemblies === assemblies && shownCache.studio === studio) return shownCache.out;
  const out = all.filter((p) => {
    const at = contextPartOf(p.id);
    const c = at ? contexts.find((x) => x.id === at.context) : undefined;
    return p.studioId === studio && !!c && !c.hidden && !contextGone({ assemblies }, c);
  });
  shownCache = { all, contexts, assemblies, studio, out: out.length ? out : NO_MESHES };
  return shownCache.out;
}

/**
 * Keeps the cut copies of the assembly on show up to date (called by the 3D view):
 * asks the worker once the assembly, its parts or where they're solved change.
 */
export function useAssemblyCuts(): { meshes: Record<string, PartMesh>; modified: ReadonlyMap<string, number | undefined> } {
  const { assembly, solved } = useSolvedAssembly();
  const parts = useStore((s) => s.parts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  const dragging = useStore((s) => !!s.dragPreview);
  const cuts = useAsmFeatures((s) => s.cuts);
  const any = !!assembly && hasAssemblyFeatures(assembly, assemblies ?? []);
  useSolverCuts();
  useEffect(() => {
    if (!assembly || !any || !solved || dragging) {
      if (!any && useAsmFeatures.getState().cuts) useAsmFeatures.setState({ cuts: null });
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
          if (!live) return;
          // The same cuts as before: kept as they were, so the view isn't drawn again for nothing.
          const was = useAsmFeatures.getState().cuts;
          if (was && was.assembly.id === assembly.id && cutsSignature(was.result) === cutsSignature(result)) {
            if (was.assembly !== assembly) useAsmFeatures.setState({ cuts: { assembly, result: was.result } });
            return;
          }
          useAsmFeatures.setState({ cuts: { assembly, result } });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [assembly, any, parts, assemblies, solved, dragging]);
  return useMemo(() => {
    if (!assembly || !cuts || cuts.assembly.id !== assembly.id || !any) return { meshes: NO_CUT_MESHES, modified: NO_KEYS };
    return { meshes: cutMeshMap(cuts.result), modified: modifiedCopies(cuts.result) };
  }, [assembly, cuts, any]);
}

/** What decides whether two answers from the worker are the same cuts (which copies, how much is left, their faces). */
function cutsSignature(r: AssemblyCutsResult): string {
  return JSON.stringify([r.cut, r.errors, r.reached, r.meshes.map((m) => [m.id, m.volume, m.faceRefs, m.edgeRefs.length])]);
}

/** The cut copies' meshes by key (the same object for the same answer). */
const meshMaps = new WeakMap<AssemblyCutsResult, Record<string, PartMesh>>();
export function cutMeshMap(r: AssemblyCutsResult): Record<string, PartMesh> {
  let m = meshMaps.get(r);
  if (!m) meshMaps.set(r, (m = Object.fromEntries(r.meshes.map((x) => [x.id, x]))));
  return m;
}

/** The copies the assembly on show's own features cut (for the parts list), as last worked out. */
export function useModifiedCopies(): ReadonlyMap<string, number | undefined> {
  const assembly = useStore(activeAssembly);
  const cuts = useAsmFeatures((s) => s.cuts);
  return useMemo(() => (cuts && assembly && cuts.assembly.id === assembly.id && cuts.result.cut.length ? modifiedCopies(cuts.result) : NO_KEYS), [assembly, cuts]);
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

export function startAsmCut(kind: AsmCutDraft["kind"]): void {
  useAsmFeatures.setState({
    draft: {
      kind,
      edges: [],
      size: kind === "chamfer" ? 1 : 2,
      plane: null,
      label: "",
      points: [],
      diameter: kind === "hole" ? 5 : 10,
      shape: "rectangle",
      width: 10,
      height: 10,
      throughAll: true,
      depth: 5,
      flip: false,
      parts: null,
    },
  });
}

/** A Fillet / Chamfer's edge clicked on copy `key` (`ref` in the part's own coordinates): added, or taken out again. */
export function toggleAsmEdge(key: string, ref: TopoPick["ref"]): void {
  const d = useAsmFeatures.getState().draft;
  if (!d) return;
  const same = (p: TopoPick) => p.partId === key && JSON.stringify(p.ref) === JSON.stringify(ref);
  changeAsmCut({ edges: d.edges.some(same) ? d.edges.filter((p) => !same(p)) : [...d.edges, { partId: key, ref }] });
}

/**
 * Accept a Fillet / Chamfer: added at the end of the assembly's features (one undo step) if the worker can make it.
 * Edges only the assembly's own cuts made (a drilled hole's rim) are noted, so deleting that cut takes it with it.
 */
async function acceptAsmEdges(d: AsmCutDraft, asm: Assembly): Promise<string | null> {
  if (d.kind !== "fillet" && d.kind !== "chamfer") return null;
  if (!d.edges.length) return "Click the edges to round first.";
  if (!(d.size > 0)) return d.kind === "fillet" ? "The radius must be more than 0." : "The distance must be more than 0.";
  const s = useStore.getState();
  const before = s.history.present.assemblies ?? [];
  const solved = solveWithParts(asm, s.parts, { assemblies: before });
  const leavesNow = leavesOf(asm, s.parts, before);
  const plainOf = (key: string) => {
    const leaf = leavesNow.find((l) => l.key === key);
    return leaf ? findMesh(s.parts, meshIdOf(leaf.instance)) : undefined;
  };
  const placeOf = (key: string) => {
    const leaf = leavesNow.find((l) => l.key === key);
    if (!leaf) return undefined;
    const top = solved.placements[leaf.top] ?? asm.instances.find((i) => i.id === leaf.top)!.placement;
    return { at: leaf.path.length ? compose(top, leaf.relative) : top, mirrored: !!leaf.instance.mirrored };
  };
  // Edges of the part itself go with the copy; a hole's rim the assembly drilled stays with the hole (storedEdgePicks).
  const tool = assemblyEdgeFeature(asm, d.kind, storedEdgePicks(d.edges, plainOf, placeOf), { size: d.size });
  const trial = addAssemblyFeatures(s.history.present, asm.id, [tool]);
  const made = trial.assemblies?.find((a) => a.id === asm.id);
  if (!made) return null;
  const assemblies = trial.assemblies ?? [];
  let needs: string[];
  try {
    const kernel = getKernel();
    const r = await kernel.assemblyCuts(instancesForKernel(made, s.parts, assemblies, solved));
    if (r.errors[tool.id]) return r.errors[tool.id];
    if (!r.reached[tool.id]?.length) return "It wouldn't change anything: click edges of the parts.";
    // The feature each edge only the assembly made comes from: the copy made without it hasn't got the edge.
    const own = new Set(assemblyFeaturesOf(asm).map((f) => f.id));
    const earlier = Object.fromEntries(Object.entries(r.reached).filter(([id]) => own.has(id)));
    const keys = [...new Set(d.edges.map((p) => p.partId))];
    const without = new Map<string, Record<string, PartMesh>>();
    for (const p of d.edges) {
      const plain = plainOf(p.partId);
      if (!plain || hasRef(plain, p.ref)) continue;
      for (const [id, reached] of Object.entries(earlier)) {
        if (without.has(id) || !reached.includes(p.partId)) continue;
        const off = { ...asm, features: assemblyFeaturesOf(asm).map((f) => (f.id === id ? { ...f, suppressed: true } : f)) };
        const inputs = instancesForKernel(off, s.parts, before.map((x) => (x.id === asm.id ? off : x)), solved).filter((i) => keys.includes(i.id));
        const cut = await kernel.assemblyCuts(inputs);
        without.set(id, Object.fromEntries(cut.meshes.map((m) => [m.id, m])));
      }
    }
    needs = edgeNeeds(d.edges, plainOf, earlier, (id, key) => without.get(id)?.[key]);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  useStore.getState().changeDocument((doc) => updateAssembly(addAssemblyFeatures(settlePlacements(doc, asm.id, solved.placements), asm.id, [tool]), asm.id, (a) => setFeatureNeeds(a, tool.id, needs)));
  useAsmFeatures.setState({ draft: null });
  return null;
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

/**
 * Accept: the sketch and its Hole / Extrude go at the end of the assembly's features (one undo step). Unless parts
 * were chosen, it cuts the parts it reaches now (kept as its list, as Onshape lists them: a bolt mated into the hole
 * later isn't drilled too). Resolves to a problem in plain words, or null.
 */
export async function acceptAsmCut(): Promise<string | null> {
  const d = useAsmFeatures.getState().draft;
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!d || !asm) return null;
  if (d.kind === "fillet" || d.kind === "chamfer") return acceptAsmEdges(d, asm);
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
  const trial = addAssemblyFeatures(s.history.present, asm.id, [sketch, tool], d.parts ? { [tool.id]: d.parts } : undefined);
  const made = trial.assemblies?.find((a) => a.id === asm.id);
  if (!made) return null;
  let reached: string[] = [];
  const solved = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
  try {
    const assemblies = trial.assemblies ?? [];
    const r = await getKernel().assemblyCuts(instancesForKernel(made, s.parts, assemblies, solved));
    if (r.errors[tool.id]) return r.errors[tool.id];
    reached = r.reached[tool.id] ?? [];
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (!reached.length) return `It wouldn't cut anything from there. Check where you clicked${d.throughAll ? "" : ", or tick Through all or Flip direction"}.`;
  // (The assembly may have changed while the worker was cutting: added to the latest one.)
  // The parts are kept where they're shown, which is where the feature cuts them (the mate solver's cut copies are made
  // with the parts where the document has them).
  useStore.getState().changeDocument((doc) => addAssemblyFeatures(settlePlacements(doc, asm.id, solved.placements), asm.id, [sketch, tool], { [tool.id]: d.parts ?? reached }));
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
export function setAsmFeatureParts(id: string, keys: string[]): void {
  const asm = activeAssembly(useStore.getState());
  if (asm) useStore.getState().changeDocument((doc) => updateAssembly(doc, asm.id, (a) => setFeatureParts(a, id, keys)));
}

/**
 * "The parts it reaches now": every top-level copy tried once, and the ones it really cuts kept as its list (as
 * Accept does) — so a part mated into the hole later isn't drilled too. Returns a problem to show, or null.
 */
export async function reachNow(id: string): Promise<string | null> {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm) return null;
  const assemblies = s.history.present.assemblies ?? [];
  const trial = setFeatureParts(asm, id, null);
  let reached: string[];
  try {
    const solved = solveWithParts(asm, s.parts, { assemblies });
    const r = await getKernel().assemblyCuts(instancesForKernel(trial, s.parts, assemblies.map((a) => (a.id === asm.id ? trial : a)), solved));
    if (r.errors[id] && !r.reached[id]?.length) return r.errors[id];
    reached = r.reached[id] ?? [];
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (!reached.length) return "It doesn't cut any part from where it is now.";
  setAsmFeatureParts(id, reached);
  return null;
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
