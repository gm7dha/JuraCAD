/** Small triangle meshes made in code, for the Simplify tests. */
import { add, cross, dot, scale, sub, type Vec3 } from "../../src/geometry/shapeFit";
import { triangulate, type P2 } from "../../src/terrain/triangulate";

/** A triangle mesh built up corner by corner, each triangle turned to face `out`. */
export class MeshBuilder {
  vertices: number[] = [];
  triangles: number[] = [];
  point(p: Vec3): number {
    this.vertices.push(...p);
    return this.vertices.length / 3 - 1;
  }
  at(i: number): Vec3 {
    return [this.vertices[3 * i], this.vertices[3 * i + 1], this.vertices[3 * i + 2]];
  }
  tri(a: number, b: number, c: number, out: Vec3) {
    const n = cross(sub(this.at(b), this.at(a)), sub(this.at(c), this.at(a)));
    if (dot(n, out) >= 0) this.triangles.push(a, b, c);
    else this.triangles.push(a, c, b);
  }
  quad(a: number, b: number, c: number, d: number, out: Vec3) {
    this.tri(a, b, c, out);
    this.tri(a, c, d, out);
  }
}

/** A washer: outside Ø20, hole Ø8, 3 thick, faceted with `n` sides (corners moved by up to `wobble`). */
export function washer(n = 48, wobble = 0, hole = 4): MeshBuilder {
  const m = new MeshBuilder();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * wobble;
  const ring = (r: number, z: number) => Array.from({ length: n }, (_, i) => m.point([r * Math.cos((2 * Math.PI * i) / n) + rnd(), r * Math.sin((2 * Math.PI * i) / n) + rnd(), z]));
  const ot = ring(10, 3);
  const ob = ring(10, 0);
  const it = ring(hole, 3);
  const ib = ring(hole, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = (2 * Math.PI * (i + 0.5)) / n;
    const radial: Vec3 = [Math.cos(a), Math.sin(a), 0];
    m.quad(ot[i], ot[j], it[j], it[i], [0, 0, 1]);
    m.quad(ob[i], ob[j], ib[j], ib[i], [0, 0, -1]);
    m.quad(ob[i], ob[j], ot[j], ot[i], radial);
    m.quad(ib[i], ib[j], it[j], it[i], [-radial[0], -radial[1], 0]);
  }
  return m;
}


/** Bytes as base64 (how an imported STL is kept in the design). */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

/** A lumpy ball of about 2 × n × m triangles (nothing in it is flat or round). */
export function lumpyBall(n: number, m: number): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < m; j++) {
      if ((i === 0 || i === n) && j > 0) continue;
      const th = (Math.PI * i) / n;
      const ph = (2 * Math.PI * j) / m;
      const r = 10 + 2 * Math.sin(3 * th) * Math.cos(2 * ph) + ((i * 7 + j * 13) % 5) * 0.1;
      vertices.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  const at = (i: number, j: number) => (i === 0 ? 0 : i === n ? 1 + (n - 1) * m : 1 + (i - 1) * m + (j % m));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      if (i > 0) triangles.push(at(i, j), at(i + 1, j), at(i, j + 1));
      if (i < n - 1) triangles.push(at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
    }
  return { vertices, triangles };
}

/**
 * A figurine on a round base: a ball whose middle band is smooth (and so round) and the rest lumpy —
 * about 2 × n × m triangles.
 */
export function bandedBall(n: number, m: number): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < m; j++) {
      if ((i === 0 || i === n) && j > 0) continue;
      const th = (Math.PI * i) / n;
      const ph = (2 * Math.PI * j) / m;
      const lumpy = i < n / 3 || i > (2 * n) / 3;
      const r = lumpy ? 20 + 1.5 * Math.sin(5 * th) * Math.cos(4 * ph) + 0.3 * Math.sin(37 * th + 11 * ph) : 20;
      vertices.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  const at = (i: number, j: number) => (i === 0 ? 0 : i === n ? 1 + (n - 1) * m : 1 + (i - 1) * m + (j % m));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      if (i > 0) triangles.push(at(i, j), at(i + 1, j), at(i, j + 1));
      if (i < n - 1) triangles.push(at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
    }
  return { vertices, triangles };
}

