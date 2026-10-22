/**
 * Faces and edges of a part, numbered and described so Claude can choose
 * them ("F3", "the top face", "edges along Z"), and turned into the same
 * picks the app stores when you click a face or edge (see geometry/topoRef.ts),
 * so a fillet made here survives later changes just as one made in the app.
 */
import type { EdgeRef, FaceRef, TopoPick, Vec3 } from "../geometry/topoRef";
import type { PartMesh } from "../kernel/protocol";
import { InputError } from "./args";

export interface FaceInfo {
  id: string;
  ref: FaceRef;
  area: number;
  kind: string;
}

export interface EdgeInfo {
  id: string;
  ref: EdgeRef;
  length: number;
  kind: string;
}

type MeshLike = Pick<PartMesh, "id" | "name" | "vertices" | "triangles" | "faceGroups" | "faceRefs" | "lines" | "edgeGroups" | "edgeRefs">;

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const fmt = (p: Vec3) => `(${p.map(r2).join(", ")})`;

export const DIRECTION_WORDS: Record<string, Vec3> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

/** "+Z (top)" for a normal along an axis, or the normal's numbers. */
export function facing(n: Vec3): string {
  for (const [word, d] of Object.entries(DIRECTION_WORDS)) {
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0.999) {
      const axis = d[0] ? "X" : d[1] ? "Y" : "Z";
      const sign = d[0] + d[1] + d[2] > 0 ? "+" : "−";
      return `${sign}${axis} (${word})`;
    }
  }
  return fmt(n);
}

const KIND_FACE: Record<string, string> = { PLANE: "flat", CYLINDRE: "round (cylinder)", CONE: "cone", SPHERE: "ball", TORUS: "torus (rounded)" };
const KIND_EDGE: Record<string, string> = { LINE: "straight", CIRCLE: "circular", ELLIPSE: "elliptical" };

export function faceList(part: MeshLike): FaceInfo[] {
  return part.faceRefs.map((ref, i) => {
    const g = part.faceGroups[i];
    let area = 0;
    if (g) {
      const V = part.vertices;
      for (let t = g.start; t + 2 < g.start + g.count; t += 3) {
        const [a, b, c] = [part.triangles[t], part.triangles[t + 1], part.triangles[t + 2]];
        const u = [V[3 * b] - V[3 * a], V[3 * b + 1] - V[3 * a + 1], V[3 * b + 2] - V[3 * a + 2]];
        const w = [V[3 * c] - V[3 * a], V[3 * c + 1] - V[3 * a + 1], V[3 * c + 2] - V[3 * a + 2]];
        area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
      }
    }
    return { id: `F${i + 1}`, ref, area, kind: KIND_FACE[ref.surface] ?? "curved" };
  });
}

export function edgeList(part: MeshLike): EdgeInfo[] {
  return part.edgeRefs.map((ref, i) => {
    const g = part.edgeGroups[i];
    let length = 0;
    if (g) {
      const L = part.lines;
      for (let k = g.start; k + 1 < g.start + g.count; k += 2) {
        length += Math.hypot(L[3 * k + 3] - L[3 * k], L[3 * k + 4] - L[3 * k + 1], L[3 * k + 5] - L[3 * k + 2]);
      }
    }
    const closed = Math.hypot(ref.a[0] - ref.b[0], ref.a[1] - ref.b[1], ref.a[2] - ref.b[2]) < 1e-6;
    const kind = ref.curve === "CIRCLE" && closed ? "circle" : ref.curve === "CIRCLE" ? "arc" : KIND_EDGE[ref.curve] ?? "curved";
    return { id: `E${i + 1}`, ref, length, kind };
  });
}

export function describeFace(f: FaceInfo): string {
  const where = f.ref.surface === "PLANE" ? `facing ${facing(f.ref.normal)}` : `centre`;
  return `${f.id}: ${f.kind} face, ${where}${f.ref.surface === "PLANE" ? ", centre" : ""} ${fmt(f.ref.center)}, area ${r2(f.area)} mm²`;
}

export function describeEdge(e: EdgeInfo): string {
  const r = e.ref;
  if (e.kind === "straight") {
    const d: Vec3 = [r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]];
    const l = Math.hypot(...d) || 1;
    const axis = [0, 1, 2].find((k) => Math.abs(d[k]) / l > 0.999);
    const along = axis === undefined ? "" : ` along ${"XYZ"[axis]}`;
    return `${e.id}: straight edge${along} from ${fmt(r.a)} to ${fmt(r.b)}, ${r2(e.length)} mm`;
  }
  if (e.kind === "circle") return `${e.id}: circle through ${fmt(r.a)}, about ${r2(e.length / Math.PI)} mm across, length ${r2(e.length)} mm`;
  return `${e.id}: ${e.kind} edge from ${fmt(r.a)} to ${fmt(r.b)} through ${fmt(r.mid)}, ${r2(e.length)} mm`;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The outermost flat face facing a direction (the biggest, if several are level). */
function outermostFace(faces: FaceInfo[], word: string): FaceInfo | null {
  const d = DIRECTION_WORDS[word];
  const flat = faces.filter((f) => f.ref.surface === "PLANE" && dot(f.ref.normal, d) > 0.999);
  if (!flat.length) return null;
  const far = Math.max(...flat.map((f) => dot(f.ref.center, d)));
  return flat.filter((f) => dot(f.ref.center, d) > far - 1e-4).sort((a, b) => b.area - a.area)[0];
}

