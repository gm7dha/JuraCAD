/**
 * Parts list sums for the app and drawings, kept out of React so they can be tested:
 * each part's volume and material, and an assembly drawing's parts list.
 */
import type { PartMesh } from "../kernel/protocol";
import type { BomLine } from "../drawing/sheet";
import type { Drawing, JuraCADDocument } from "../model/types";
import { formatMass } from "../model/materials";
import { billOfMaterials, meshVolume, type BomInfo } from "./assembly";
import { findMesh, meshIdOf } from "./configured";

/** Volume of each part (mm³; null for a surface): exact from the engine, else from its display mesh; worked out once per rebuild. */
const volumeCache = new WeakMap<PartMesh, number | null>();
export function partVolume(p: PartMesh): number | null {
  if (!volumeCache.has(p)) volumeCache.set(p, p.surface ? null : p.volume ?? meshVolume(p.vertices, p.triangles));
  return volumeCache.get(p) ?? null;
}

/** Material and volume of the part each instance shows, for the parts list. */
export function bomInfo(parts: PartMesh[], materials: Record<string, string> | undefined): BomInfo {
  return (i) => {
    const mesh = findMesh(parts, meshIdOf(i));
    return mesh ? { material: materials?.[i.partId], volume: partVolume(mesh) } : null;
  };
}

/**
 * The parts list for an assembly drawing (none for a part): with each part's
 * number and description when it has them, and its weight only when the
 * drawing asks for weights ("Show weights in the parts list").
 */
export function drawingBom(drawing: Pick<Drawing, "source" | "bomWeights">, doc: JuraCADDocument, parts: PartMesh[]): BomLine[] | undefined {
  if (drawing.source?.kind !== "assembly") return undefined;
  const asm = doc.assemblies?.find((a) => a.id === drawing.source!.id);
  if (!asm) return undefined;
  const names = Object.fromEntries(parts.map((p) => [p.id, p.name]));
  const configurations = Object.fromEntries((doc.configurations ?? []).map((c) => [c.id, c.name]));
  return billOfMaterials(asm, names, configurations, drawing.bomWeights ? bomInfo(parts, doc.materials) : undefined, doc.partProperties).map((r, i) => ({
    item: i + 1,
    name: r.name,
    quantity: r.quantity,
    partId: r.partId,
    ...(r.properties?.number ? { number: r.properties.number } : {}),
    ...(r.properties?.description ? { description: r.properties.description } : {}),
    ...(r.massEach !== undefined ? { weight: formatMass(r.massEach) } : {}),
  }));
}
