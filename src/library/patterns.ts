/**
 * Cut-out patterns for lantern and lamp-shade panels (pure): rows of simple shapes — circles, diamonds, hexagons
 * (honeycomb) or stars — filling a window of a panel, with at least a bridge's width of sheet between any two shapes and
 * between the shapes and the window's edge. Every shape is a separate hole with nothing inside it, so no piece of the
 * panel can come loose: the stencil's own checks (bridges.ts — an outline inside an odd number of others is an island)
 * find no islands, and `patternGap` measures the narrowest bridge.
 *
 * Lattices: circles and stars on a triangular grid, centres `size + bridge` apart, so shapes that fit in a circle
 * `size` across are always `bridge` apart; hexagons across flats `size` on the same grid, flats facing, exactly
 * `bridge` apart; diamonds (`size` corner to corner) on a square grid turned 45°, their sides facing, `bridge` apart.
 */
import { depths, planBridges } from "./bridges";
import { boxOf, outlineGap, r6, type Box, type P2 } from "./outlines";

export type PatternKind = "circles" | "diamonds" | "hexagons" | "stars";

export type Hole = { kind: "circle"; c: P2; d: number } | { kind: "poly"; points: P2[] };

/** Star points: the inner corners are this share of the outer radius out. */
export const STAR_INNER = 0.45;

function regular(c: P2, r: number, sides: number, start: number): P2[] {
  return Array.from({ length: sides }, (_, k): P2 => {
    const a = start + (2 * Math.PI * k) / sides;
    return [r6(c[0] + r * Math.cos(a)), r6(c[1] + r * Math.sin(a))];
  });
}

/** One shape centred on c, `size` across (hexagons: across flats). */
export function patternShape(kind: PatternKind, c: P2, size: number): Hole {
  const r = size / 2;
  switch (kind) {
    case "circles":
      return { kind: "circle", c: [r6(c[0]), r6(c[1])], d: size };
    case "diamonds":
      return { kind: "poly", points: regular(c, r, 4, 0) };
    case "hexagons":
      // Pointed at the top and bottom: flats facing left/right and the neighbours up and down the diagonals.
      return { kind: "poly", points: regular(c, r / Math.cos(Math.PI / 6), 6, Math.PI / 2) };
    case "stars": {
      const pts: P2[] = [];
      for (let k = 0; k < 10; k++) {
        const a = Math.PI / 2 + (Math.PI * k) / 5;
        const rr = k % 2 ? r * STAR_INNER : r;
        pts.push([r6(c[0] + rr * Math.cos(a)), r6(c[1] + rr * Math.sin(a))]);
      }
      return { kind: "poly", points: pts };
    }
  }
}

/** The shape's outline as points (a circle as a many-sided polygon round it, for checks). */
export function holePoints(h: Hole, sides = 96): P2[] {
  if (h.kind === "poly") return h.points;
  // Corners on a circle a little bigger, so its sides lie outside the real circle: gaps measured are never too big.
  const R = h.d / 2 / Math.cos(Math.PI / sides);
  return Array.from({ length: sides }, (_, k): P2 => [h.c[0] + R * Math.cos((2 * Math.PI * k) / sides), h.c[1] + R * Math.sin((2 * Math.PI * k) / sides)]);
}

export const holeBox = (h: Hole): Box => (h.kind === "circle" ? [h.c[0] - h.d / 2, h.c[1] - h.d / 2, h.c[0] + h.d / 2, h.c[1] + h.d / 2] : boxOf(h.points));

/**
 * The holes on a lattice filling the window (x0, y0, x1, y1) — centred in it, every shape at least `bridge` inside its
 * edge — for shapes `size` across with `bridge` between.
 */
export function patternHoles(kind: PatternKind, window: Box, size: number, bridge: number): Hole[] {
  const [x0, y0, x1, y1] = [window[0] + bridge, window[1] + bridge, window[2] - bridge, window[3] - bridge];
  if (x1 - x0 < size || y1 - y0 < size) return [];
  const p = size + bridge;
  // Diamonds: neighbours along the diagonals, sides facing — a square grid turned 45°, rows half a step apart.
  const [dx, dy] = kind === "diamonds" ? [size + bridge * Math.SQRT2, (size + bridge * Math.SQRT2) / 2] : [p, (p * Math.sqrt(3)) / 2];
  const [xc, yc] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const rows = Math.floor((y1 - y0 - size) / dy + 1e-9) + 1;
  const reach = Math.ceil((x1 - x0) / dx) + 1;
  const out: Hole[] = [];
  for (let j = 0; j < rows; j++) {
    const cy = yc + (j - (rows - 1) / 2) * dy;
    // Every other row half a step over; each row symmetric about the window's middle.
    const odd = j % 2 === 1 ? 0.5 : 0;
    for (let i = -reach; i <= reach; i++) {
      const h = patternShape(kind, [xc + (i + odd) * dx, cy], size);
      const b = holeBox(h);
      if (b[0] >= x0 - 1e-6 && b[2] <= x1 + 1e-6 && b[1] >= y0 - 1e-6 && b[3] <= y1 + 1e-6) out.push(h);
    }
  }
  return out;
}

/** The narrowest strip of sheet between two of the holes (∞ with fewer than two). */
export function patternGap(holes: Hole[], enough = -1): number {
  let best = Infinity;
  const boxes = holes.map(holeBox);
  const pts = holes.map((h) => holePoints(h));
  for (let i = 0; i < holes.length; i++)
    for (let j = i + 1; j < holes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const far = Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
      if (far >= best) continue;
      const [hi, hj] = [holes[i], holes[j]];
      const g = hi.kind === "circle" && hj.kind === "circle" ? Math.hypot(hi.c[0] - hj.c[0], hi.c[1] - hj.c[1]) - hi.d / 2 - hj.d / 2 : outlineGap(pts[i], pts[j], enough);
      best = Math.min(best, g);
      if (best <= enough) return best;
    }
  return best;
}

/** What the stencil's bridge check makes of the holes: islands (outlines inside others) and any it couldn't hold. */
export function patternIslands(holes: Hole[]): { islands: number[]; nested: number } {
  const loops = holes.map((h) => holePoints(h, 48));
  const plan = planBridges(loops, { width: 1 });
  return { islands: plan.islands, nested: depths(loops).filter((d) => d > 0).length };
}
