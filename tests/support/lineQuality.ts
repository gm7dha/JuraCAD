/**
 * Measures a map line as printed on a puzzle (pure, for tests): walks along the line as the puzzle used it and, at
 * stations a little apart, reads the pieces' meshes — how deep the groove is below the plain ground, how wide it is
 * (where it's at least half its depth), how wide the painted strip is (bands: painted triangles; full colour: corners in
 * the paint colour), where the paint is missing on the line, and where it spreads into a blob.
 */
type XY = [number, number];

export interface Mesh {
  vertices: ArrayLike<number>;
  triangles: ArrayLike<number>;
  /** Per triangle: painted or not (bands' paint, or full colour's corners all in the paint colour). */
  painted?: (t: number) => boolean;
}

export interface Station {
  at: XY;
  dir: XY;
}

/** Stations every `step` mm along a polyline (mm), with its direction, from `skip` mm in from each end. */
export function stations(pts: XY[], step: number, skip = 1): Station[] {
  const out: Station[] = [];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const dir: XY = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    for (let s = carry; s < len; s += step) out.push({ at: [a[0] + dir[0] * s, a[1] + dir[1] * s], dir });
    carry = step - ((len - carry) % step || step);
    if (carry >= step) carry = 0;
  }
  const n = Math.ceil(skip / step);
  return out.slice(n, Math.max(n, out.length - n));
}

/** Upward triangles in 1 mm buckets, to find the top surface at a point. */
export class TopIndex {
  private buckets = new Map<string, { m: Mesh; t: number }[]>();
  constructor(meshes: Mesh[]) {
    for (const m of meshes) {
      const V = m.vertices;
      const T = m.triangles;
      for (let t = 0; t < T.length; t += 3) {
        const [a, b, c] = [T[t], T[t + 1], T[t + 2]];
        const area = (V[b * 3] - V[a * 3]) * (V[c * 3 + 1] - V[a * 3 + 1]) - (V[c * 3] - V[a * 3]) * (V[b * 3 + 1] - V[a * 3 + 1]);
        if (area <= 1e-12) continue;
        const xs = [V[a * 3], V[b * 3], V[c * 3]];
        const ys = [V[a * 3 + 1], V[b * 3 + 1], V[c * 3 + 1]];
        for (let i = Math.floor(Math.min(...xs)); i <= Math.floor(Math.max(...xs)); i++)
          for (let j = Math.floor(Math.min(...ys)); j <= Math.floor(Math.max(...ys)); j++) {
            const key = `${i},${j}`;
            const list = this.buckets.get(key);
            if (list) list.push({ m, t });
            else this.buckets.set(key, [{ m, t }]);
          }
      }
    }
  }
  /** The highest upward triangle over (x, y): its z there and whether it's painted; null off the pieces. */
  at(x: number, y: number): { z: number; painted: boolean } | null {
    let best: { z: number; painted: boolean } | null = null;
    for (const { m, t } of this.buckets.get(`${Math.floor(x)},${Math.floor(y)}`) ?? []) {
      const V = m.vertices;
      const T = m.triangles;
      const [a, b, c] = [T[t], T[t + 1], T[t + 2]];
      const [ax, ay, bx, by, cx, cy] = [V[a * 3], V[a * 3 + 1], V[b * 3], V[b * 3 + 1], V[c * 3], V[c * 3 + 1]];
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      const u = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
      const v = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      const z = u * V[a * 3 + 2] + v * V[b * 3 + 2] + w * V[c * 3 + 2];
      if (!best || z > best.z) best = { z, painted: m.painted ? m.painted(t / 3) : false };
      if (process.env.LQ_AT && Math.hypot(x - Number(process.env.LQ_AT.split(",")[0]), y - Number(process.env.LQ_AT.split(",")[1])) < 1e-3)
        console.log("tri", [a, b, c].map((i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]].map((v) => v.toFixed(4)).join(" ")).join(" | "), "z", z.toFixed(4));
    }
    return best;
  }
}

