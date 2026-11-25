import { describe, expect, it } from "vitest";
import { decimate } from "../src/geometry/decimate";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { planMesh } from "../src/geometry/meshSimplify";
import { SIMPLIFY_TOLERANCES } from "../src/model/simplify";
import { writeBinaryStl } from "../src/geometry/stl";
import { reduceStl, fromBase64, storedTriangles } from "../src/model/importFile";
import { triangulate, type P2 } from "../src/terrain/triangulate";
import { MeshBuilder } from "./support/meshShapes";

type V = [number, number, number];

/** A 60 × 40 × 10 plate with round holes, each hole's wall `seg` strips round and `rings` tall (a fine CAD export). */
function holedPlate(holes: { x: number; y: number; r: number }[], seg: number, rings: number, H = 10): MeshBuilder {
  const m = new MeshBuilder();
  const rimIds: number[][][] = holes.map((h) =>
    Array.from({ length: rings + 1 }, (_, k) => Array.from({ length: seg }, (_, i) => m.point([h.x + h.r * Math.cos((2 * Math.PI * i) / seg), h.y + h.r * Math.sin((2 * Math.PI * i) / seg), (H * k) / rings]))),
  );
  const corner = (z: number) => [m.point([0, 0, z]), m.point([60, 0, z]), m.point([60, 40, z]), m.point([0, 40, z])];
  const cb = corner(0), ct = corner(H);
  for (const [outer, holesAt, out] of [
    [ct, rimIds.map((r) => r[rings]), [0, 0, 1]],
    [cb, rimIds.map((r) => r[0]), [0, 0, -1]],
  ] as [number[], number[][], V][]) {
    const flat = (i: number): P2 => [m.at(i)[0], m.at(i)[1]];
    const all = [...outer, ...holesAt.flat()];
    for (const [a, b, c] of triangulate(outer.map(flat), holesAt.map((h) => h.map(flat)))) m.tri(all[a], all[b], all[c], out);
  }
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    const mid = [(m.at(cb[k])[0] + m.at(cb[j])[0]) / 2 - 30, (m.at(cb[k])[1] + m.at(cb[j])[1]) / 2 - 20, 0] as V;
    m.quad(cb[k], cb[j], ct[j], ct[k], mid);
  }
  holes.forEach((_, hi) => {
    for (let k = 0; k < rings; k++)
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const phi = (2 * Math.PI * (i + 0.5)) / seg;
        m.quad(rimIds[hi][k][i], rimIds[hi][k][j], rimIds[hi][k + 1][j], rimIds[hi][k + 1][i], [-Math.cos(phi), -Math.sin(phi), 0]);
      }
  });
  return m;
}

/** A thin-walled cup: outside radius R, wall t, height H, floor t; `seg` round, `rings` up. */
function cup(R: number, t: number, H: number, seg: number, rings: number): MeshBuilder {
  const m = new MeshBuilder();
  const ring = (r: number, z: number) => Array.from({ length: seg }, (_, i) => m.point([r * Math.cos((2 * Math.PI * i) / seg), r * Math.sin((2 * Math.PI * i) / seg), z]));
  const outer = Array.from({ length: rings + 1 }, (_, k) => ring(R, (H * k) / rings));
  const inner = Array.from({ length: rings + 1 }, (_, k) => ring(R - t, t + ((H - t) * k) / rings));
  const wall = (rs: number[][], sign: number) => {
    for (let k = 0; k + 1 < rs.length; k++)
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const phi = (2 * Math.PI * (i + 0.5)) / seg;
        m.quad(rs[k][i], rs[k][j], rs[k + 1][j], rs[k + 1][i], [sign * Math.cos(phi), sign * Math.sin(phi), 0]);
      }
  };
  wall(outer, 1);
  wall(inner, -1);
  // Rim.
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    m.quad(outer[rings][i], outer[rings][j], inner[rings][j], inner[rings][i], [0, 0, 1]);
  }
  // Bottom (outside) and floor (inside): fans.
  const cb = m.point([0, 0, 0]), cf = m.point([0, 0, t]);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    m.tri(cb, outer[0][i], outer[0][j], [0, 0, -1]);
    m.tri(cf, inner[0][i], inner[0][j], [0, 0, 1]);
  }
  return m;
}

