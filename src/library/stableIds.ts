/** Sketch item ids that stay the same each time a library design is made again. */
import { ORIGIN_ID, type SketchCurve, type SketchData } from "../sketch/types";

/**
 * Give a sketch's points, curves and dimensions ids made from where they come in it (`<feature id>_p3`…), so the
 * same design made again keeps the same ids — and other sketches' links to it keep working after a size change.
 */
export function stableIds(s: SketchData, prefix: string): SketchData {
  const map = new Map<string, string>([[ORIGIN_ID, ORIGIN_ID]]);
  s.points.forEach((p, i) => map.set(p.id, `${prefix}_p${i}`));
  s.curves.forEach((c, i) => map.set(c.id, `${prefix}_c${i}`));
  s.constraints.forEach((c, i) => map.set(c.id, `${prefix}_k${i}`));
  const m = (id: string) => map.get(id) ?? id;
  return {
    ...s,
    points: s.points.map((p) => ({ ...p, id: m(p.id) })),
    curves: s.curves.map((c): SketchCurve => {
      switch (c.type) {
        case "line":
          return { ...c, id: m(c.id), p1: m(c.p1), p2: m(c.p2) };
        case "circle":
          return { ...c, id: m(c.id), center: m(c.center) };
        case "arc":
          return { ...c, id: m(c.id), center: m(c.center), start: m(c.start), end: m(c.end) };
        default:
          // Designs only draw lines, circles and arcs; anything else keeps its ids.
          return c;
      }
    }),
    constraints: s.constraints.map((c) => ({ ...c, id: m(c.id), refs: c.refs.map(m) })),
    // Text hangs from its (renamed) point, and gets an id from its place too.
    ...(s.texts ? { texts: s.texts.map((t, i) => ({ ...t, id: `${prefix}_t${i}`, anchor: m(t.anchor) })) } : {}),
  };
}
