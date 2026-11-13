/**
 * Claude's assembly features (Onshape's): a hole or a cut made in an
 * assembly, through the copies it reaches (or the ones named) — drilling
 * through two mated plates at once. The parts in their Part Studios don't
 * change; only this assembly's copies are cut (src/assembly/assemblyFeatures.ts).
 */
import { addAssemblyFeatures, assemblyExtrudeCut, assemblyFeaturesOf, assemblyHole, assemblySketch, deleteAssemblyFeatures, setFeatureParts } from "../assembly/assemblyFeatures";
import { settlePlacements, updateAssembly } from "../assembly/assembly";
import { instancesForKernel } from "../assembly/placed";
import { leavesOf } from "../assembly/subassembly";
import type { Assembly, Feature } from "../model/types";
import { addCircle, addPoint, addRectangle } from "../sketch/ops";
import { planeOnFace, type SketchPlane } from "../sketch/planes";
import { emptySketch, type SketchData } from "../sketch/types";
import { amount, bool, InputError, list, noExtras, object, oneOf, text, xy } from "./args";
import { ASSEMBLY_REF, assembliesOf, builtParts, findAssembly, findTarget, placedFacesAndEdges, solve } from "./assemblyTools";
import { pickFace } from "./picks";
import type { Session } from "./session";
import { byName, r2, say, type ToolDef } from "./toolKit";

const PLANES = ["top", "front", "right"] as const;

/** Where the sketch goes: a copy's flat face as it sits in the assembly, or one of the assembly's planes. */
function sketchPlane(s: Session, asm: Assembly, raw: unknown): { plane: SketchPlane; label: string } {
  if (typeof raw === "string") {
    const name = oneOf(raw.toLowerCase(), PLANES, "on");
    const label = name[0].toUpperCase() + name.slice(1);
    return { plane: { kind: "default", name: label as "Top" | "Front" | "Right" }, label: `the assembly's ${label} plane` };
  }
  const o = object(raw, "on");
  noExtras(o, ["instance", "face"], "on");
  const t = findTarget(s, asm, o.instance, "on.instance");
  const placed = placedFacesAndEdges(t);
  const f = pickFace(placed, o.face, "on.face");
  if (f.ref.kind !== "face" || f.ref.surface !== "PLANE") throw new InputError(`on.face: that face of ${t.leaf.name} is curved. Choose a flat face (list_faces with "assembly" and "instance" shows them).`);
  // (Kept as numbers where it is now: the cut stays where it was made in the assembly, as in Onshape.)
  return { plane: planeOnFace(f.ref.normal, f.ref.center, `Face of ${t.leaf.name}`), label: `a face of ${t.leaf.name}` };
}

/** The parts named in "parts" (part keys), or undefined for every top-level part it reaches. */
function chosenParts(s: Session, asm: Assembly, raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  return list(raw, "parts").map((r, i) => findTarget(s, asm, r, `parts[${i}]`).leaf.key);
}

