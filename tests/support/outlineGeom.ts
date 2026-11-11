/**
 * Outlines of printed puzzle pieces for tests: the boundary of a mesh's flat underside (z = 0) as segments, a grid to
 * look segments up near a point, segment distances and crossings, and "does this outline, moved, cross that one?".
 */
type XY = [number, number];
export type Seg = [number, number, number, number];

/** The edges of a body's z = 0 faces that belong to one triangle only: its outline. */
export function outlineSegs(b: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): Seg[] {
  const v = b.vertices;
  const t = b.triangles;
  const key = (i: number) => `${v[i * 3].toFixed(6)},${v[i * 3 + 1].toFixed(6)}`;
  const count = new Map<string, { n: number; a: XY; b: XY }>();
  for (let k = 0; k < t.length; k += 3) {
    const ids = [t[k], t[k + 1], t[k + 2]];
    if (!ids.every((i) => v[i * 3 + 2] === 0)) continue;
    for (let e = 0; e < 3; e++) {
      const [p, q] = [ids[e], ids[(e + 1) % 3]];
      const [kp, kq] = [key(p), key(q)];
      const kk = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const c = count.get(kk);
      if (c) c.n++;
      else count.set(kk, { n: 1, a: [v[p * 3], v[p * 3 + 1]], b: [v[q * 3], v[q * 3 + 1]] });
    }
  }
  const out: Seg[] = [];
  for (const c of count.values()) if (c.n === 1) out.push([c.a[0], c.a[1], c.b[0], c.b[1]]);
  return out;
}

/** Segments bucketed on an h mm grid. */
export class SegGrid {
  cells = new Map<string, number[]>();
  constructor(
    public segs: Seg[],
    public h = 1,
  ) {
    segs.forEach((s, i) => {
      const [x0, x1] = [Math.min(s[0], s[2]), Math.max(s[0], s[2])];
      const [y0, y1] = [Math.min(s[1], s[3]), Math.max(s[1], s[3])];
      for (let a = Math.floor(x0 / h); a <= Math.floor(x1 / h); a++)
        for (let b = Math.floor(y0 / h); b <= Math.floor(y1 / h); b++) {
          const k = `${a},${b}`;
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }
  /** Indexes of segments that may come within r of (x, y). */
  near(x: number, y: number, r: number): number[] {
    const s = new Set<number>();
    const h = this.h;
    for (let a = Math.floor((x - r) / h); a <= Math.floor((x + r) / h); a++)
      for (let b = Math.floor((y - r) / h); b <= Math.floor((y + r) / h); b++) for (const i of this.cells.get(`${a},${b}`) ?? []) s.add(i);
    return [...s];
  }
}

export function ptSeg(px: number, py: number, s: Seg): number {
  const [ax, ay, bx, by] = s;
  const [dx, dy] = [bx - ax, by - ay];
  const L = dx * dx + dy * dy;
  const u = Math.max(0, Math.min(1, L ? ((px - ax) * dx + (py - ay) * dy) / L : 0));
  return Math.hypot(px - ax - u * dx, py - ay - u * dy);
}

const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Do two segments cross (properly, not just touch)? */
export function segsCross(s: Seg, r: Seg): boolean {
  const [A, B, C, D]: XY[] = [
    [s[0], s[1]],
    [s[2], s[3]],
    [r[0], r[1]],
    [r[2], r[3]],
  ];
  return cross(C, D, A) * cross(C, D, B) < 0 && cross(A, B, C) * cross(A, B, D) < 0;
}

export function segSegDist(s: Seg, r: Seg): number {
  if (segsCross(s, r)) return 0;
  return Math.min(ptSeg(s[0], s[1], r), ptSeg(s[2], s[3], r), ptSeg(r[0], r[1], s), ptSeg(r[2], r[3], s));
}

export function box(segs: Seg[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of segs) {
    x0 = Math.min(x0, s[0], s[2]);
    x1 = Math.max(x1, s[0], s[2]);
    y0 = Math.min(y0, s[1], s[3]);
    y1 = Math.max(y1, s[1], s[3]);
  }
  return [x0, y0, x1, y1];
}

/** Does outline A, moved by (dx, dy), cross outline B? */
export function collides(A: Seg[], gB: SegGrid, dx: number, dy: number): boolean {
  for (const s0 of A) {
    const s: Seg = [s0[0] + dx, s0[1] + dy, s0[2] + dx, s0[3] + dy];
    const half = Math.hypot(s[2] - s[0], s[3] - s[1]) / 2;
    for (const i of gB.near((s[0] + s[2]) / 2, (s[1] + s[3]) / 2, half + 0.01)) if (segsCross(s, gB.segs[i])) return true;
  }
  return false;
}
