/**
 * Turning an imported STEP or STL file into solids.
 *
 * Reading a big file is slow, so the result is remembered and each rebuild
 * gets a fresh copy instead of reading the file again.
 */
import { assembleWire, cast, getOC, makeFace, makeLine, makeSolid, measureVolume, type Edge, type Face, type Shape3D } from "replicad";

import { readBinaryStl } from "../geometry/stl";
import { weld } from "../geometry/threeMf";
import { fromBase64 } from "../model/importFile";
import type { ImportedFile } from "../model/types";

const cache = new Map<string, Shape3D[]>();
const CACHE_SIZE = 4;

let fileCounter = 0;

/* eslint-disable @typescript-eslint/no-explicit-any */
function withFile<T>(bytes: Uint8Array, use: (name: string) => T): T {
  const oc = getOC() as any;
  const name = `partsmith-import-${++fileCounter}`;
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
  const solids = (shape as unknown as { solids: Shape3D[] }).solids;
  return solids;
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
      whole.delete();
      if (solids.length === 0) {
        throw new Error("The STEP file has no solid parts in it — only surfaces, which PartSmith can't use yet.");
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
 * its neighbours; together they're closed up into a solid, and flat areas made
 * of many triangles are joined back into single faces.
 */
function readStl(bytes: Uint8Array, units: ImportedFile["units"]): Shape3D[] {
  const scale = units === "in" ? 25.4 : 1;
  const corners = stlCorners(bytes);
  const indices = Array.from({ length: corners.length / 3 }, (_, i) => i);
  const { vertices, triangles } = weld(corners, indices);
  if (triangles.length === 0) throw new Error("The STL file has no usable triangles in it.");
  const point = (i: number): [number, number, number] => [vertices[i * 3] * scale, vertices[i * 3 + 1] * scale, vertices[i * 3 + 2] * scale];

  const edges = new Map<string, Edge>();
  const faces: Face[] = [];
  const edge = (a: number, b: number): Edge => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let e = edges.get(key);
    if (!e) {
      e = makeLine(point(Math.min(a, b)), point(Math.max(a, b)));
      edges.set(key, e);
    }
    return e;
  };
  try {
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
      const wire = assembleWire([edge(a, b), edge(b, c), edge(c, a)]);
      try {
        faces.push(makeFace(wire));
      } finally {
        wire.delete();
      }
    }
    let solid: Shape3D;
    try {
      solid = makeSolid(faces);
    } catch {
      throw new Error("The STL file couldn't be turned into a solid. Check it's a closed (watertight) shape.");
    }
    // Join the triangles that lie flat together into single faces.
    try {
      solid = solid.simplify();
    } catch {
      /* keep the triangles */
    }
    try {
      if (measureVolume(solid) < 0) {
        const flipped = cast(solid.wrapped.Reversed()) as Shape3D;
        solid.delete();
        solid = flipped;
      }
    } catch {
      /* keep it as it is */
    }
    return [solid];
  } finally {
    faces.forEach((f) => f.delete());
    edges.forEach((e) => e.delete());
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The solids in an imported file (fresh copies the caller owns). */
export function importSolids(file: ImportedFile): Shape3D[] {
  const key = `${file.format}|${file.units}|${file.data}`;
  let solids = cache.get(key);
  if (!solids) {
    solids = file.format === "step" ? readStep(file.data) : readStl(fromBase64(file.data), file.units);
    cache.set(key, solids);
    while (cache.size > CACHE_SIZE) {
      const [oldest, old] = cache.entries().next().value as [string, Shape3D[]];
      cache.delete(oldest);
      old.forEach((s) => s.delete());
    }
  } else {
    // Most recently used goes to the back.
    cache.delete(key);
    cache.set(key, solids);
  }
  return solids.map((s) => s.clone());
}
