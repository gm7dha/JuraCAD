/**
 * Turning an imported STEP or STL file into solids.
 *
 * Reading a big file is slow, so the result is remembered and each rebuild
 * gets a fresh copy instead of reading the file again.
 */
import { assembleWire, cast, getOC, makeFace, measureVolume, type Edge, type Face, type Shape3D } from "replicad";

import { describeError } from "./engine";
import { solidsOf as listSolids } from "./topology";
import { readBinaryStl, writeBinaryStl } from "../geometry/stl";
import { weld } from "../geometry/threeMf";
import { fromBase64 } from "../model/importFile";
import { SIMPLIFY_TOLERANCES, simplifyReport, type SimplifiedFace, type SimplifyLevel, type SimplifySummary } from "../model/simplify";
import type { ImportedFile } from "../model/types";
import { checkedUnify, describeFaces, meshSummary, simplifyShape, solidFromFacets, solidFromMesh } from "./simplify";
import { MAX_TRIANGLES, NOTHING_TO_TIDY, TOO_DETAILED } from "../geometry/meshSimplify";

const cache = new Map<string, Shape3D[]>();
/** The summary of what simplifying an imported file did, by its cache key. */
const reports = new Map<string, string>();
/** The imported shapes that are surfaces (skins) rather than solids. */
const surfaceShapes = new WeakSet<Shape3D>();
/** Whether an imported shape (as `importSolids` returned it) is a surface rather than a solid. */
export const isImportedSurface = (shape: Shape3D): boolean => surfaceShapes.has(shape);
const CACHE_SIZE = 4;

let fileCounter = 0;

/* eslint-disable @typescript-eslint/no-explicit-any */
function withFile<T>(bytes: Uint8Array, use: (name: string) => T): T {
  const oc = getOC() as any;
  const name = `juracad-import-${++fileCounter}`;
  oc.FS.writeFile(`/${name}`, bytes);
  try {
    return use(name);
  } finally {
    try {
      oc.FS.unlink(`/${name}`);
    } catch {
      /* already gone */
    }
  }
}

/** The solids in a shape (a STEP file may hold several parts). */
function solidsOf(shape: Shape3D): Shape3D[] {
  return listSolids(shape);
}

function readStep(text: string): Shape3D[] {
  const oc = getOC() as any;
  return withFile(new TextEncoder().encode(text), (name) => {
    oc.Interface_Static.SetCVal("xstep.cascade.unit", "MM");
    const reader = new oc.STEPControl_Reader();
    try {
      const status = reader.ReadFile(name);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("The STEP file couldn't be read — it may be damaged.");
      reader.TransferRoots();
      const whole = cast(reader.OneShape()) as Shape3D;
      const solids = solidsOf(whole);
      // Surfaces: shells that aren't part of a solid, and faces in no shell, as one skin.
      const skins: Shape3D[] = [];
      for (const [kind, within] of [["TopAbs_SHELL", "TopAbs_SOLID"], ["TopAbs_FACE", "TopAbs_SHELL"]] as const) {
        const explorer = new oc.TopExp_Explorer(whole.wrapped, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum[within]);
        for (; explorer.More(); explorer.Next()) skins.push(cast(explorer.Current()) as Shape3D);
        explorer.delete();
      }
      whole.delete();
      if (solids.length === 0 && skins.length === 0) {
        throw new Error("The STEP file has no parts in it — no solids and no surfaces.");
      }
      if (skins.length) {
        const sewing = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
        for (const k of skins) sewing.Add(k.wrapped);
        sewing.Perform();
        const skin = cast(sewing.SewedShape()) as Shape3D;
        sewing.delete();
        skins.forEach((k) => k.delete());
        surfaceShapes.add(skin);
        solids.push(skin);
      }
      return solids;
    } finally {
      reader.delete();
    }
  });
}