export const ASSEMBLY_FEATURE_TOOLS: ToolDef[] = [
  {
    name: "add_assembly_feature",
    title: "Cut or drill through parts in an assembly",
    description:
      'Make a hole or a cut in an assembly (Onshape\'s assembly features), e.g. drill through two plates that are mated together at once. Only the copies in THIS assembly are cut (its 3D view, exports, drawings, clash check and parts list, which says "modified in assembly"); the parts in their Part Studios are unchanged. The cut stays where it was made in the assembly. "kind": "hole" (plain round holes at "points" [[x, y], …], "diameter") or "cut" (an Extrude that removes, from "rectangles" [{"corner": [x, y], "size": [w, h]}] and/or "circles" [{"centre": [x, y], "diameter": d}]). "on": a copy\'s flat face {"instance": "Plate <1>", "face": "top"} (x, y measured in that face\'s plane: on a face looking up, as the assembly\'s X and Y) or "top" / "front" / "right" (the assembly\'s planes). "through_all" (default true) or "depth" (mm, into the face; "flip": true goes the other way). "parts": copies to cut (default: the top-level parts it reaches now — kept as its list, so parts put there later aren\'t cut; parts inside sub-assemblies only when named, as "Sub <1> / Part <1>"). Refused, nothing changed, if it cuts nothing.',
    inputSchema: {
      type: "object",
      properties: {
        assembly: ASSEMBLY_REF,
        kind: { type: "string", enum: ["hole", "cut"] },
        on: {},
        points: { type: "array", items: { type: "array", items: { type: "number" } } },
        diameter: { type: ["number", "string"] },
        rectangles: { type: "array", items: { type: "object" } },
        circles: { type: "array", items: { type: "object" } },
        through_all: { type: "boolean" },
        depth: { type: ["number", "string"] },
        flip: { type: "boolean" },
        parts: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      required: ["kind", "on"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "kind", "on", "points", "diameter", "rectangles", "circles", "through_all", "depth", "flip", "parts", "name"], "add_assembly_feature");
      await s.checkpoint();
      await s.buildAllAsync();
      const asm = findAssembly(s, a.assembly);
      const kind = oneOf(a.kind, ["hole", "cut"] as const, "kind");
      const { plane, label } = sketchPlane(s, asm, a.on);
      const scope = s.scope();
      const through = bool(a.through_all, "through_all", a.depth === undefined);
      const depth = through ? undefined : amount(a.depth, "depth", scope, { positive: true }).value;
      let data: SketchData = emptySketch();
      if (kind === "hole") {
        if (a.rectangles !== undefined || a.circles !== undefined) throw new InputError('A hole takes "points" (where each hole goes) and a "diameter". For rectangles or circles use "kind": "cut".');
        const points = list(a.points, "points");
        for (const [i, p] of points.entries()) {
          const [x, y] = xy(p, `points[${i}]`, scope);
          data = addPoint(data, { x: x.value, y: y.value }).sketch;
        }
      } else {
        if (a.points !== undefined || a.diameter !== undefined) throw new InputError('A cut takes "rectangles" and/or "circles". For round holes at points use "kind": "hole".');
        for (const [i, r] of (a.rectangles === undefined ? [] : list(a.rectangles, "rectangles")).entries()) {
          const o = object(r, `rectangles[${i}]`);
          noExtras(o, ["corner", "size"], `rectangles[${i}]`);
          const [x, y] = xy(o.corner, `rectangles[${i}].corner`, scope);
          const [w, h] = xy(o.size, `rectangles[${i}].size`, scope);
          if (!(w.value > 0 && h.value > 0)) throw new InputError(`rectangles[${i}].size: both sizes must be more than 0.`);
          data = addRectangle(data, { x: x.value, y: y.value }, { x: x.value + w.value, y: y.value + h.value }).sketch;
        }
        for (const [i, c] of (a.circles === undefined ? [] : list(a.circles, "circles")).entries()) {
          const o = object(c, `circles[${i}]`);
          noExtras(o, ["centre", "center", "diameter"], `circles[${i}]`);
          const [x, y] = xy(o.centre ?? o.center, `circles[${i}].centre`, scope);
          const d = amount(o.diameter, `circles[${i}].diameter`, scope, { positive: true }).value;
          data = addCircle(data, { x: x.value, y: y.value }, d / 2).sketch;
        }
        if (!data.curves.length) throw new InputError('Give the shapes to cut: "rectangles" and/or "circles".');
      }
      const sketch = assemblySketch(asm, plane, data);
      let tool: Feature =
        kind === "hole"
          ? assemblyHole({ features: [...assemblyFeaturesOf(asm), sketch] }, sketch.id, { diameter: amount(a.diameter, "diameter", scope, { positive: true }).value, throughAll: through, depth, flip: bool(a.flip, "flip") })
          : assemblyExtrudeCut({ features: [...assemblyFeaturesOf(asm), sketch] }, sketch.id, { throughAll: through, depth, flip: bool(a.flip, "flip") });
      if (a.name !== undefined) tool = { ...tool, name: text(a.name, "name").slice(0, 80) };
      const parts = chosenParts(s, asm, a.parts);
      const next = addAssemblyFeatures(s.doc, asm.id, [sketch, tool], parts ? { [tool.id]: parts } : undefined);
      const made = assembliesOf(next).find((x) => x.id === asm.id)!;
      // Cut on the whole design's engine: which copies lost material, and any problem.
      await s.checkpoint();
      const all = builtParts(s);
      const solved = solve(s, asm);
      const inputs = instancesForKernel(made, all, assembliesOf(next), solved);
      const r = s.withWholeEngine((e) => e.assemblyCuts(inputs));
      const problem = r.errors[tool.id];
      if (problem) throw new InputError(`${problem} Nothing was changed.`);
      const leaves = leavesOf(made, all, assembliesOf(next));
      const reached = r.reached[tool.id] ?? [];
      if (!reached.length) {
        throw new InputError(
          `${tool.name} wouldn't cut anything: it doesn't reach ${parts ? "the parts named" : "any part"} from ${label}. Check the positions (on a face, x and y are in that face's plane), try "flip": true, or use "through_all". Nothing was changed.`,
        );
      }
      s.throwIfCancelled();
      // The parts it cuts are the ones it reaches now (as Onshape lists them): a bolt mated into the hole later isn't
      // drilled too. Change them with the app's "Parts…".
      // (The parts are kept where they're shown — where it cut them — as the mate solver cuts them where the design has them.)
      const kept = settlePlacements(next, asm.id, solved.placements);
      s.commit(parts ? kept : updateAssembly(kept, asm.id, (x) => setFeatureParts(x, tool.id, reached)));
      const names = reached.map((k) => leaves.find((l) => l.key === k)?.name ?? k);
      const volumes = r.meshes.filter((m) => reached.includes(m.id)).map((m) => `${leaves.find((l) => l.key === m.id)?.name ?? m.id} ${r2(m.volume ?? 0)} mm³`);
      return say(`Made ${tool.name} in ${asm.name} (on ${label}): it cuts ${names.join(", ")} in this assembly only — their Part Studio parts are unchanged.`, volumes.length ? `Volumes now: ${volumes.join(", ")}.` : null);
    },
  },
  {
    name: "delete_assembly_feature",
    title: "Delete an assembly feature",
    description: 'Delete a hole, cut or sketch made in an assembly (add_assembly_feature), by its name (describe_assembly lists them). Deleting a sketch deletes the holes and cuts made from it too.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, feature: { type: "string" } }, required: ["feature"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "feature"], "delete_assembly_feature");
      const asm = findAssembly(s, a.assembly);
      const f = byName(assemblyFeaturesOf(asm), a.feature, "feature", "assembly feature", "make one with add_assembly_feature.");
      const before = assemblyFeaturesOf(asm);
      const next = updateAssembly(s.doc, asm.id, (x) => deleteAssemblyFeatures(x, [f.id]));
      const after = assemblyFeaturesOf(assembliesOf(next).find((x) => x.id === asm.id)!);
      const gone = before.filter((x) => !after.some((y) => y.id === x.id)).map((x) => x.name);
      s.commit(next);
      return say(`Deleted ${gone.join(", ")} from ${asm.name}.`);
    },
  },
];