const FACE_HELP =
  'Choose faces as "F3" (numbers from list_faces), "top", "bottom", "front", "back", "left" or "right" (the outermost flat face facing that way: top = +Z, front = −Y, right = +X), or {"near":[x,y,z]} (the face whose centre is closest).';
const EDGE_HELP =
  'Choose edges as "E5" (numbers from list_edges); a face ("F3", "top"…) meaning all its edges; "along x", "along y" or "along z" (every straight edge in that direction); "circles" (every round edge); "all"; or {"near":[x,y,z]} (the edge whose middle is closest).';

function nearPoint(sel: unknown, where: string): Vec3 | null {
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) return null;
  const near = (sel as { near?: unknown }).near;
  if (!Array.isArray(near) || near.length !== 3 || !near.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new InputError(`${where}: {"near": [x, y, z]} needs three numbers.`);
  }
  return near as Vec3;
}

function oneFace(part: MeshLike, faces: FaceInfo[], sel: unknown, where: string): FaceInfo {
  const p = nearPoint(sel, where);
  if (p) {
    if (!faces.length) throw new InputError(`${part.name} has no faces.`);
    return [...faces].sort((a, b) => dist(a.ref.center, p) - dist(b.ref.center, p))[0];
  }
  if (typeof sel !== "string") throw new InputError(`${where}: ${FACE_HELP}`);
  const s = sel.trim().toLowerCase().replace(/ face$/, "");
  const numbered = /^f(\d+)$/.exec(s);
  if (numbered) {
    const f = faces[Number(numbered[1]) - 1];
    if (!f) throw new InputError(`${where}: ${part.name} has faces F1 to F${faces.length}, so "${sel}" doesn't exist. Use list_faces to see them.`);
    return f;
  }
  if (s in DIRECTION_WORDS) {
    const f = outermostFace(faces, s);
    if (!f) throw new InputError(`${where}: ${part.name} has no flat face facing ${s}. Use list_faces to see its faces.`);
    return f;
  }
  throw new InputError(`${where}: "${sel}" isn't a face. ${FACE_HELP}`);
}

export function pickFaces(part: MeshLike, selectors: unknown[], where: string): TopoPick[] {
  const faces = faceList(part);
  const out: TopoPick[] = [];
  selectors.forEach((sel, i) => {
    const f = oneFace(part, faces, sel, `${where}[${i}]`);
    if (!out.some((p) => p.ref === f.ref)) out.push({ partId: part.id, ref: f.ref });
  });
  return out;
}

/** The one face picked, with its information (for sketching on it or extruding up to it). */
export function pickFace(part: MeshLike, selector: unknown, where: string): FaceInfo {
  return oneFace(part, faceList(part), selector, where);
}

/** Edges (and faces, meaning all their edges — Fillet and Chamfer take those too). */
export function pickEdges(part: MeshLike, selectors: unknown[], where: string): TopoPick[] {
  const edges = edgeList(part);
  const faces = faceList(part);
  const out: TopoPick[] = [];
  const add = (ref: EdgeRef | FaceRef) => {
    if (!out.some((p) => p.ref === ref)) out.push({ partId: part.id, ref });
  };
  selectors.forEach((sel, i) => {
    const w = `${where}[${i}]`;
    const p = nearPoint(sel, w);
    if (p) {
      if (!edges.length) throw new InputError(`${part.name} has no edges.`);
      add([...edges].sort((a, b) => dist(a.ref.mid, p) - dist(b.ref.mid, p))[0].ref);
      return;
    }
    if (typeof sel !== "string") throw new InputError(`${w}: ${EDGE_HELP}`);
    const s = sel.trim().toLowerCase();
    const numbered = /^e(\d+)$/.exec(s);
    if (numbered) {
      const e = edges[Number(numbered[1]) - 1];
      if (!e) throw new InputError(`${w}: ${part.name} has edges E1 to E${edges.length}, so "${sel}" doesn't exist. Use list_edges to see them.`);
      add(e.ref);
      return;
    }
    const along = /^(?:along|parallel to|edges along)\s+([xyz])$|^(vertical)$/.exec(s);
    if (along) {
      const k = along[2] ? 2 : "xyz".indexOf(along[1]);
      const hits = edges.filter((e) => {
        if (e.kind !== "straight") return false;
        const d: Vec3 = [e.ref.b[0] - e.ref.a[0], e.ref.b[1] - e.ref.a[1], e.ref.b[2] - e.ref.a[2]];
        return Math.abs(d[k]) / (Math.hypot(...d) || 1) > 0.999;
      });
      if (!hits.length) throw new InputError(`${w}: ${part.name} has no straight edges along ${"XYZ"[k]}. Use list_edges to see its edges.`);
      hits.forEach((e) => add(e.ref));
      return;
    }
    if (s === "circles" || s === "circular" || s === "round") {
      const hits = edges.filter((e) => e.kind === "circle" || e.kind === "arc");
      if (!hits.length) throw new InputError(`${w}: ${part.name} has no round edges.`);
      hits.forEach((e) => add(e.ref));
      return;
    }
    if (s === "all") {
      edges.forEach((e) => add(e.ref));
      return;
    }
    // A face: all of its edges.
    try {
      add(oneFace(part, faces, sel, w).ref);
    } catch {
      throw new InputError(`${w}: "${sel}" isn't an edge. ${EDGE_HELP}`);
    }
  });
  return out;
}

export const PICK_HELP = { faces: FACE_HELP, edges: EDGE_HELP };