/** Corner positions (x, y, z per corner, three corners per triangle) from a binary or text STL. */
function stlCorners(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84 && bytes.length === 84 + view.getUint32(80, true) * 50) {
    const copy = bytes.slice().buffer;
    return readBinaryStl(copy).vertices;
  }
  const text = new TextDecoder().decode(bytes);
  const num = "([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)";
  const re = new RegExp(`vertex\\s+${num}\\s+${num}\\s+${num}`, "g");
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  return new Float32Array(out);
}

/**
 * An STL is just triangles. Each one becomes a flat face sharing its edges with
 * its neighbours; each separate body is closed up into a solid of its own (or,
 * if it isn't closed, brought in as a surface), and flat areas made of many
 * triangles are joined back into single faces.
 */
function readStl(bytes: Uint8Array, units: ImportedFile["units"]): Shape3D[] {
  const scale = units === "in" ? 25.4 : 1;
  const raw = stlCorners(bytes);
  const indices = Array.from({ length: raw.length / 3 }, (_, i) => i);
  const { vertices, triangles } = weld(raw, indices);
  if (triangles.length === 0) throw new Error("The STL file has no usable triangles in it.");
  const point = (i: number): [number, number, number] => [vertices[i * 3] * scale, vertices[i * 3 + 1] * scale, vertices[i * 3 + 2] * scale];

  const oc = getOC() as any;
  // Corners and edges are made once and shared by the triangles that meet there,
  // so the triangles join up into one connected surface.
  const garbage: { delete(): void }[] = [];
  const corners = new Map<number, any>();
  const corner = (i: number) => {
    let v = corners.get(i);
    if (!v) {
      const [x, y, z] = point(i);
      const pnt = new oc.gp_Pnt(x, y, z);
      const maker = new oc.BRepBuilderAPI_MakeVertex(pnt);
      v = maker.Vertex();
      maker.delete();
      pnt.delete();
      corners.set(i, v);
    }
    return v;
  };
  const edges = new Map<string, Edge>();
  const faces: Face[] = [];
  /** The edge from corner a to corner b (the shared edge, turned round if needed). */
  const edge = (a: number, b: number): { e: Edge; temporary: boolean } => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo},${hi}`;
    let e = edges.get(key);
    if (!e) {
      const maker = new oc.BRepBuilderAPI_MakeEdge(corner(lo), corner(hi));
      e = cast(maker.Edge()) as Edge;
      maker.delete();
      edges.set(key, e);
    }
    return a === lo ? { e, temporary: false } : { e: cast(e.wrapped.Reversed()) as Edge, temporary: true };
  };
  try {
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
      const sides = [edge(a, b), edge(b, c), edge(c, a)];
      const wire = assembleWire(sides.map((x) => x.e));
      let face: Face;
      try {
        face = makeFace(wire);
      } finally {
        wire.delete();
        // Turned-round copies of shared edges are only needed for the wire.
        sides.forEach((x) => x.temporary && x.e.delete());
      }
      // Make the face point the way the triangle does (outwards), whichever way OpenCascade chose.
      const [pa, pb, pc] = [point(a), point(b), point(c)];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const want = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const n = face.normalAt();
      const dot = n.x * want[0] + n.y * want[1] + n.z * want[2];
      n.delete();
      if (dot < 0) {
        const flipped = cast(face.wrapped.Reversed()) as Face;
        face.delete();
        face = flipped;
      }
      faces.push(face);
    }
    // Separate bodies in the file (triangles that don't touch) become separate parts.
    const count = triangles.length / 3;
    const parent = Array.from({ length: vertices.length / 3 }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let t = 0; t < triangles.length; t += 3) {
      const r = find(triangles[t]);
      parent[find(triangles[t + 1])] = r;
      parent[find(triangles[t + 2])] = r;
    }
    const groups = new Map<number, number[]>();
    for (let k = 0; k < count; k++) {
      const g = find(triangles[3 * k]);
      const list = groups.get(g);
      if (list) list.push(k);
      else groups.set(g, [k]);
    }
    const simplify = count <= SIMPLIFY_LIMIT;
    const solids: Shape3D[] = [];
    const open: Shape3D[] = [];
    for (const members of groups.values()) {
      // The triangles already share their edges, so they can go straight into one shell.
      const builder = new oc.TopoDS_Builder();
      garbage.push(builder);
      const shell = new oc.TopoDS_Shell();
      garbage.push(shell);
      builder.MakeShell(shell);
      for (const k of members) builder.Add(shell, faces[k].wrapped);
      // Closed (watertight) when every edge is shared by exactly two of its triangles.
      const uses = new Map<string, number>();
      for (const k of members) {
        const [a, b, c] = [triangles[3 * k], triangles[3 * k + 1], triangles[3 * k + 2]];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const key = p < q ? `${p},${q}` : `${q},${p}`;
          uses.set(key, (uses.get(key) ?? 0) + 1);
        }
      }
      const closed = [...uses.values()].every((n) => n === 2);
      if (!closed) {
        // An open mesh: brought in as a surface (a skin with no inside).
        open.push(cast(oc.TopoDS.Shell(shell)) as Shape3D);
        continue;
      }
      const maker = new oc.BRepBuilderAPI_MakeSolid();
      garbage.push(maker);
      maker.Add(shell);
      let solid = cast(maker.Solid()) as Shape3D;
      try {
        if (measureVolume(solid) < 0) {
          const flipped = cast(solid.wrapped.Reversed()) as Shape3D;
          solid.delete();
          solid = flipped;
        }
      } catch {
        /* keep it as it is */
      }
      // Join the triangles that lie flat together into single faces (slow on very detailed meshes, where it rarely helps).
      if (simplify) {
        try {
          solid = solid.simplify();
        } catch {
          /* keep the triangles */
        }
      }
      solids.push(solid);
    }
    if (open.length) {
      // All the open pieces together, as one surface part.
      const builder = new oc.TopoDS_Builder();
      garbage.push(builder);
      const compound = new oc.TopoDS_Compound();
      builder.MakeCompound(compound);
      for (const o of open) builder.Add(compound, o.wrapped);
      const skin = cast(compound) as Shape3D;
      open.forEach((o) => o.delete());
      surfaceShapes.add(skin);
      solids.push(skin);
    }
    return solids;
  } catch (e) {
    throw new Error(`The STL file couldn't be turned into a solid. Check it's a closed (watertight) shape. (${describeError(e, "unknown")})`);
  } finally {
    faces.forEach((f) => f.delete());
    edges.forEach((e) => e.delete());
    corners.forEach((v) => v.delete());
    garbage.reverse().forEach((g) => {
      try {
        g.delete();
      } catch {
        /* already gone */
      }
    });
  }
}

/** The triangles of an STL, scaled to mm and welded, split into separate bodies (closed or not). */
function stlBodies(bytes: Uint8Array, units: ImportedFile["units"]): { vertices: number[]; triangles: number[]; closed: boolean }[] {
  const scale = units === "in" ? 25.4 : 1;
  const raw = stlCorners(bytes);
  const indices = Array.from({ length: raw.length / 3 }, (_, i) => i);
  const { vertices, triangles } = weld(raw, indices);
  if (triangles.length === 0) throw new Error("The STL file has no usable triangles in it.");
  const parent = Array.from({ length: vertices.length / 3 }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < triangles.length; t += 3) {
    const r = find(triangles[t]);
    parent[find(triangles[t + 1])] = r;
    parent[find(triangles[t + 2])] = r;
  }
  const bodies = new Map<number, number[]>();
  for (let t = 0; t < triangles.length; t += 3) {
    const g = find(triangles[t]);
    const list = bodies.get(g);
    if (list) list.push(t);
    else bodies.set(g, [t]);
  }
  return [...bodies.values()].map((tris) => {
    const remap = new Map<number, number>();
    const vs: number[] = [];
    const ts: number[] = [];
    const uses = new Map<string, number>();
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const v = triangles[t + k];
        let j = remap.get(v);
        if (j === undefined) {
          j = vs.length / 3;
          remap.set(v, j);
          vs.push(vertices[3 * v] * scale, vertices[3 * v + 1] * scale, vertices[3 * v + 2] * scale);
        }
        ts.push(j);
        const a = triangles[t + k];
        const b = triangles[t + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    return { vertices: vs, triangles: ts, closed: [...uses.values()].every((n) => n === 2) };
  });
}

/** All the summaries of several bodies as one. */
function joinSummaries(list: SimplifySummary[]): SimplifySummary {
  const any = (k: "fellBack" | "unchanged" | "nothingFound" | "failed") => (list.some((x) => x[k]) ? { [k]: true } : {});
  const sum = (k: "openBodies" | "gaveUp") => {
    const n = list.reduce((t, x) => t + (x[k] ?? 0), 0);
    return n ? { [k]: n } : {};
  };
  return {
    facesBefore: list.reduce((n, x) => n + x.facesBefore, 0),
    faces: list.flatMap((x) => x.faces),
    recognised: list.some((x) => x.recognised),
    ...any("fellBack"),
    ...any("unchanged"),
    ...any("nothingFound"),
    ...any("failed"),
    ...sum("openBodies"),
    ...sum("gaveUp"),
    // Only when nothing at all was tidied.
    ...(list.length && list.every((x) => x.tooDetailed) ? { tooDetailed: true } : {}),
  };
}

/** Each face of an imported surface (a skin), counted as left as mesh. */
const skinFaces = (shape: Shape3D) => describeFaces(shape).map((f) => ({ ...f, mesh: true }));

/**
 * An STL tidied into real faces: each closed body straight from its triangles
 * to exact faces (without first making a face of every triangle, which is
 * the slow part of an ordinary STL import). Bodies that can't be done that
 * way, or aren't closed, are read as usual (closed ones with their flat areas
 * joined, if that leaves them sound).
 */
function readStlSimplified(bytes: Uint8Array, units: ImportedFile["units"], level: SimplifyLevel): { shapes: Shape3D[]; summary: SimplifySummary } {
  const tol = SIMPLIFY_TOLERANCES[level];
  const bodies = stlBodies(bytes, units);
  const triangles = bodies.reduce((n, b) => n + b.triangles.length / 3, 0);
  if (triangles > MAX_TRIANGLES) {
    const shapes = readStl(bytes, units);
    return { shapes, summary: { facesBefore: triangles, faces: [], recognised: false, tooDetailed: true } };
  }
  const shapes: Shape3D[] = [];
  const summaries: SimplifySummary[] = [];
  /** Bodies read as usual, and why. */
  const rest: { vertices: number[]; triangles: number[] }[] = [];
  let open = 0;
  let detailed = false;
  let nothing = false;
  let failed = false;
  for (const b of bodies) {
    if (!b.closed) {
      open++;
      rest.push(b);
      continue;
    }
    const r = solidFromMesh(b.vertices, b.triangles, tol);
    if (typeof r !== "string") {
      shapes.push(r.shape);
      summaries.push(meshSummary(b.triangles.length / 3, r));
      continue;
    }
    if (r === TOO_DETAILED) detailed = true;
    else if (r === NOTHING_TO_TIDY) nothing = true;
    else failed = true;
    rest.push(b);
  }
  if (rest.length) {
    // The rest together, read as an ordinary STL (already in mm).
    const restBytes = new Uint8Array(writeBinaryStl(rest));
    const facesBefore = rest.reduce((n, b) => n + b.triangles.length / 3, 0);
    const faces: SimplifiedFace[] = [];
    let unchanged = false;
    for (const shape of readStl(restBytes, "mm")) {
      // Only where rebuilding failed is joining worth another go (an ordinary import already joins flat areas).
      if (surfaceShapes.has(shape) || !failed) {
        faces.push(...(surfaceShapes.has(shape) ? skinFaces(shape) : describeFaces(shape)));
        shapes.push(shape);
        continue;
      }
      const joined = checkedUnify(shape, tol);
      shape.delete();
      if (!joined.ok) unchanged = true;
      faces.push(...describeFaces(joined.shape));
      shapes.push(joined.shape);
    }
    summaries.push({
      facesBefore,
      faces,
      recognised: false,
      ...(open ? { openBodies: open } : {}),
      ...(failed ? { fellBack: true } : {}),
      ...(nothing ? { nothingFound: true } : {}),
      ...(unchanged ? { unchanged: true } : {}),
      ...(detailed && !open && !failed && !nothing ? { tooDetailed: true } : {}),
    });
  }
  // Surfaces last (as an ordinary import puts them).
  shapes.sort((a, b) => Number(surfaceShapes.has(a)) - Number(surfaceShapes.has(b)));
  return { shapes, summary: joinSummaries(summaries) };
}

/** Above this many triangles, flat areas aren't joined back into single faces. */
const SIMPLIFY_LIMIT = 20_000;

/* eslint-enable @typescript-eslint/no-explicit-any */

/** A short name for an imported file's contents, so the same file is recognised again. */
export function importKey(file: ImportedFile): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  const d = file.data;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${file.format}|${file.units}|${d.length}|${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** The cache key of an imported file, tidied at a level (or not). */
export const importCacheKey = (file: ImportedFile, simplify?: SimplifyLevel) => importKey(file) + (simplify ? `|simplify:${simplify}` : "");

/** The file's solids, tidied into real faces (see simplify.ts), and what that did; as an ordinary import if tidying fails. */
function readSimplified(file: ImportedFile, level: SimplifyLevel): { shapes: Shape3D[]; summary: SimplifySummary } {
  try {
    return tidiedFile(file, level);
  } catch {
    // (A file that can't be read at all says so as usual.)
    const shapes = readPlain(file);
    return { shapes, summary: { facesBefore: 0, faces: [], recognised: false, failed: true } };
  }
}

const readPlain = (file: ImportedFile) => (file.format === "step" ? readStep(file.data) : readStl(fromBase64(file.data), file.units));

function tidiedFile(file: ImportedFile, level: SimplifyLevel): { shapes: Shape3D[]; summary: SimplifySummary } {
  if (file.format === "stl") return readStlSimplified(fromBase64(file.data), file.units, level);
  const shapes = readStep(file.data);
  const summaries: SimplifySummary[] = [];
  const out = shapes.map((shape) => {
    if (surfaceShapes.has(shape)) {
      // Many mesh-like STEP files hold their triangles as a skin, not a solid: if they close up, a solid of real faces.
      const r = solidFromFacets(shape, level);
      if (!r) return shape;
      shape.delete();
      summaries.push(r.summary);
      return r.shape;
    }
    const r = simplifyShape(shape, level);
    shape.delete();
    summaries.push(r.summary);
    return r.shape;
  });
  return { shapes: out, summary: joinSummaries(summaries) };
}

/** What simplifying an imported file did (after importSolids with the same level), as a short summary. */
export function importReport(file: ImportedFile, simplify: SimplifyLevel): string | undefined {
  return reports.get(importCacheKey(file, simplify));
}

/** The solids in an imported file (fresh copies the caller owns), tidied into real faces with `simplify`. */
export function importSolids(file: ImportedFile, simplify?: SimplifyLevel): Shape3D[] {
  const key = importCacheKey(file, simplify);
  let solids = cache.get(key);
  if (!solids) {
    if (simplify) {
      const r = readSimplified(file, simplify);
      solids = r.shapes;
      reports.set(key, simplifyReport(r.summary));
    } else solids = readPlain(file);
    cache.set(key, solids);
    while (cache.size > CACHE_SIZE) {
      const [oldest, old] = cache.entries().next().value as [string, Shape3D[]];
      cache.delete(oldest);
      reports.delete(oldest);
      old.forEach((s) => s.delete());
    }
  } else {
    // Most recently used goes to the back.
    cache.delete(key);
    cache.set(key, solids);
  }
  return solids.map((s) => {
    const copy = s.clone();
    if (surfaceShapes.has(s)) surfaceShapes.add(copy);
    return copy;
  });
}
