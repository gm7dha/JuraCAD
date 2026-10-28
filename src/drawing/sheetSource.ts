/**
 * What a drawing sheet shows, worked out from the document and the parts as
 * built: the part or assembly drawn (an assembly's parts placed by its mates,
 * spread out when the drawing shows it exploded), what to ask the geometry
 * engine for, the balloons and the title block's details. Pure (no store), so
 * the app's drawing tab and Claude's drawing tools lay sheets out the same way.
 */
import { applyPlacement } from "../assembly/math";
import { findMesh } from "../assembly/configured";
import { solveWithParts } from "../assembly/mates";
import { explodeAssembly, instancesForKernel } from "../assembly/placed";
import { drawingBom } from "../assembly/drawingBom";
import type { InstanceInput, PartMesh, ViewProjection } from "../kernel/protocol";
import type { Drawing, JuraCADDocument, ViewKind } from "../model/types";
import { surfacePointNearCentre } from "./annotations";
import { withDetails } from "./details";
import { projectionKinds } from "./drawing";
import { tapSizes } from "./holeCallouts";
import { breakOutRequests, sectionRequests, viewKey, type BreakOutRequest, type SectionRequest } from "./sections";
import type { BomLine, Projections, SheetInfo } from "./sheet";
import { withShortenings } from "./shorten";

export interface DrawingSubject {
  /** What's drawn: the part's or the assembly's name. */
  name: string;
  /** The part drawn (empty for an assembly). */
  partIds: string[];
  /** An assembly's parts, each in its place. */
  instances?: InstanceInput[];
  /** Changes whenever what's drawn changes (for caching the views). */
  key: unknown[];
}

/** What a drawing shows, ready for the geometry engine (null when its part has gone). */
export function drawingSubject(drawing: Drawing, doc: JuraCADDocument, parts: PartMesh[]): DrawingSubject | null {
  const src = drawing.source;
  if (!src) return null;
  if (src.kind === "part") {
    const part = parts.find((p) => p.id === src.id);
    return part ? { name: part.name, partIds: [part.id], key: [part] } : null;
  }
  const asm = doc.assemblies?.find((a) => a.id === src.id);
  if (!asm) return null;
  // Parts inside sub-assemblies are drawn too, carried along with them (exploded, a sub-assembly moves out as one piece).
  const assemblies = doc.assemblies ?? [];
  const solved = solveWithParts(asm, parts, { assemblies });
  const tops = Object.fromEntries(asm.instances.map((i) => [i.id, solved.placements[i.id] ?? i.placement]));
  const instances = instancesForKernel(asm, parts, assemblies, solved, drawing.exploded ? explodeAssembly(asm, parts, tops, asm.explode ?? 1, assemblies) : tops);
  return { name: asm.name, partIds: [], instances, key: [JSON.stringify(instances), ...instances.map((i) => findMesh(parts, i.partId))] };
}

/** What to ask the geometry engine for one sheet: the views (sections are asked for separately; details come from their host views). */
export interface ProjectionPlan {
  kinds: ViewKind[];
  sections: SectionRequest[];
  breakouts: BreakOutRequest[];
  hidden: boolean;
  tangent: boolean;
}

export function projectionPlan(drawing: Drawing): ProjectionPlan {
  return {
    kinds: projectionKinds(drawing),
    sections: sectionRequests(drawing),
    breakouts: breakOutRequests(drawing),
    hidden: drawing.hiddenLines,
    tangent: drawing.tangentEdges !== false,
  };
}

/** The engine's views by key, with the detail views and shortened views worked out from them. */
export function finishProjections(list: ViewProjection[], drawing: Drawing): Projections {
  const base: Projections = {};
  for (const p of list) base[p.kind] = p;
  return withShortenings(withDetails(base, drawing), drawing);
}

/** A spot on one copy of each listed part, for the balloons to point at. */
export function balloonsFor(bom: BomLine[] | undefined, instances: InstanceInput[] | undefined, parts: PartMesh[]): SheetInfo["balloons"] {
  if (!bom?.length || !instances?.length) return undefined;
  const out: NonNullable<SheetInfo["balloons"]> = [];
  for (const row of bom) {
    // Mirrored copies are their own line ("…~mirrored").
    const mirrored = !!row.partId?.endsWith("~mirrored");
    const partId = mirrored ? row.partId!.slice(0, -"~mirrored".length) : row.partId;
    const inst = instances.find((i) => i.partId === partId && !!i.mirrored === mirrored);
    const mesh = partId ? findMesh(parts, partId) : undefined;
    const local = mesh ? surfacePointNearCentre(mesh.vertices) : null;
    const spot = local && mirrored ? ([-local[0], local[1], local[2]] as typeof local) : local;
    if (inst && spot) out.push({ item: row.item, at: applyPlacement({ position: inst.position, rotation: inst.rotation }, spot) });
  }
  return out;
}

/** Today as the title block shows it, e.g. "14/10/2026". */
export function drawingDate(now = new Date()): string {
  return now.toLocaleDateString("en-GB");
}

/** The title block and tables' details for one sheet of a drawing. */
export function sheetInfo(page: Drawing, doc: JuraCADDocument, parts: PartMesh[], subject: string, instances: InstanceInput[] | undefined, sheetNo: number, sheetCount: number, date = drawingDate()): SheetInfo {
  const bom = drawingBom(page, doc, parts);
  const balloons = balloonsFor(bom, instances, parts);
  return { designName: doc.name, subject, date, bom, balloons, taps: tapSizes(doc, page), ...(sheetCount > 1 ? { sheetNo, sheetCount } : {}) };
}

/** Each view's scale for a sheet scale: its own, or the sheet's. */
export function viewScales(d: Pick<Drawing, "views">, sheetScale: number): (view: string) => number {
  const own = new Map(d.views.filter((v) => v.scale && v.kind !== "detail").map((v) => [viewKey(v), v.scale!]));
  return (view: string) => own.get(view) ?? sheetScale;
}
