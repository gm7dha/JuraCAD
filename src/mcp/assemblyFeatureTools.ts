/**
 * Claude's assembly features (Onshape's): a hole or a cut made in an
 * assembly, through the copies it reaches (or the ones named) — drilling
 * through two mated plates at once. The parts in their Part Studios don't
 * change; only this assembly's copies are cut (src/assembly/assemblyFeatures.ts).
 */
import { addAssemblyFeatures, assemblyEdgeFeature, assemblyExtrudeCut, assemblyFeaturesOf, assemblyHole, assemblySketch, deleteAssemblyFeatures, edgeNeeds, isAssemblyEdgeFeature, setFeatureNeeds, setFeatureParts } from "../assembly/assemblyFeatures";
import { findMesh, meshIdOf } from "../assembly/configured";
import type { TopoPick } from "../geometry/topoRef";
import { settlePlacements, updateAssembly } from "../assembly/assembly";
import { instancesForKernel } from "../assembly/placed";
import { leavesOf } from "../assembly/subassembly";
import type { Assembly, Feature } from "../model/types";
import { addCircle, addPoint, addRectangle } from "../sketch/ops";
import { planeOnFace, type SketchPlane } from "../sketch/planes";
import { emptySketch, type SketchData } from "../sketch/types";
import { amount, bool, InputError, list, noExtras, object, oneOf, text, xy } from "./args";
import { ASSEMBLY_REF, assembliesOf, builtParts, findAssembly, findTarget, placedFacesAndEdges, solve } from "./assemblyTools";
import { pickEdges, pickFace } from "./picks";
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

/**
 * The edges named in "edges" ([{"instance", "edge" | "edges"}]), as picks on the copies: each pick's partId is the
 * copy's key and its ref in the part's own coordinates (picked on the copy as it sits, with earlier cuts' faces).
 */
function edgePicks(s: Session, asm: Assembly, raw: unknown): { picks: TopoPick[]; names: string[] } {
  const picks: TopoPick[] = [];
  const names: string[] = [];
  const items = list(raw, "edges");
  if (!items.length) throw new InputError('edges: name the edges to round, e.g. [{"instance": "Plate <1>", "edge": "along z"}].');
  items.forEach((item, i) => {
    const o = object(item, `edges[${i}]`);
    noExtras(o, ["instance", "edge", "edges"], `edges[${i}]`);
    const t = findTarget(s, asm, o.instance, `edges[${i}].instance`);
    const placed = placedFacesAndEdges(t);
    const selectors = o.edges !== undefined ? list(o.edges, `edges[${i}].edges`) : [o.edge];
    if (o.edge === undefined && o.edges === undefined) throw new InputError(`edges[${i}]: give "edge" (E3, "along z", "circles", a face such as "top", or {"near": [x, y, z]}) or a list in "edges".`);
    for (const p of pickEdges(placed, selectors, `edges[${i}]`)) {
      // (Back to the part's own coordinates: the edges go with the copy when a mate moves it.)
      const k = p.ref.kind === "edge" ? placed.edgeRefs.indexOf(p.ref) : placed.faceRefs.indexOf(p.ref);
      const ref = p.ref.kind === "edge" ? t.mesh.edgeRefs[k] : t.mesh.faceRefs[k];
      if (ref && !picks.some((q) => q.partId === t.leaf.key && q.ref === ref)) picks.push({ partId: t.leaf.key, ref });
    }
    if (!names.includes(t.leaf.name)) names.push(t.leaf.name);
  });
  return { picks, names };
}

/** A Fillet or Chamfer made in an assembly (see add_assembly_feature). */
async function addEdgeFeature(s: Session, asm: Assembly, kind: "fillet" | "chamfer", a: Record<string, unknown>): Promise<ReturnType<typeof say>> {
  for (const k of ["on", "points", "diameter", "rectangles", "circles", "through_all", "depth", "flip", "parts"]) {
    if (a[k] !== undefined) throw new InputError(`A ${kind} takes "edges" and a "${kind === "fillet" ? "radius" : "distance"}", not "${k}".`);
  }
  const scope = s.scope();
  const sizeKey = kind === "fillet" ? "radius" : "distance";
  const other = kind === "fillet" ? "distance" : "radius";
  if (a[other] !== undefined) throw new InputError(`A ${kind} takes "${sizeKey}", not "${other}".`);
  const size = amount(a[sizeKey] ?? (kind === "fillet" ? 2 : 1), sizeKey, scope, { positive: true }).value;
  const { picks, names } = edgePicks(s, asm, a.edges);
  let tool = assemblyEdgeFeature(asm, kind, picks, { size });
  if (a.name !== undefined) tool = { ...tool, name: text(a.name, "name").slice(0, 80) };
  const next = addAssemblyFeatures(s.doc, asm.id, [tool]);
  const made = assembliesOf(next).find((x) => x.id === asm.id)!;
  await s.checkpoint();
  const all = builtParts(s);
  const solved = solve(s, asm);
  const r = s.withWholeEngine((e) => e.assemblyCuts(instancesForKernel(made, all, assembliesOf(next), solved)));
  const problem = r.errors[tool.id];
  if (problem) throw new InputError(`${problem} Nothing was changed.`);
  if (!r.reached[tool.id]?.length) throw new InputError(`${tool.name} wouldn't change anything: check the edges named (list_edges with "assembly" and "instance" shows them). Nothing was changed.`);
  s.throwIfCancelled();
  // Edges only the assembly's own cuts made (a drilled hole's rim): deleting that cut takes this with it.
  const leaves = leavesOf(made, all, assembliesOf(next));
  const plainOf = (key: string) => {
    const leaf = leaves.find((l) => l.key === key);
    return leaf ? findMesh(all, meshIdOf(leaf.instance)) : undefined;
  };
  const { [tool.id]: _own, ...earlier } = r.reached;
  const needs = edgeNeeds(picks, plainOf, earlier, (id) => !isAssemblyEdgeFeature(assemblyFeaturesOf(made).find((f) => f.id === id) ?? { type: "sketch" }));
  const kept = settlePlacements(next, asm.id, solved.placements);
  s.commit(updateAssembly(kept, asm.id, (x) => setFeatureNeeds(x, tool.id, needs)));
  const volumes = r.meshes.filter((m) => r.reached[tool.id].includes(m.id)).map((m) => `${leaves.find((l) => l.key === m.id)?.name ?? m.id} ${r2(m.volume ?? 0)} mm³`);
  return say(
    `Made ${tool.name} in ${asm.name}: ${kind === "fillet" ? "rounds" : "bevels"} ${picks.length} edge${picks.length === 1 ? "" : "s"} of ${names.join(", ")} (${sizeKey} ${r2(size)} mm) in this assembly only — their Part Studio parts are unchanged.`,
    volumes.length ? `Volumes now: ${volumes.join(", ")}.` : null,
    needs.length ? `It rounds edges made by ${needs.map((id) => assemblyFeaturesOf(made).find((f) => f.id === id)?.name ?? id).join(", ")}, so deleting that deletes it too.` : null,
  );
}

