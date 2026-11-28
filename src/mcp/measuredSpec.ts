/**
 * Measured variables from Claude's settings (Onshape's Variable › Measured): the same record the app's dialog makes
 * (see src/model/measuredVariable.ts). Things to measure are a plane's name, or {"part", "face" | "edge" | "vertex"}.
 */
import { MEASURE_KINDS, measuredProblem, newMeasuredDef, toggleTarget, type MeasureKind, type MeasureTarget, type MeasuredDef } from "../model/measuredVariable";
import { checkName } from "../model/variables";
import { allFeatures } from "../model/studios";
import type { Feature } from "../model/types";
import { InputError, list, oneOf, text, xyz, type Obj } from "./args";
import { pickCorner, pickEdges, pickFaces } from "./picks";
import type { SpecContext } from "./featureSpec";

const has = (a: Obj, k: string) => a[k] !== undefined && a[k] !== null;

export const MEASURED_KEYS = ["variable", "measure", "along", "targets"];

export const MEASURED_HELP =
  'measured_variable (Onshape\'s Variable › Measured — a variable whose value is measured from the model where it sits in the list; features added after it can use it by name in any size or sketch dimension, and it follows when the model changes): variable (its name, e.g. "width"; not one the set_variables table has), measure ("distance" default | "length" — of edges, added up | "diameter" | "radius" — of a round edge or face | "angle" — between flat faces, straight edges or planes, in degrees), along ("min" default — the shortest distance | "x" | "y" | "z" — how far apart along that axis), targets (a list: "Top" | "Front" | "Right" or a Plane name, or {"part": name, "face": "F2"} / {"part": name, "edge": "E3"} / {"part": name, "vertex": [x, y, z]} — face and edge choices as list_faces / list_edges give them; distance and angle take two, the others one)';

/** Fill in a measured variable's settings (only what's given changes when editing). */
export function applyMeasured(f: Feature, a: Obj, ctx: SpecContext): void {
  const others = [...(ctx.doc.variables ?? []).map((v) => v.name)];
  const taken = allFeatures(ctx.doc).filter((x) => x.id !== f.id && x.measured).map((x) => x.measured!.name);
  let def: MeasuredDef = f.measured ?? newMeasuredDef([...others, ...taken]);
  if (has(a, "variable") || !ctx.editing) {
    const name = text(a.variable, "variable").trim();
    const problem = checkName(name, others);
    if (problem) throw new InputError(`variable: ${problem === "Another variable already has this name" ? `the Variables table already has "${name}" — choose another name` : problem}.`);
    if (taken.includes(name)) throw new InputError(`variable: another measured variable is already called "${name}" — choose another name.`);
    def = { ...def, name };
  }
  if (has(a, "measure")) def = { ...def, kind: oneOf(a.measure, MEASURE_KINDS.map((k) => k.kind) as MeasureKind[], "measure") };
  if (has(a, "along") || has(a, "measure")) {
    const along = oneOf(a.along ?? def.along ?? "min", ["min", "x", "y", "z"] as const, "along");
    const { along: _a, ...rest } = def;
    if (along !== "min" && def.kind !== "distance") throw new InputError('"along" goes with measure "distance".');
    def = along === "min" ? rest : { ...rest, along };
  }
  if (has(a, "targets") || !ctx.editing) {
    let next: MeasuredDef = { ...def, targets: [] };
    list(a.targets, "targets").forEach((raw, i) => {
      const where = `targets[${i}]`;
      const t = targetOf(raw, where, ctx);
      const r = toggleTarget(next, t);
      if (r.error) throw new InputError(`${where}: ${r.error}`);
      if (r.def.targets.length <= next.targets.length) throw new InputError(`${where}: that's the same as one before it, or one too many for measure "${def.kind}".`);
      next = r.def;
    });
    def = next;
  }
  const problem = measuredProblem(def);
  if (problem) throw new InputError(`targets: ${problem.replace(/^Click/, "Give")}`);
  f.measured = def;
}

function targetOf(raw: unknown, where: string, ctx: SpecContext): MeasureTarget {
  if (typeof raw === "string") {
    if (raw === "Top" || raw === "Front" || raw === "Right") return { plane: raw };
    return { plane: ctx.session.feature(raw, where, ["plane"], ctx.doc).id };
  }
  if (!raw || typeof raw !== "object") throw new InputError(`${where}: give a plane's name, or {"part": name, "face": "F2"}, {"part": name, "edge": "E3"} or {"part": name, "vertex": [x, y, z]}.`);
  const o = raw as Obj;
  const part = ctx.session.part(ctx.parts, o.part, `${where}.part`);
  if (has(o, "face")) return pickFaces(part, [o.face], `${where}.face`)[0];
  if (has(o, "edge")) {
    const picks = pickEdges(part, [o.edge], `${where}.edge`);
    if (picks.length !== 1 || picks[0].ref.kind !== "edge") throw new InputError(`${where}.edge: give one edge (a face here means all its edges).`);
    return picks[0];
  }
  if (has(o, "vertex")) return pickCorner(part, xyz(o.vertex, `${where}.vertex`, ctx.scope).map((v) => v.value) as [number, number, number], `${where}.vertex`);
  throw new InputError(`${where}: give "face", "edge" or "vertex" with the part.`);
}
