/**
 * Hidden lines that lie exactly under visible ones (for example the back
 * edges of a box, straight behind the front edges) add nothing to a drawing
 * but clutter, so they're left out.
 */

/** Distance from point (px, py) to the segment (ax, ay)–(bx, by). */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Hidden lines without the ones that every point of lies on a visible line (within `tol` mm). */
export function dropCoveredHidden(visible: number[][], hidden: number[][], tol = 1e-3): number[][] {
  if (hidden.length === 0 || visible.length === 0) return hidden;
  // Visible segments sorted into a grid of cells so each point only checks nearby ones.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of visible)
    for (let i = 0; i < l.length; i += 2) {
      minX = Math.min(minX, l[i]);
      maxX = Math.max(maxX, l[i]);
      minY = Math.min(minY, l[i + 1]);
      maxY = Math.max(maxY, l[i + 1]);
    }
  const cell = Math.max((maxX - minX) / 64, (maxY - minY) / 64, tol * 10, 1e-6);
  const grid = new Map<string, number[]>();
  const segs: number[] = [];
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const l of visible) {
    for (let i = 0; i + 3 < l.length; i += 2) {
      const s = segs.length;
      segs.push(l[i], l[i + 1], l[i + 2], l[i + 3]);
      const x0 = Math.floor((Math.min(l[i], l[i + 2]) - tol - minX) / cell);
      const x1 = Math.floor((Math.max(l[i], l[i + 2]) + tol - minX) / cell);
      const y0 = Math.floor((Math.min(l[i + 1], l[i + 3]) - tol - minY) / cell);
      const y1 = Math.floor((Math.max(l[i + 1], l[i + 3]) + tol - minY) / cell);
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const k = key(cx, cy);
          const list = grid.get(k);
          if (list) list.push(s);
          else grid.set(k, [s]);
        }
    }
  }
  const covered = (x: number, y: number) => {
    const list = grid.get(key(Math.floor((x - minX) / cell), Math.floor((y - minY) / cell)));
    return !!list && list.some((s) => segmentDistance(x, y, segs[s], segs[s + 1], segs[s + 2], segs[s + 3]) <= tol);
  };
  return hidden.filter((l) => {
    for (let i = 0; i < l.length; i += 2) {
      if (!covered(l[i], l[i + 1])) return true;
      // Check halfway along each piece too, so a line that only touches visible lines at its ends is kept.
      if (i + 3 < l.length && !covered((l[i] + l[i + 2]) / 2, (l[i + 1] + l[i + 3]) / 2)) return true;
    }
    return false;
  });
}