export const ASSEMBLY_FEATURE_TOOLS: ToolDef[] = [
  {
    name: "add_assembly_feature",
    title: "Cut or drill through parts in an assembly",
    description:
      'Make a hole or a cut in an assembly (Onshape\'s assembly features), e.g. drill through two plates that are mated together at once. Only the copies in THIS assembly are cut (its 3D view, exports, drawings, clash check and parts list, which says "modified in assembly"); the parts in their Part Studios are unchanged. The cut stays where it was made in the assembly. "kind": "hole" (plain round holes at "points" [[x, y], …], "diameter") or "cut" (an Extrude that removes, from "rectangles" [{"corner": [x, y], "size": [w, h]}] and/or "circles" [{"centre": [x, y], "diameter": d}]). "on": a copy\'s flat face {"instance": "Plate <1>", "face": "top"} (x, y measured in that face\'s plane: on a face looking up, as the assembly\'s X and Y) or "top" / "front" / "right" (the assembly\'s planes). "through_all" (default true) or "depth" (mm, into the face; "flip": true goes the other way). "parts": copies to cut (default: the top-level parts it reaches now — kept as its list, so parts put there later aren\'t cut; parts inside sub-assemblies only when named, as "Sub <1> / Part <1>"). Or "kind": "fillet" ("radius", default 2) / "chamfer" ("distance", default 1) with "edges": [{"instance": "Plate <1>", "edge": "along z" | "E3" | "circles" | a face like "top" (all its edges) | {"near": [x, y, z]}} or "edges": [...]] — edges of copies (as they sit in the assembly, holes drilled here included), rounded on this assembly\'s copies only; they go with the copy if a mate moves it. Refused, nothing changed, if it cuts or changes nothing.',
    inputSchema: {
      type: "object",
      properties: {
        assembly: ASSEMBLY_REF,
        kind: { type: "string", enum: ["hole", "cut", "fillet", "chamfer"] },
        on: {},
        points: { type: "array", items: { type: "array", items: { type: "number" } } },
        diameter: { type: ["number", "string"] },
        rectangles: { type: "array", items: { type: "object" } },
        circles: { type: "array", items: { type: "object" } },
        through_all: { type: "boolean" },
        depth: { type: ["number", "string"] },
        flip: { type: "boolean" },
        parts: { type: "array", items: { type: "string" } },
        edges: { type: "array", items: { type: "object" } },
        radius: { type: ["number", "string"] },
        distance: { type: ["number", "string"] },
        name: { type: "string" },
      },
      required: ["kind"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "kind", "on", "points", "diameter", "rectangles", "circles", "through_all", "depth", "flip", "parts", "edges", "radius", "distance", "name"], "add_assembly_feature");
      await s.checkpoint();
      await s.buildAllAsync();
      const asm = findAssembly(s, a.assembly);
      const any = oneOf(a.kind, ["hole", "cut", "fillet", "chamfer"] as const, "kind");
      if (any === "fillet" || any === "chamfer") return addEdgeFeature(s, asm, any, a);
      if (a.edges !== undefined || a.radius !== undefined || a.distance !== undefined) throw new InputError(`A ${any} doesn't take "edges", "radius" or "distance" (those are for "kind": "fillet" or "chamfer").`);
      if (a.on === undefined) throw new InputError('on: say where it\'s drawn — a copy\'s flat face {"instance": "Plate <1>", "face": "top"}, or "top" / "front" / "right".');
      const kind = any;
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
    description: 'Delete a hole, cut, fillet, chamfer or sketch made in an assembly (add_assembly_feature), by its name (describe_assembly lists them). Deleting a sketch deletes the holes and cuts made from it too, and deleting a hole or cut deletes fillets and chamfers of the edges it made.',
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