export interface LineReport {
  stations: number;
  /** Depth (mm) at the line's middle: lowest, 5th percentile, middle. */
  depthMin: number;
  depthP5: number;
  depthMid: number;
  /** Stations shallower than 90% of the groove's depth. */
  shallow: number;
  /** Groove width (mm, where at least half its depth — `half` for a perfect channel): narrowest, widest, 5th and 95th percentiles. */
  widthMin: number;
  widthMax: number;
  widthP5: number;
  widthP95: number;
  /** Painted strip width (mm): the same, and stations where the line's middle isn't painted (breaks). */
  paintMin: number;
  paintMax: number;
  paintP5: number;
  paintP95: number;
  breaks: number;
  /** Stations where the paint or groove is more than 1.6 × the groove's width across (blobs). */
  blobs: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

/**
 * The line at its stations: `plain(x, y)` is the ground with no marks, `want(x, y)` the groove's own depth there
 * (0 where it's meant to fade, e.g. over a dovetail's neck — such stations are skipped), `width`/`depth` the groove's.
 */
export function measureLine(index: TopIndex, st: Station[], plain: (x: number, y: number) => number, want: (x: number, y: number) => number, width: number, depth: number, paint: boolean, half = width): LineReport {
  const depths: number[] = [];
  const widths: number[] = [];
  const paints: number[] = [];
  let [breaks, blobs, n] = [0, 0, 0];
  const STEP = 0.01;
  const reach = 1.5 * width;
  const deepAt = (x: number, y: number) => {
    const h = index.at(x, y);
    return h ? { d: plain(x, y) - h.z, painted: h.painted } : null;
  };
  for (const s of st) {
    const [x, y] = s.at;
    // Only where the groove is meant to be its whole depth all round (not fading over a dovetail's neck).
    let full = true;
    for (let a = 0; a < 8 && full; a++) full = want(x + Math.cos(a) * 0.8, y + Math.sin(a) * 0.8) >= 0.99 * depth || want(x + Math.cos(a) * 0.8, y + Math.sin(a) * 0.8) === 0;
    if (want(x, y) < 0.99 * depth || !full) continue;
    const mid = deepAt(x, y);
    if (!mid) continue;
    // Clear of the pieces' edges (the fit gap), both ways across.
    const nrm: XY = [-s.dir[1], s.dir[0]];
    let clear = true;
    for (let r = -reach; r <= reach && clear; r += STEP) clear = !!deepAt(x + nrm[0] * r, y + nrm[1] * r);
    if (!clear) continue;
    n++;
    depths.push(mid.d);
    if (process.env.LQ_DEBUG && mid.d < 0.9 * depth) console.log("shallow at", x.toFixed(3), y.toFixed(3), mid.d.toFixed(3), want(x, y).toFixed(3));
    // Across: how far each way the groove is at least half deep, and the paint goes on.
    const across = (test: (h: { d: number; painted: boolean }) => boolean) => {
      if (!test(mid)) return 0;
      let w = 0;
      for (const side of [1, -1]) {
        let r = STEP;
        for (; r <= reach; r += STEP) {
          const h = deepAt(x + side * nrm[0] * r, y + side * nrm[1] * r);
          if (!h || !test(h)) break;
        }
        w += r - STEP / 2;
      }
      return w;
    };
    const gw = across((h) => h.d >= depth / 2);
    widths.push(gw);
    if (paint) {
      const pw = across((h) => h.painted);
      if (!mid.painted) breaks++;
      if (process.env.LQ_DEBUG && pw < 0.85 * width) {
        console.log("thin paint at", x.toFixed(3), y.toFixed(3), pw.toFixed(3), "dir", s.dir.map((v) => v.toFixed(3)).join(","));
        const row: string[] = [];
        for (let r = -0.4; r <= 0.4; r += 0.02) {
          const h = deepAt(x + nrm[0] * r, y + nrm[1] * r);
          row.push(`${r.toFixed(2)}:${h ? (h.painted ? "P" : ".") + h.d.toFixed(2) : "-"}`);
        }
        console.log(row.join(" "));
      }
      paints.push(pw);
      if (pw > 1.6 * width) blobs++;
    } else if (gw > 1.6 * half) blobs++;
  }
  return {
    stations: n,
    depthMin: Math.min(...depths),
    depthP5: pct(depths, 0.05),
    depthMid: pct(depths, 0.5),
    shallow: depths.filter((d) => d < 0.9 * depth).length,
    widthMin: Math.min(...widths),
    widthMax: Math.max(...widths),
    widthP5: pct(widths, 0.05),
    widthP95: pct(widths, 0.95),
    paintMin: paints.length ? Math.min(...paints) : NaN,
    paintMax: paints.length ? Math.max(...paints) : NaN,
    paintP5: pct(paints, 0.05),
    paintP95: pct(paints, 0.95),
    breaks,
    blobs,
  };
}

/** A report as one line of numbers (mm). */
export const reportText = (r: LineReport) =>
  `${r.stations} stations; depth min ${r.depthMin.toFixed(3)} p5 ${r.depthP5.toFixed(3)} mid ${r.depthMid.toFixed(3)} (shallow ${r.shallow}); ` +
  `groove width ${r.widthMin.toFixed(2)}–${r.widthMax.toFixed(2)} (p5 ${r.widthP5.toFixed(2)}, p95 ${r.widthP95.toFixed(2)}); ` +
  `paint ${r.paintMin.toFixed(2)}–${r.paintMax.toFixed(2)} (p5 ${r.paintP5.toFixed(2)}, p95 ${r.paintP95.toFixed(2)}), breaks ${r.breaks}, blobs ${r.blobs}`;
