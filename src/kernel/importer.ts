/**
 * Turning an imported STEP or STL file into solids.
 *
 * Reading a big file is slow, so the result is remembered and each rebuild
 * gets a fresh copy instead of reading the file again.
 */
import { cast, getOC, measureVolume, type Shape3D } from "replicad";

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

function readStl(bytes: Uint8Array, units: ImportedFile["units"]): Shape3D[] {
  const oc = getOC() as any;
  return withFile(bytes, (name) => {
    const reader = new oc.StlAPI_Reader();
    const shell = new oc.TopoDS_Shell();
    const garbage: { delete(): void }[] = [reader, shell];
    try {
      if (!reader.Read(shell, name)) throw new Error("The STL file couldn't be read — it may be damaged.");
      // Join the triangles that lie flat together into single faces.
      const unify = new oc.ShapeUpgrade_UnifySameDomain(shell, true, true, false);
      garbage.push(unify);
      unify.Build();
      const unified = unify.Shape();
      garbage.push(unified);
      const maker = new oc.BRepBuilderAPI_MakeSolid();
      garbage.push(maker);
      maker.Add(oc.TopoDS.Shell(unified));
      let solid = cast(maker.Solid()) as Shape3D;
      // Triangles facing the wrong way give a solid that's inside out.
      try {
        if (measureVolume(solid) < 0) {
          const flipped = cast(solid.wrapped.Reversed()) as Shape3D;
          solid.delete();
          solid = flipped;
        }
      } catch {
        /* keep it as it is */
      }
      if (units === "in") solid = solid.scale(25.4, [0, 0, 0]);
      return [solid];
    } catch (e) {
      if (e instanceof Error && /couldn't be read/.test(e.message)) throw e;
      throw new Error("The STL file couldn't be turned into a solid. Check it's a closed (watertight) shape.");
    } finally {
      for (const g of garbage.reverse()) {
        try {
          g.delete();
        } catch {
          /* already gone */
        }
      }
    }
  });
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