/** Triangles of the mesh that cross another (sharing no corner), found with a grid. */
function crossings(v: ArrayLike<number>, t: ArrayLike<number>): number {
  const nt = t.length / 3;
  const P = (i: number): V => [v[3 * i], v[3 * i + 1], v[3 * i + 2]];
  const boxes: [V, V][] = [];
  let size = 0;
  for (let k = 0; k < nt; k++) {
    const a = P(t[3 * k]), b = P(t[3 * k + 1]), c = P(t[3 * k + 2]);
    const lo: V = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
    const hi: V = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
    boxes.push([lo, hi]);
    size += Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  }
  const cell = Math.max(1e-6, (size / nt) * 2);
  const grid = new Map<string, number[]>();
  boxes.forEach(([lo, hi], k) => {
    for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++)
      for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++)
        for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
          const key = `${x},${y},${z}`;
          const l = grid.get(key);
          if (l) l.push(k);
          else grid.set(key, [k]);
        }
  });
  const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cr = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dt = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Does segment p→q pass through triangle abc (strictly)?
  const segHits = (p: V, q: V, a: V, b: V, c: V) => {
    const n = cr(sub(b, a), sub(c, a));
    const dp = dt(n, sub(p, a)), dq = dt(n, sub(q, a));
    const eps = 1e-5 * Math.sqrt(dt(n, n)); // within 0.01 µm of the plane = in it (folds there show as flipped edges)
    if ((dp > eps && dq > eps) || (dp < -eps && dq < -eps) || Math.abs(dp - dq) < 1e-15) return false;
    if (Math.abs(dp) <= eps && Math.abs(dq) <= eps) return false; // coplanar: skip
    const s = dp / (dp - dq);
    if (!(s >= 0 && s <= 1)) return false;
    const x: V = [p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1]), p[2] + s * (q[2] - p[2])];
    const w1 = dt(cr(sub(b, a), sub(x, a)), n), w2 = dt(cr(sub(c, b), sub(x, b)), n), w3 = dt(cr(sub(a, c), sub(x, c)), n);
    const e = 1e-9 * dt(n, n);
    return w1 > e && w2 > e && w3 > e;
  };
  const bad = new Set<number>();
  for (const [cellKey, list] of grid)
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        const ia = [t[3 * A], t[3 * A + 1], t[3 * A + 2]], ib = [t[3 * B], t[3 * B + 1], t[3 * B + 2]];
        if (ia.some((x) => ib.includes(x))) continue;
        const [ba, bb] = [boxes[A], boxes[B]];
        if (ba[1][0] < bb[0][0] || bb[1][0] < ba[0][0] || ba[1][1] < bb[0][1] || bb[1][1] < ba[0][1] || ba[1][2] < bb[0][2] || bb[1][2] < ba[0][2]) continue;
        // Each pair once: in the cell holding the low corner of where their boxes overlap.
        const own = [0, 1, 2].map((k) => Math.floor(Math.max(ba[0][k], bb[0][k]) / cell)).join(",");
        if (own !== cellKey) continue;
        const pa = ia.map(P), pb = ib.map(P);
        let hit = false;
        for (let k = 0; k < 3 && !hit; k++) hit = segHits(pa[k], pa[(k + 1) % 3], pb[0], pb[1], pb[2]) || segHits(pb[k], pb[(k + 1) % 3], pa[0], pa[1], pa[2]);
        if (hit) {
          bad.add(A);
          bad.add(B);
        }
      }
  return bad.size;
}

