/**
 * What a click in the 3D view does to an open curve feature (Helix, Projected, Bridging, Composite, Fit spline,
 * Intersection) or to a Sweep / Curve pattern's path (pure): the change to make, or a message saying what to click.
 */
import type { TopoPick } from "../geometry/topoRef";
import { lineFromClick, pointFromClick, type GeomClick } from "./geomClicks";
import { tidyVec } from "./transformPicks";
import type { CurveDef, Feature, GeomPick } from "./types";

type Vec3 = [number, number, number];

/** A click, as curve features take it: geomClicks' kinds, or a curve feature (its drawn points). */
export type CurveClick = GeomClick | { kind: "curve"; id: string; at: Vec3; points: Vec3[] };

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A point on a clicked curve feature: its nearer end when the click is within a sixth of its length of it, else its middle. */
export function curvePoint(c: { id: string; at: Vec3; points: Vec3[] }): GeomPick {
  const pts = c.points;
  if (pts.length < 2) return { p: tidyVec(c.at), curve: c.id, end: "mid" };
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i], pts[i - 1]);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = dist(a, b) < 1e-6;
  const da = dist(c.at, a);
  const db = dist(c.at, b);
  if (!closed && Math.min(da, db) <= length / 6) return da <= db ? { p: tidyVec(a), curve: c.id, end: "a" } : { p: tidyVec(b), curve: c.id, end: "b" };
  return { p: tidyVec(pts[Math.floor(pts.length / 2)]), curve: c.id, end: "mid" };
}

const samePoint = (a: GeomPick, b: GeomPick) =>
  JSON.stringify([a.pick?.partId, a.pick?.ref, a.end, a.connector, a.sketchPoint, a.curve, a.pick || a.curve ? null : a.p]) ===
  JSON.stringify([b.pick?.partId, b.pick?.ref, b.end, b.connector, b.sketchPoint, b.curve, b.pick || b.curve ? null : b.p]);

const pointOf = (c: CurveClick): GeomPick | string => (c.kind === "curve" ? curvePoint(c) : pointFromClick(c));

/** What a click changes in an open curve feature (a patch of the draft), or a message to show. */
export function curveClick(draft: Pick<Feature, "id" | "curve" | "picks">, c: CurveClick): Partial<Pick<Feature, "curve" | "picks">> | string {
  const def = draft.curve;
  if (!def) return "Choose a kind of curve first.";
  if (c.kind === "curve" && c.id === draft.id) return "That's this curve itself. Click something else.";
  const set = (patch: Partial<CurveDef>) => ({ curve: { ...def, ...patch } });
  const togglePick = (pick: TopoPick) => {
    const list = draft.picks ?? [];
    const at = list.findIndex((p) => p.partId === pick.partId && JSON.stringify(p.ref) === JSON.stringify(pick.ref));
    return { picks: at >= 0 ? list.filter((_, i) => i !== at) : [...list, { partId: pick.partId, ref: pick.ref }] };
  };
  switch (def.kind) {
    case "helix": {
      if (def.around === "face") {
        if (c.kind !== "part") return "Click a round face (the side of a rod, hole or cone) or a round edge.";
        const ref = c.pick.ref;
        if (ref.kind === "face" ? !(ref.surface.startsWith("CYLIND") || ref.surface === "CONE") : ref.curve !== "CIRCLE") return "That isn't round. Click the side of a rod, hole or cone, or a round edge.";
        return set({ on: { partId: c.pick.partId, ref } });
      }
      if (def.picking === "start") {
        const pt = pointOf(c);
        return typeof pt === "string" ? pt : set({ start: pt, picking: undefined });
      }
      if (c.kind === "curve") return "Click a line for the axis: an edge, a sketch line, a round face or edge, or a mate connector.";
      const line = lineFromClick(c);
      return typeof line === "string" ? line : set({ axis: line, picking: def.start ? undefined : "start" });
    }
    case "bridge": {
      const pt = pointOf(c);
      if (typeof pt === "string") return pt;
      if (def.picking === "to" || (def.from && !def.to && def.picking !== "from")) return set({ to: pt, picking: undefined });
      return set({ from: pt, picking: def.to ? undefined : "to" });
    }
    case "fitSpline": {
      const pt = pointOf(c);
      if (typeof pt === "string") return pt;
      const list = def.points ?? [];
      const at = list.findIndex((q) => samePoint(q, pt));
      return set({ points: at >= 0 ? list.filter((_, i) => i !== at) : [...list, pt] });
    }
    case "composite": {
      if (c.kind === "curve") {
        const list = def.curves ?? [];
        return set({ curves: list.includes(c.id) ? list.filter((x) => x !== c.id) : [...list, c.id] });
      }
      if (c.kind !== "part" || c.pick.ref.kind !== "edge") return "Click edges and curves to join end to end.";
      return togglePick(c.pick);
    }
    case "intersection": {
      if (c.kind === "plane") return set({ plane: c.plane });
      if (c.kind !== "part" || c.pick.ref.kind !== "face") return "Click faces (and, if you like, a plane) to find where they meet.";
      return togglePick(c.pick);
    }
    case "projected": {
      if (def.project === "sketches") return "Choose the two sketches in the dialog.";
      if (c.kind !== "part" || c.pick.ref.kind !== "face") return "Click the faces to project the sketch onto.";
      return togglePick(c.pick);
    }
  }
  return "Nothing to click for this curve.";
}

/** A click while a Sweep or Curve pattern is open: a curve feature becomes its path; with part edges chosen, an edge is added or taken out. Null: not for the path. */
export function pathClick(draft: Pick<Feature, "id" | "pathRef" | "pathEdges">, c: CurveClick): Partial<Pick<Feature, "pathRef" | "pathEdges">> | null {
  if (c.kind === "curve") return { pathRef: c.id, pathEdges: undefined };
  if (draft.pathEdges && c.kind === "part" && c.pick.ref.kind === "edge") {
    const list = draft.pathEdges;
    const at = list.findIndex((p) => p.partId === c.pick.partId && JSON.stringify(p.ref) === JSON.stringify(c.pick.ref));
    return { pathEdges: at >= 0 ? list.filter((_, i) => i !== at) : [...list, { partId: c.pick.partId, ref: c.pick.ref }], pathRef: undefined };
  }
  return null;
}
