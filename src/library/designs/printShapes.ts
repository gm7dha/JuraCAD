/**
 * Small flat-shape helpers for the fifth batch of 3D-printing designs: hexagons standing on a corner, clipping an
 * outline to a box, and outlines written as sketch shapes (fully defined: every corner dimensioned from the origin).
 */

export type P2 = [number, number];

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * A regular hexagon `flats` across the flats round (cx, cy), with corners pointing along the second axis (up and
 * down: "pointy-top"), anticlockwise from the top corner.
 */
export function pointyHex(flats: number, cx = 0, cy = 0): P2[] {
  const r = flats / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i): P2 => {
    const a = Math.PI / 2 + (Math.PI / 3) * i;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** Area inside a closed outline (mm², positive either way round). */
export function areaOf(pts: P2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** The part of an outline on one side of a line: keep points where `side(p)` ≥ 0 (side is linear, e.g. x − 3). */
function clipHalf(pts: P2[], side: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const [sa, sb] = [side(a), side(b)];
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/** The part of an outline inside the box x0…x1, y0…y1 (Sutherland–Hodgman; exact for straight-sided outlines). */
export function clipToBox(pts: P2[], x0: number, y0: number, x1: number, y1: number): P2[] {
  let out = pts;
  for (const side of [(p: P2) => p[0] - x0, (p: P2) => x1 - p[0], (p: P2) => p[1] - y0, (p: P2) => y1 - p[1]]) {
    out = clipHalf(out, side);
    if (out.length === 0) return [];
  }
  // Drop corners that land on top of each other (an outline cut exactly at a corner).
  const kept: P2[] = [];
  for (const p of out) {
    const q = kept[kept.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) kept.push(p);
  }
  if (kept.length > 1 && Math.hypot(kept[0][0] - kept[kept.length - 1][0], kept[0][1] - kept[kept.length - 1][1]) <= 1e-6) kept.pop();
  return kept;
}

/** A closed straight-sided outline as a sketch shape (mcp/sketchShapes "outline"), its corners rounded to 6 places. */
export const outlineShape = (pts: P2[]) => ({ type: "outline", closed: true, points: pts.map(([x, y]) => [String(six(x)), String(six(y))]) });

/** A rectangle (corner = bottom-left) as a sketch shape. */
export const rectShape = (x: number, y: number, w: number, h: number) => ({ type: "rectangle", corner: [String(six(x)), String(six(y))], width: String(six(w)), height: String(six(h)) });

/** A circle as a sketch shape. */
export const circleShape = (x: number, y: number, d: number) => ({ type: "circle", center: [String(six(x)), String(six(y))], diameter: String(six(d)) });

/**
 * The most a snap-fit cantilever (a straight finger, fixed at one end) stretches when its free end is pushed aside by
 * `deflection`: 1.5 × thickness × deflection / length² (thickness in the direction it bends; length from the root to
 * where it's pushed). PLA and PETG take about 2% without harm, again and again.
 */
export const cantileverStrain = (thickness: number, deflection: number, length: number) => (1.5 * thickness * deflection) / (length * length);

/** The usual safe limit for a printed snap fit's strain (PLA yields at about 3%). */
export const SNAP_STRAIN = 0.02;