const sound = (r: { vertices: number[]; triangles: number[] }) => {
  const a = analyzeMesh(r.vertices, r.triangles);
  expect(a.openEdges).toBe(0);
  expect(a.nonManifoldEdges).toBe(0);
  expect(a.flippedEdges).toBe(0);
  return a;
};

describe("reducing meshes like real downloads", () => {
  it("a plate with an 8 mm and a 3 mm hole keeps flat faces flat and holes round, and Simplify still finds them", () => {
    const holes = [{ x: 20, y: 20, r: 4 }, { x: 45, y: 20, r: 1.5 }];
    const plate = holedPlate(holes, 1500, 20);
    const n = plate.triangles.length / 3;
    expect(n).toBeGreaterThan(100_000);
    for (const target of [25_000, 10_000]) {
      const r = decimate(plate.vertices, plate.triangles, target);
      const a = sound(r);
      expect(Math.abs(a.volume - analyzeMesh(plate.vertices, plate.triangles).volume) / a.volume).toBeLessThan(1e-3);
      // Every corner lies on a face of the part (a plane or a hole's wall) — within 2 µm.
      let worst = 0;
      for (let i = 0; i < r.vertices.length; i += 3) {
        const [x, y, z] = [r.vertices[i], r.vertices[i + 1], r.vertices[i + 2]];
        const d = Math.min(Math.abs(x), Math.abs(60 - x), Math.abs(y), Math.abs(40 - y), Math.abs(z), Math.abs(10 - z), ...holes.map((h) => Math.abs(Math.hypot(x - h.x, y - h.y) - h.r)));
        worst = Math.max(worst, d);
      }
      console.log(`plate → ${target}: worst corner ${worst.toFixed(4)} mm off its face`);
      expect(worst).toBeLessThan(0.002);
      expect(r.triangles.length / 3).toBeLessThanOrEqual(target);
      expect(crossings(r.vertices, r.triangles)).toBe(0);
      const plan = planMesh(r.vertices, r.triangles, SIMPLIFY_TOLERANCES.normal);
      expect(typeof plan).not.toBe("string");
      if (typeof plan === "string") continue;
      const radii = plan.faces.filter((f) => f.surface.kind === "cylinder").map((f) => (f.surface as { radius: number }).radius);
      console.log(`plate ${n} → ${r.triangles.length / 3}: faces ${plan.faces.length}, cylinders ${radii.map((x) => x.toFixed(3)).join(" ")}, gave up ${plan.gaveUp}`);
      expect(radii.some((x) => Math.abs(x - 4) < 0.01)).toBe(true);
      expect(radii.some((x) => Math.abs(x - 1.5) < 0.01)).toBe(true);
      expect(plan.faces.filter((f) => f.surface.kind === "plane").length).toBe(6);
    }
  }, 300_000);

  it("a 1 mm thin-walled cup stays closed with no walls crossing", () => {
    const c = cup(20, 1, 50, 1000, 60);
    const n = c.triangles.length / 3;
    expect(n).toBeGreaterThan(100_000);
    for (const target of [25_000, 10_000, 3_000]) {
      const r = decimate(c.vertices, c.triangles, target);
      const a = sound(r);
      const before = analyzeMesh(c.vertices, c.triangles).volume;
      console.log(`cup ${n} → ${r.triangles.length / 3}: volume ${a.volume.toFixed(1)} vs ${before.toFixed(1)}`);
      expect(r.triangles.length / 3).toBeLessThanOrEqual(target);
      expect(Math.abs(a.volume - before) / before).toBeLessThan(0.002);
      expect(crossings(r.vertices, r.triangles)).toBe(0);
    }
  }, 300_000);

  it("a fine plate with small raised letters keeps them", () => {
    // 100 × 30 plate on a 0.1 mm grid, with eight 1 × 4 mm bars standing 0.6 mm (letters' strokes) as a height field.
    const m = new MeshBuilder();
    const nx = 500, ny = 150, sx = 100 / nx, sy = 30 / ny;
    const raised = (x: number, y: number) => {
      for (let k = 0; k < 8; k++) if (x >= 10 + k * 10 && x <= 11 + k * 10 && y >= 13 && y <= 17) return 0.6;
      return 0;
    };
    const top: number[][] = [], bot: number[][] = [];
    for (let i = 0; i <= nx; i++) {
      top.push([]);
      bot.push([]);
      for (let j = 0; j <= ny; j++) {
        top[i].push(m.point([i * sx, j * sy, 2 + raised(i * sx, j * sy)]));
        bot[i].push(m.point([i * sx, j * sy, 0]));
      }
    }
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        m.quad(top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1], [0, 0, 1]);
        m.quad(bot[i][j], bot[i + 1][j], bot[i + 1][j + 1], bot[i][j + 1], [0, 0, -1]);
      }
    for (let i = 0; i < nx; i++) {
      m.quad(bot[i][0], bot[i + 1][0], top[i + 1][0], top[i][0], [0, -1, 0]);
      m.quad(bot[i][ny], bot[i + 1][ny], top[i + 1][ny], top[i][ny], [0, 1, 0]);
    }
    for (let j = 0; j < ny; j++) {
      m.quad(bot[0][j], bot[0][j + 1], top[0][j + 1], top[0][j], [-1, 0, 0]);
      m.quad(bot[nx][j], bot[nx][j + 1], top[nx][j + 1], top[nx][j], [1, 0, 0]);
    }
    const n = m.triangles.length / 3;
    const before = analyzeMesh(m.vertices, m.triangles).volume;
    const r = decimate(m.vertices, m.triangles, 10_000);
    const a = sound(r);
    // The letters' volume (on the grid as drawn) is what changes if they're lost: a few % of it at most.
    const lettersVolume = before - 100 * 30 * 2;
    console.log(`letters ${n} → ${r.triangles.length / 3}: raised volume ${(a.volume - 6000).toFixed(2)} vs ${lettersVolume.toFixed(2)}`);
    expect(Math.abs(a.volume - before)).toBeLessThan(0.1 * lettersVolume);
    expect(crossings(r.vertices, r.triangles)).toBe(0);
  }, 300_000);

  it("messy downloads: two bodies, duplicate and flipped triangles, a hole in the mesh — reduced without crashing", () => {
    const holes = [{ x: 20, y: 20, r: 4 }];
    const a = holedPlate(holes, 1000, 30);
    const b = cup(10, 1, 20, 600, 30);
    // Second body moved away.
    const verts = [...a.vertices];
    const off = verts.length / 3;
    for (let i = 0; i < b.vertices.length; i += 3) verts.push(b.vertices[i] + 100, b.vertices[i + 1], b.vertices[i + 2]);
    const tris = [...a.triangles, ...b.triangles.map((x) => x + off)];
    // Duplicate a few triangles, flip a few, and take a patch out (a hole in the mesh).
    for (let k = 0; k < 50; k++) tris.push(tris[3 * k * 7], tris[3 * k * 7 + 1], tris[3 * k * 7 + 2]);
    for (let k = 100; k < 150; k++) [tris[3 * k + 1], tris[3 * k + 2]] = [tris[3 * k + 2], tris[3 * k + 1]];
    tris.splice(3 * 5000, 3 * 40);
    const bytes = new Uint8Array(writeBinaryStl([{ vertices: verts, triangles: tris }]));
    const file = reduceStl("messy.stl", bytes, 10_000);
    expect(storedTriangles(file)).toBeLessThanOrEqual(10_000);
    expect(storedTriangles(file)).toBeGreaterThan(5_000);
    // Both bodies still there.
    const back = fromBase64(file.data);
    const view = new DataView(back.buffer, back.byteOffset);
    let far = 0, near = 0;
    for (let t = 0; t < storedTriangles(file); t++) (view.getFloat32(84 + t * 50 + 12, true) > 80 ? far++ : near++);
    expect(far).toBeGreaterThan(100);
    expect(near).toBeGreaterThan(100);
  }, 300_000);
});
