/**
 * Clicks while a Boundary surface or Face blend is open (pure): what each adds
 * or takes out. A Boundary surface's clicked part edge or curve feature goes to
 * the direction being picked (U or V; clicked again it comes out); a Face
 * blend's clicked face goes to the side being picked (1 = `picks`, 2 =
 * `blend.side2`).
 */
import type { TopoPick } from "../geometry/topoRef";
import type { BoundaryCurve, BoundaryDef, FaceBlendDef, Feature } from "./types";

const samePick = (a: TopoPick, b: TopoPick) => a.partId === b.partId && JSON.stringify(a.ref) === JSON.stringify(b.ref);
const sameCurve = (a: BoundaryCurve, b: BoundaryCurve) =>
  a.edge && b.edge ? samePick(a.edge, b.edge) : (!!a.curve && a.curve === b.curve) || (!!a.sketch && a.sketch === b.sketch);

/** What a boundary curve click is: a part's edge or a curve feature (sketches are chosen in the dialog). */
export type BoundaryClick = { kind: "edge"; pick: TopoPick } | { kind: "curve"; id: string } | { kind: "sketch"; id: string };

/** The most curves each way. */
export const MOST_EACH_WAY = 2;

/** A curve added to (or, if already there, taken out of) the direction being picked. A string = why not. */
export function boundaryClick(def: BoundaryDef, c: BoundaryClick): BoundaryDef | string {
  const curve: BoundaryCurve = c.kind === "edge" ? { edge: { partId: c.pick.partId, ref: c.pick.ref } } : c.kind === "curve" ? { curve: c.id } : { sketch: c.id };
  if (c.kind === "edge" && c.pick.ref.kind !== "edge") return "Click edges or curves for the boundary (not faces).";
  // Already in either direction: take it out.
  for (const way of ["u", "v"] as const) {
    if (def[way].some((x) => sameCurve(x, curve))) return { ...def, [way]: def[way].filter((x) => !sameCurve(x, curve)) };
  }
  const way = def.picking ?? "u";
  if (def[way].length >= MOST_EACH_WAY) return `There are already two ${way.toUpperCase()} curves (the two opposite sides). Take one out first, or pick ${way === "u" ? "V" : "U"} curves.`;
  return { ...def, [way]: [...def[way], curve] };
}

/** A boundary curve's side condition set (only part edges have a face beside them). */
export function setMatch(def: BoundaryDef, way: "u" | "v", index: number, match: BoundaryCurve["match"]): BoundaryDef {
  const list = def[way].map((c, i) => {
    if (i !== index) return c;
    const { match: _m, ...rest } = c;
    return match && c.edge ? { ...rest, match } : rest;
  });
  return { ...def, [way]: list };
}

/** A face added to (or taken out of) the side being picked. A string = why not. */
export function blendClick(draft: Pick<Feature, "picks" | "blend">, pick: TopoPick): Pick<Feature, "picks" | "blend"> | string {
  if (pick.ref.kind !== "face") return "Click faces for the blend's two sides (not edges).";
  const blend: FaceBlendDef = draft.blend ?? { side2: [] };
  const side1 = draft.picks ?? [];
  const clean: TopoPick = { partId: pick.partId, ref: pick.ref, ...(pick.at ? { at: pick.at } : {}) };
  if (side1.some((p) => samePick(p, pick))) return { picks: side1.filter((p) => !samePick(p, pick)), blend };
  if (blend.side2.some((p) => samePick(p, pick))) return { picks: side1, blend: { ...blend, side2: blend.side2.filter((p) => !samePick(p, pick)) } };
  if (blend.picking === "side2") return { picks: side1, blend: { ...blend, side2: [...blend.side2, clean] } };
  return { picks: [...side1, clean], blend };
}