/** A flat polygon (anticlockwise seen from `out`, holes clockwise) as triangles, using exactly the corners given. */
function flatFace(m: MeshBuilder, outer: number[], holes: number[][], out: Vec3) {
  // Flattened in a frame square to `out`.
  const helper: Vec3 = Math.abs(out[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(helper, out);
  const v = cross(out, u);
  const flat = (i: number): P2 => [dot(m.at(i), u), dot(m.at(i), v)];
  const all = [...outer, ...holes.flat()];
  for (const [a, b, c] of triangulate(
    outer.map(flat),
    holes.map((h) => h.map(flat)),
  ))
    m.tri(all[a], all[b], all[c], out);
}

/**
 * A 30 × 30 × 6 plate with a Ø`2r` hole through it at `tilt` degrees from upright (leaning towards +y), its
 * wall made of `n` flat strips between the two elliptical rims.
 */
export function slantedHolePlate(tilt = 30, r = 3, n = 64): MeshBuilder {
  const m = new MeshBuilder();
  const th = (tilt * Math.PI) / 180;
  const axis: Vec3 = [0, Math.sin(th), Math.cos(th)];
  const u: Vec3 = [1, 0, 0];
  const w = cross(axis, u);
  // Where the line through the point at angle φ round the axis meets the plane z = h.
  const rim = (phi: number, h: number): Vec3 => {
    const p: Vec3 = [r * Math.cos(phi) * u[0] + r * Math.sin(phi) * w[0], r * Math.cos(phi) * u[1] + r * Math.sin(phi) * w[1], 3 + r * Math.cos(phi) * u[2] + r * Math.sin(phi) * w[2]];
    const t = (h - p[2]) / axis[2];
    return [p[0] + t * axis[0], p[1] + t * axis[1], h];
  };
  const top = Array.from({ length: n }, (_, i) => m.point(rim((2 * Math.PI * i) / n, 6)));
  const bottom = Array.from({ length: n }, (_, i) => m.point(rim((2 * Math.PI * i) / n, 0)));
  const corners = (z: number) => [m.point([-15, -15, z]), m.point([15, -15, z]), m.point([15, 15, z]), m.point([-15, 15, z])];
  const ct = corners(6);
  const cb = corners(0);
  // (triangulate sorts out which way round the outline and hole go; tri() which way each triangle faces.)
  flatFace(m, ct, [top], [0, 0, 1]);
  flatFace(m, cb, [bottom], [0, 0, -1]);
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    const mid = scale(add(add(m.at(cb[k]), m.at(cb[j])), [0, 0, 0]), 0.5);
    m.quad(cb[k], cb[j], ct[j], ct[k], [mid[0], mid[1], 0]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const phi = (2 * Math.PI * (i + 0.5)) / n;
    // Into the hole, towards the axis.
    const radial = add(scale(u, Math.cos(phi)), scale(w, Math.sin(phi)));
    m.quad(bottom[i], bottom[j], top[j], top[i], scale(radial, -1));
  }
  return m;
}

/**
 * A T of two round bars: a Ø10 bar 40 long along x, and a Ø6 one standing on it along z up to z = 12, offset
 * `shift` along y. Each bar's sides are flat strips between straight lines along it (as an STL of a CAD part
 * is), the joined one's strips ending on the curve where the two meet. `inside`: turned inside out — a hole
 * crossing a hole (the T as a hollow).
 */
export function pipeTee(shift = 0, n = 48, inside = false): MeshBuilder {
  const m = new MeshBuilder();
  const R = 5;
  const r = 3;
  // The branch's corners where it meets the bar, by its own angle ψ (φ round the bar's axis matches pairs ±x).
  const half = n / 2;
  const meet: { x: number; y: number; z: number; phi: number }[] = [];
  for (let k = 0; k <= half; k++) {
    const psi = -Math.PI / 2 + (Math.PI * k) / half;
    const x = r * Math.cos(psi);
    const y = shift + r * Math.sin(psi);
    const z = Math.sqrt(R * R - y * y);
    meet.push({ x, y, z, phi: Math.atan2(z, y) });
  }
  // By φ round the bar (ψ = −90°, y = shift − r, is the largest φ).
  meet.sort((a, b) => a.phi - b.phi);
  const phiLo = meet[0].phi;
  const phiHi = meet[meet.length - 1].phi;
  // The bar's straight lines: every 7.5° outside the branch, and at each meeting corner's φ inside it.
  const rulings: { phi: number; meet?: (typeof meet)[number] }[] = meet.map((q) => ({ phi: q.phi, meet: q }));
  const step = (2 * Math.PI) / n;
  for (let phi = phiHi + step; phi < phiLo + 2 * Math.PI - step / 2; phi += step) rulings.push({ phi });
  rulings.sort((a, b) => a.phi - b.phi);
  const L = 20;
  const at = (phi: number, x: number): Vec3 => [x, R * Math.cos(phi), R * Math.sin(phi)];
  // Corners on each straight line: its two ends, and where the branch meets it (once at the branch's sides, else twice).
  const ids = rulings.map((ru) => {
    const lo = m.point(at(ru.phi, -L));
    const hi = m.point(at(ru.phi, L));
    if (!ru.meet) return { lo, hi };
    const x = Math.abs(ru.meet.x);
    if (x < 1e-9) {
      const p = m.point([0, ru.meet.y, ru.meet.z]);
      return { lo, hi, back: p, front: p };
    }
    return { lo, hi, back: m.point([-x, ru.meet.y, ru.meet.z]), front: m.point([x, ru.meet.y, ru.meet.z]) };
  });
  const c = rulings.length;
  for (let i = 0; i < c; i++) {
    const j = (i + 1) % c;
    const mid = (rulings[i].phi + (j ? rulings[j].phi : rulings[j].phi + 2 * Math.PI)) / 2;
    const out: Vec3 = [0, Math.cos(mid), Math.sin(mid)];
    const a = ids[i];
    const b = ids[j];
    if (a.front !== undefined && b.front !== undefined) {
      // Both lines cut by the branch: a strip from each end to it.
      m.quad(a.front, b.front, b.hi, a.hi, out);
      m.quad(a.lo, b.lo, b.back!, a.back!, out);
    } else if (a.front !== undefined || b.front !== undefined) {
      // Beside the branch: the corner where it touches this line splits the strip's side in two.
      const [p, q] = a.front !== undefined ? [a, b] : [b, a];
      const poly = [p.lo, q.lo, q.hi, p.hi, p.front!];
      if (p.back !== p.front) throw new Error("branch side");
      m.tri(poly[0], poly[1], poly[4], out);
      m.tri(poly[1], poly[2], poly[4], out);
      m.tri(poly[2], poly[3], poly[4], out);
    } else m.quad(a.lo, b.lo, b.hi, a.hi, out);
  }
  // The bar's ends.
  const endL = m.point([-L, 0, 0]);
  const endR = m.point([L, 0, 0]);
  for (let i = 0; i < c; i++) {
    const j = (i + 1) % c;
    m.tri(endL, ids[i].lo, ids[j].lo, [-1, 0, 0]);
    m.tri(endR, ids[i].hi, ids[j].hi, [1, 0, 0]);
  }
  // The branch: a straight strip up from each pair of neighbouring corners where it meets the bar, and its top.
  const loop: number[] = [];
  const loopAt: Vec3[] = [];
  const byPsi = rulings.map((ru, i) => ({ ru, i })).filter((e) => e.ru.meet);
  const front = byPsi.map((e) => ids[e.i].front!);
  const back = byPsi.map((e) => ids[e.i].back!);
  // φ grows as y falls (ψ from 90° to −90°), so front taken backwards then back forwards goes round once.
  const ring = [...front.reverse(), ...back.slice(1, -1)];
  for (const v of ring) {
    loop.push(v);
    loopAt.push(m.at(v));
  }
  const tops = loopAt.map((p) => m.point([p[0], p[1], 12]));
  const lid = m.point([0, shift, 12]);
  for (let k = 0; k < loop.length; k++) {
    const l = (k + 1) % loop.length;
    const mid = scale(add(loopAt[k], loopAt[l]), 0.5);
    m.quad(loop[k], loop[l], tops[l], tops[k], [mid[0], mid[1] - shift, 0]);
    m.tri(lid, tops[k], tops[l], [0, 0, 1]);
  }
  if (inside) for (let t = 0; t < m.triangles.length; t += 3) [m.triangles[t + 1], m.triangles[t + 2]] = [m.triangles[t + 2], m.triangles[t + 1]];
  return m;
}

/**
 * A 40 × 30 × 8 plate with its upright edges rounded R`corner` and its top edge rounded R`fillet` all the way
 * round — so the top's rounding is a straight round along each side and part of a ring (a torus) round each
 * corner. Swept as a profile round the plate's outline, `k` facets round each curve.
 */
export function roundedPlate(corner = 5, fillet = 1.5, k = 12): MeshBuilder {
  const m = new MeshBuilder();
  const W = 40;
  const D = 30;
  const H = 8;
  // The outline (its corners' centres) walked anticlockwise, with the outward direction at each point.
  const centres: [number, number][] = [
    [W - corner, corner],
    [W - corner, D - corner],
    [corner, D - corner],
    [corner, corner],
  ];
  const path: { p: [number, number]; n: [number, number] }[] = [];
  centres.forEach(([cx, cy], q) => {
    const a0 = -Math.PI / 2 + (q * Math.PI) / 2;
    for (let i = 0; i <= k; i++) {
      const a = a0 + ((Math.PI / 2) * i) / k;
      path.push({ p: [cx + corner * Math.cos(a), cy + corner * Math.sin(a)], n: [Math.cos(a), Math.sin(a)] });
    }
  });
  // The profile: up the side, round the fillet, onto the top (distance in from the outline, height).
  const profile: [number, number][] = [[0, 0]];
  for (let i = 0; i <= k; i++) {
    const b = ((Math.PI / 2) * i) / k;
    profile.push([fillet - fillet * Math.cos(b), H - fillet + fillet * Math.sin(b)]);
  }
  const grid = path.map(({ p, n }) => profile.map(([d, z]) => m.point([p[0] - n[0] * d, p[1] - n[1] * d, z])));
  const P = path.length;
  for (let i = 0; i < P; i++) {
    const j = (i + 1) % P;
    for (let s = 0; s + 1 < profile.length; s++) {
      const out: Vec3 = [path[i].n[0] + path[j].n[0], path[i].n[1] + path[j].n[1], s === 0 ? 0 : (s / profile.length) * 2];
      m.quad(grid[i][s], grid[j][s], grid[j][s + 1], grid[i][s + 1], out);
    }
  }
  // Top and bottom.
  const topRing = grid.map((g) => g[g.length - 1]).filter((v, i, a) => a.indexOf(v) === i);
  const bottomRing = grid.map((g) => g[0]);
  flatFace(m, dedupe(m, topRing), [], [0, 0, 1]);
  flatFace(m, [...dedupe(m, bottomRing)].reverse(), [], [0, 0, -1]);
  return m;
}

/** A ring of corners without the ones lying where the one before is (straight sides' ends meet their arcs'). */
function dedupe(m: MeshBuilder, ring: number[]): number[] {
  return ring.filter((v, i) => {
    const p = m.at(v);
    const q = m.at(ring[(i - 1 + ring.length) % ring.length]);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-9;
  });
}
