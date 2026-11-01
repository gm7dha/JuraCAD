/**
 * A box-shaped part as the geometry engine would send it (display mesh plus
 * exact face and edge data), made by hand so assembly tests can use real
 * mate connectors without running the engine: every face's centre and
 * direction, and every edge, are exact.
 */
import type { PartMesh } from "../../src/kernel/protocol";
import type { TopoPick } from "../../src/geometry/topoRef";

type V = [number, number, number];

/** A box from `min` to `max` (mm), in its own coordinates. */
export function boxMesh(id: string, min: V, max: V, name = id): PartMesh {
  const vertices: number[] = [];
  const normals: number[] = [];
  const triangles: number[] = [];
  const faceGroups: PartMesh["faceGroups"] = [];
  const faceRefs: PartMesh["faceRefs"] = [];
  const c = (k: number, hi: boolean) => (hi ? max[k] : min[k]);
  // Each face: square to axis k, on the low or high side; u and v the other two axes (u × v = outwards).
  for (const k of [0, 1, 2]) {
    for (const hi of [false, true]) {
      const u = (k + 1) % 3;
      const v = (k + 2) % 3;
      const n: V = [0, 0, 0];
      n[k] = hi ? 1 : -1;
      const corner = (a: boolean, b: boolean): V => {
        const p: V = [0, 0, 0];
        p[k] = c(k, hi);
        p[u] = c(u, a);
        p[v] = c(v, b);
        return p;
      };
      const base = vertices.length / 3;
      for (const p of [corner(false, false), corner(true, false), corner(true, true), corner(false, true)]) {
        vertices.push(...p);
        normals.push(...n);
      }
      const start = triangles.length;
      // (Wound so the triangles face outwards.)
      if (hi) triangles.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else triangles.push(base, base + 2, base + 1, base, base + 3, base + 2);
      faceGroups.push({ start, count: 6, faceId: faceGroups.length + 1 });
      const centre: V = [0, 0, 0];
      centre[k] = c(k, hi);
      centre[u] = (min[u] + max[u]) / 2;
      centre[v] = (min[v] + max[v]) / 2;
      faceRefs.push({ kind: "face", surface: "PLANE", center: centre, normal: n });
    }
  }
  const lines: number[] = [];
  const edgeGroups: PartMesh["edgeGroups"] = [];
  const edgeRefs: PartMesh["edgeRefs"] = [];
  for (const k of [0, 1, 2]) {
    const u = (k + 1) % 3;
    const v = (k + 2) % 3;
    for (const a of [false, true])
      for (const b of [false, true]) {
        const p: V = [0, 0, 0];
        p[u] = c(u, a);
        p[v] = c(v, b);
        const q: V = [...p];
        p[k] = min[k];
        q[k] = max[k];
        edgeGroups.push({ start: lines.length / 3, count: 2, edgeId: edgeGroups.length + 1 });
        lines.push(...p, ...q);
        edgeRefs.push({ kind: "edge", curve: "LINE", a: p, b: q, mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] });
      }
  }
  return {
    id,
    name,
    featureIds: [id],
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals),
    triangles: new Uint32Array(triangles),
    faceGroups,
    lines: new Float32Array(lines),
    edgeGroups,
    faceRefs,
    edgeRefs,
  };
}

/** The flat face of a box pointing along `normal` (e.g. [0, 0, 1] for its top). */
export function boxFace(mesh: PartMesh, normal: V): TopoPick {
  const ref = mesh.faceRefs.find((r) => r.normal.every((v, k) => v === normal[k]));
  if (!ref) throw new Error(`no face along ${normal.join(",")}`);
  return { partId: mesh.id, ref };
}

/** A part's mesh and exact data moved by a placement (to make a part drawn at a slant); the exact data rounded to 0.0001 mm, as the engine sends it. */
export function movedMesh(mesh: PartMesh, p: { position: V; rotation: [number, number, number, number] }, id = mesh.id): PartMesh {
  const r4 = (v: V): V => v.map((x) => Math.round(x * 1e4) / 1e4) as V;
  const turn = (v: readonly number[]): V => {
    const [x, y, z, w] = p.rotation;
    const [vx, vy, vz] = v;
    // v + 2w (q × v) + 2 q × (q × v)
    const cx = y * vz - z * vy;
    const cy = z * vx - x * vz;
    const cz = x * vy - y * vx;
    const dx = y * cz - z * cy;
    const dy = z * cx - x * cz;
    const dz = x * cy - y * cx;
    return [vx + 2 * (w * cx + dx), vy + 2 * (w * cy + dy), vz + 2 * (w * cz + dz)];
  };
  const place = (v: readonly number[]): V => {
    const r = turn(v);
    return [r[0] + p.position[0], r[1] + p.position[1], r[2] + p.position[2]];
  };
  const each = (a: Float32Array, f: (v: readonly number[]) => V) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) out.set(f([a[i], a[i + 1], a[i + 2]]), i);
    return out;
  };
  return {
    ...mesh,
    id,
    vertices: each(mesh.vertices, place),
    normals: each(mesh.normals, turn),
    lines: each(mesh.lines, place),
    faceRefs: mesh.faceRefs.map((f) => ({ ...f, center: r4(place(f.center)), normal: r4(turn(f.normal)) })),
    edgeRefs: mesh.edgeRefs.map((e) => ({ ...e, a: r4(place(e.a)), b: r4(place(e.b)), mid: r4(place(e.mid)) })),
  };
}
