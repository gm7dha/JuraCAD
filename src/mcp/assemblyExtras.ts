/**
 * More of Claude's assembly tools: patterns (linear, circular, mirror — also
 * across a face, or as the same part for symmetric parts), groups, changing a
 * mate (amounts, limits, flip, switching it off), mate relations (gear, rack
 * and pinion, screw, linear), Replicate, exploded view steps (also of parts
 * inside sub-assemblies), and taking any of those away again. All made with
 * the app's own pure edits (src/assembly), and refused — nothing changed —
 * when they'd stop something that works from working.
 */
import { putRelation, removeRelation, settlePlacements, settleSolved, updateAssembly } from "../assembly/assembly";
import { findMesh, meshIdOf } from "../assembly/configured";
import { putExplodeStep, removeExplodeStep, stepDistance } from "../assembly/explode";
import { makeGroup, removeGroup, renameGroup } from "../assembly/groups";
import { MATE_TYPES, mateLimits, mateValues, solveWithParts } from "../assembly/mates";
import { nextPatternName, removePattern, syncPattern } from "../assembly/patterns";
import { canBeDriven, canDrive, nextRelationName, RELATION_KINDS, RELATION_KIND_NAMES } from "../assembly/relations";
import { nextReplicateName, removeReplicate, replicateSource, syncReplicate } from "../assembly/replicate";
import { replicateHoles } from "../assembly/replicateHoles";
import { leavesOf } from "../assembly/subassembly";
import { ownSymmetry } from "../assembly/symmetry";
import type { PartMesh } from "../kernel/protocol";
import { newId } from "../model/document";
import type { Assembly, AssemblyPattern, ExplodeStep, Instance, JuraCADDocument, Mate, MateConnector, MateRelation } from "../model/types";
import { amount, bool, InputError, list, noExtras, object, oneOf, text, xyz } from "./args";
import {
  ASSEMBLY_REF,
  assembliesOf,
  builtParts,
  findAssembly,
  findTarget,
  leafNames,
  oneFaceOrEdge,
  placedFacesAndEdges,
  placementText,
  solve,
  tryAssemblyChange,
} from "./assemblyTools";
import type { Session } from "./session";
import { byName, r2, say, type ToolDef } from "./toolKit";

type Axis = "x" | "y" | "z";
const PLANE_AXIS: Record<string, Axis> = { right: "x", front: "y", top: "z" };

/** Which copies show a symmetric part (a mirror with "same_part" shows those as themselves), as the app works it out. */
const symmetricIn = (parts: readonly PartMesh[]) => (i: Instance) => {
  const mesh = i.subAssembly ? undefined : findMesh(parts, meshIdOf(i));
  return !!mesh && !!ownSymmetry(mesh);
};

/** Top-level copies by name, for patterns and groups (not copies made by a pattern or Replicate). */
function originals(asm: Assembly, raw: unknown, where: string, what: string): Instance[] {
  const picked = list(raw, where).map((r, i) => byName(asm.instances, r, `${where}[${i}]`, "copy", "insert parts with insert_into_assembly."));
  for (const i of picked) {
    if (i.copyOf) throw new InputError(`${where}: ${i.name} is a copy made by ${asm.patterns?.find((p) => p.id === i.copyOf!.pattern)?.name ?? "a pattern"}. ${what} its original instead.`);
    if (i.replicaOf) throw new InputError(`${where}: ${i.name} is a copy made by ${asm.replicates?.find((r) => r.id === i.replicaOf!.replicate)?.name ?? "Replicate"}. ${what} its original instead.`);
  }
  if (new Set(picked.map((i) => i.id)).size !== picked.length) throw new InputError(`${where}: a copy is named twice.`);
  return picked;
}

/** "+x", "-z", "x"… → an axis and whether it goes the other way. */
function direction(raw: unknown, where: string): { axis: Axis; flip: boolean } {
  const v = typeof raw === "string" ? raw.trim().toLowerCase().replace("−", "-") : "";
  const m = /^([+-]?)([xyz])$/.exec(v);
  if (!m) throw new InputError(`${where} must be a direction: "x", "y", "z", or "-x", "-y", "-z" for the other way (got ${JSON.stringify(raw)}).`);
  return { axis: m[2] as Axis, flip: m[1] === "-" };
}

function putPatternOn(s: Session, doc: JuraCADDocument, asm: Assembly, p: AssemblyPattern): JuraCADDocument {
  const parts = builtParts(s);
  const synced = updateAssembly(doc, asm.id, (a) => syncPattern(a, p, () => newId("i"), symmetricIn(parts)));
  // Across a face: the copies' places come from where the face is, so put them there now (as the app does).
  if (!p.plane) return synced;
  const solvedAsm = assembliesOf(synced).find((a) => a.id === asm.id)!;
  return settlePlacements(synced, asm.id, solveDoc(s, solvedAsm, synced).placements);
}

/** Solve against the document being made (so sub-assemblies are the ones in it). */
const solveDoc = (s: Session, asm: Assembly, doc: JuraCADDocument) => solveWithParts(asm, builtParts(s), { assemblies: assembliesOf(doc) });

const MATE_REF = { type: "string", description: 'A mate\'s name, e.g. "Hinge 1" (describe_assembly lists them).' };

export const ASSEMBLY_EXTRA_TOOLS: ToolDef[] = [
  {
    name: "add_assembly_pattern",
    title: "Pattern or mirror copies in an assembly",
    description:
      'Repeat copies in an assembly, as Onshape\'s assembly patterns: "kind": "linear" ("count" in a row, "spacing" mm apart, along "direction" "x", "y", "z" or "-x"…), "circular" ("count" round the "axis" x/y/z through "centre" [x, y, z], spread evenly round ("spread": 360, the default) or over "spread" degrees; "flip" goes the other way), or "mirror" (one mirror-image copy of each, across the assembly plane "plane": "Right" | "Front" | "Top" moved "offset" mm along it, or across a flat face: "face": {"instance": …, "face": …}; "same_part": true shows symmetric parts as themselves, so the parts list counts them as one part). "instances": the copies to repeat. The pattern\'s copies follow their originals wherever mates put them. Remove it with remove_assembly_item.',
    inputSchema: {
      type: "object",
      properties: {
        assembly: ASSEMBLY_REF,
        kind: { type: "string", enum: ["linear", "circular", "mirror"] },
        instances: { type: "array", items: { type: "string" } },
        count: { type: "number", description: "2–100, including the original (linear and circular)." },
        spacing: { description: "Linear: mm from one copy to the next." },
        direction: { type: "string", enum: ["x", "y", "z", "-x", "-y", "-z"], description: "Linear: which way the row goes." },
        axis: { type: "string", enum: ["x", "y", "z"], description: "Circular: the axis turned about." },
        centre: { type: "array", items: {}, description: "Circular: a point the axis goes through (mm, default the origin)." },
        spread: { description: "Circular: degrees the copies are spread over (360 = evenly all the way round, the default)." },
        flip: { type: "boolean", description: "Circular: turn the other way." },
        plane: { type: "string", enum: ["Right", "Front", "Top"], description: "Mirror: the assembly plane to mirror across (default Right)." },
        offset: { description: "Mirror: how far the plane is moved along its normal (mm, default 0)." },
        face: { type: "object", description: 'Mirror: across this flat face instead: {"instance": "Base <1>", "face": "right"}.' },
        same_part: { type: "boolean", description: "Mirror: symmetric parts shown as themselves, not mirror images." },
        name: { type: "string" },
      },
      required: ["kind", "instances"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "kind", "instances", "count", "spacing", "direction", "axis", "centre", "spread", "flip", "plane", "offset", "face", "same_part", "name"], "add_assembly_pattern");
      const asm = findAssembly(s, a.assembly);
      const kind = oneOf(a.kind, ["linear", "circular", "mirror"] as const, "kind");
      const seeds = originals(asm, a.instances, "instances", "Pattern");
      const only = (keys: string[], what: string) => {
        const extra = keys.filter((k) => a[k] !== undefined);
        if (extra.length) throw new InputError(`${extra.map((k) => `"${k}"`).join(", ")} ${extra.length > 1 ? "don't" : "doesn't"} go with a ${what} pattern.`);
      };
      const scope = s.scope();
      const name = a.name === undefined ? nextPatternName(asm, kind === "mirror" ? "Mirror" : "Pattern") : text(a.name, "name").slice(0, 80);
      if ((asm.patterns ?? []).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a pattern called "${name}" in ${asm.name}. Choose another name.`);
      let p: AssemblyPattern;
      const id = newId("pt");
      const ids = seeds.map((i) => i.id);
      const count = () => {
        const n = amount(a.count, "count", scope, { integer: true, min: 2, unit: "" }).value;
        if (n > 100) throw new InputError("count can be at most 100 (including the original).");
        return n;
      };
      if (kind === "linear") {
        only(["axis", "centre", "spread", "flip", "plane", "offset", "face", "same_part"], "linear");
        const spacing = amount(a.spacing, "spacing", scope, { positive: true });
        const dir = direction(a.direction ?? "x", "direction");
        p = { id, name, kind, seeds: ids, count: count(), amount: spacing.text, axis: dir.axis, ...(dir.flip ? { flip: true } : {}) };
      } else if (kind === "circular") {
        only(["spacing", "direction", "plane", "offset", "face", "same_part"], "circular");
        const spread = a.spread === undefined ? { value: 360, text: "360" } : amount(a.spread, "spread", scope, { positive: true, unit: "°" });
        if (spread.value > 360) throw new InputError("spread can be at most 360°.");
        const axis = oneOf(a.axis, ["x", "y", "z"] as const, "axis", "z");
        const centre = a.centre === undefined ? undefined : (xyz(a.centre, "centre", scope).map((v) => v.value) as [number, number, number]);
        p = { id, name, kind, seeds: ids, count: count(), amount: spread.text, axis, ...(bool(a.flip, "flip") ? { flip: true } : {}), ...(centre ? { centre } : {}) };
      } else {
        only(["count", "spacing", "direction", "axis", "centre", "spread", "flip"], "mirror");
        const sub = seeds.find((i) => i.subAssembly);
        if (sub) throw new InputError(`${sub.name} is a sub-assembly: it can be repeated in a line or round, but not mirrored (its mirror image would be a different assembly). Mirror the parts inside it in that assembly instead.`);
        let plane: MateConnector | undefined;
        let axis: Axis = "x";
        let centre: [number, number, number] | undefined;
        if (a.face !== undefined) {
          if (a.plane !== undefined || a.offset !== undefined) throw new InputError('Give either "face" (a flat face to mirror across) or "plane" and "offset" (an assembly plane), not both.');
          const o = object(a.face, "face");
          noExtras(o, ["instance", "face"], "face");
          const t = findTarget(s, asm, o.instance, "face.instance");
          if (ids.includes(t.leaf.top)) throw new InputError(`face: that's on ${t.leaf.name}, one of the copies being mirrored. Pick a face on another part, or an assembly plane ("plane").`);
          const pick = oneFaceOrEdge(placedFacesAndEdges(t), t.mesh, o, "face", "face");
          if (pick.ref.kind !== "face" || pick.ref.surface !== "PLANE") throw new InputError(`face: ${JSON.stringify(o.face)} isn't flat. Give a flat face to mirror across (list_faces with "assembly" and "instance").`);
          plane = { instanceId: t.leaf.top, ...(t.leaf.path.length ? { path: t.leaf.path } : {}), pick };
        } else {
          const word = oneOf(a.plane, ["Right", "Front", "Top"] as const, "plane", "Right");
          axis = PLANE_AXIS[word.toLowerCase()];
          const off = a.offset === undefined ? 0 : amount(a.offset, "offset", scope).value;
          centre = [0, 0, 0];
          centre[axis === "x" ? 0 : axis === "y" ? 1 : 2] = off;
        }
        p = { id, name, kind, seeds: ids, count: 2, amount: "0", axis, ...(centre ? { centre } : {}), ...(plane ? { plane } : {}), ...(bool(a.same_part, "same_part") ? { samePart: true } : {}) };
      }
      const r = await tryAssemblyChange(s, asm.id, putPatternOn(s, s.doc, asm, p), `add ${name}`);
      const made = r.asm.instances.filter((i) => i.copyOf?.pattern === id);
      const sym = symmetricIn(builtParts(s));
      const shownAsItself = p.samePart ? seeds.filter((i) => sym(i)).map((i) => i.name) : [];
      return say(
        `Added ${name} to ${r.asm.name}: ${made.length} cop${made.length === 1 ? "y" : "ies"} of ${seeds.map((i) => i.name).join(", ")}:`,
        ...made.map((i) => `- ${i.name}${i.mirrored ? " (mirror image)" : ""}: ${placementText(r.solved.placements[i.id] ?? i.placement)}`),
        p.samePart && seeds.length > shownAsItself.length ? `Note: ${seeds.filter((i) => !shownAsItself.includes(i.name)).map((i) => i.name).join(", ")} ${seeds.length - shownAsItself.length > 1 ? "aren't" : "isn't"} symmetric, so ${seeds.length - shownAsItself.length > 1 ? "they get" : "it gets"} mirror-image copies.` : null,
        "The copies follow their originals: move or mate the originals, not the copies. Look with get_views {\"assembly\": …}.",
      );
    },
  },
  {
    name: "group_parts",
    title: "Lock parts together (group)",
    description: 'Lock copies in an assembly together where they are now, so they move as one (Onshape\'s Group): "instances" (two or more top-level copies, not ones made by a pattern or Replicate, nor already in a group). Ungroup with remove_assembly_item {"group": …}.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, instances: { type: "array", items: { type: "string" } }, name: { type: "string" } }, required: ["instances"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "instances", "name"], "group_parts");
      const asm = findAssembly(s, a.assembly);
      const members = originals(asm, a.instances, "instances", "Group");
      if (members.length < 2) throw new InputError("A group needs two or more copies.");
      const inGroup = members.find((i) => (asm.groups ?? []).some((g) => g.members.includes(i.id)));
      if (inGroup) throw new InputError(`${inGroup.name} is already in ${asm.groups!.find((g) => g.members.includes(inGroup.id))!.name}. A copy can be in one group only: ungroup it first (remove_assembly_item).`);
      const { placements } = solve(s, asm);
      const id = newId("g");
      const made = makeGroup(asm, members.map((i) => i.id), placements, id);
      if (made.error) throw new InputError(`${made.error} Nothing was changed.`);
      let groups = made.assembly.groups;
      if (a.name !== undefined) {
        const n = text(a.name, "name").slice(0, 80);
        if ((asm.groups ?? []).some((g) => g.name.toLowerCase() === n.toLowerCase())) throw new InputError(`There's already a group called "${n}". Choose another name.`);
        groups = renameGroup(made.assembly, id, n).groups;
      }
      const next = updateAssembly(settlePlacements(s.doc, asm.id, placements), asm.id, (x) => ({ ...x, groups }));
      const r = await tryAssemblyChange(s, asm.id, next, "group them");
      const g = r.asm.groups!.find((x) => x.id === id)!;
      return say(`Made ${g.name}: ${members.map((i) => i.name).join(", ")} now move as one, kept where they are relative to ${members[0].name}.`);
    },
  },
  {
    name: "edit_mate",
    title: "Change a mate",
    description:
      'Change a mate in an assembly: "values" (its amounts, e.g. {"angle": 45} or {"distance": 10}; mm and degrees, or maths as text), "limits" (how far each movement may go, e.g. {"angle": {"min": -30, "max": 90}}; leave "min" or "max" out for no limit that way, null clears a movement\'s limits), "flip", "suppressed" (true switches it off: it holds nothing), "name". Only what\'s given changes; refused (nothing changed) if the assembly can\'t then be solved.',
    inputSchema: {
      type: "object",
      properties: { assembly: ASSEMBLY_REF, mate: MATE_REF, values: { type: "object" }, limits: { type: "object" }, flip: { type: "boolean" }, suppressed: { type: "boolean" }, name: { type: "string" } },
      required: ["mate"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "mate", "values", "limits", "flip", "suppressed", "name"], "edit_mate");
      const asm = findAssembly(s, a.assembly);
      const mate = byName(asm.mates ?? [], a.mate, "mate", "mate", "add one with add_mate.");
      if (mate.replicateOf && (a.values !== undefined || a.limits !== undefined || a.flip !== undefined)) throw new InputError(`${mate.name} was made by Replicate and follows the original's mate: change that one instead.`);
      const defs = MATE_TYPES[mate.type].values;
      const unitOf = (key: string) => (defs.find((d) => d.key === key)!.unit === "°" ? "°" : "mm");
      const next: Mate = { ...mate, values: { ...mate.values } };
      if (a.values !== undefined) {
        const given = object(a.values, "values");
        noExtras(given, defs.map((d) => d.key), `values (for a ${MATE_TYPES[mate.type].label} mate)`);
        for (const [k, v] of Object.entries(given)) next.values[k] = amount(v, `values.${k}`, s.scope(), { unit: unitOf(k) }).text;
      }
      if (a.limits !== undefined) {
        const given = object(a.limits, "limits");
        const free = defs.filter((d) => d.free).map((d) => d.key);
        if (!free.length) throw new InputError(`A ${MATE_TYPES[mate.type].label} mate holds its parts solid, so it has no movements to limit.`);
        noExtras(given, free, `limits (the movements of a ${MATE_TYPES[mate.type].label} mate)`);
        const limits = { ...(mate.limits ?? {}) };
        for (const [k, v] of Object.entries(given)) {
          if (v === null) {
            delete limits[k];
            continue;
          }
          const o = object(v, `limits.${k}`);
          noExtras(o, ["min", "max"], `limits.${k}`);
          if (o.min === undefined && o.max === undefined) throw new InputError(`limits.${k}: give "min", "max" or both (or null to clear the limits).`);
          limits[k] = {
            ...(o.min !== undefined && o.min !== null ? { min: amount(o.min, `limits.${k}.min`, s.scope(), { unit: unitOf(k) }).text } : {}),
            ...(o.max !== undefined && o.max !== null ? { max: amount(o.max, `limits.${k}.max`, s.scope(), { unit: unitOf(k) }).text } : {}),
          };
        }
        if (Object.keys(limits).length) next.limits = limits;
        else delete next.limits;
        const bad = Object.entries(mateLimits(next).errors);
        if (bad.length) throw new InputError(`limits: ${bad.map(([k, e]) => `${k}: ${e}`).join("; ")}. Nothing was changed.`);
      }
      if (a.flip !== undefined) next.flip = bool(a.flip, "flip");
      if (a.suppressed !== undefined) {
        if (bool(a.suppressed, "suppressed")) next.suppressed = true;
        else delete next.suppressed;
      }
      if (a.name !== undefined) {
        const n = text(a.name, "name").slice(0, 80);
        if ((asm.mates ?? []).some((m) => m.id !== mate.id && m.name.toLowerCase() === n.toLowerCase())) throw new InputError(`There's already a mate called "${n}". Choose another name.`);
        next.name = n;
      }
      if (JSON.stringify(next) === JSON.stringify(mate)) return say(`${mate.name} already has those settings; nothing changed.`);
      // The others stay where the mates had put them (as the app does when a mate is switched off).
      const settled = settleSolved(s.doc, asm.id, solve(s, asm));
      const doc = updateAssembly(settled, asm.id, (x) => ({ ...x, mates: (x.mates ?? []).map((m) => (m.id === mate.id ? next : m)) }));
      const r = await tryAssemblyChange(s, asm.id, doc, `change ${mate.name}`, [mate.id]);
      const used = mateValues(next);
      const clamped = defs.filter((d) => next.values[d.key] !== undefined && Number(next.values[d.key]) !== used.values[d.key] && Number.isFinite(Number(next.values[d.key])));
      const driven = (r.asm.relations ?? []).filter((x) => x.driven === mate.id);
      const moved = r.asm.instances.filter((i) => r.solved.drivenBy[i.id] === mate.id);
      return say(
        `Changed ${next.name}${next.suppressed ? " (switched off: it holds nothing now)" : ""}.`,
        clamped.length ? `Note: ${clamped.map((d) => `${d.key} ${next.values[d.key]} is outside its limits, so it's held at ${r2(used.values[d.key])}`).join("; ")}.` : null,
        driven.length ? `Note: ${driven.map((x) => x.name).join(", ")} drive${driven.length === 1 ? "s" : ""} its movement, so amounts typed for it are worked out from the driver instead.` : null,
        moved.length ? `It places ${moved.map((i) => `${i.name} ${placementText(r.solved.placements[i.id] ?? i.placement)}`).join("; ")}.` : null,
      );
    },
  },
  {
    name: "add_mate_relation",
    title: "Make one mate drive another",
    description:
      'Link two mates so one\'s movement drives the other\'s, as Onshape\'s mate relations: "kind": "gear" (two hinges turn together, the second "ratio" times the first\'s angle, the other way round as meshing gears do), "rack" (a hinge — the pinion — drives a slider; "ratio" = the pinion\'s radius in mm), "screw" (a hinge drives a slider "ratio" mm per turn — the thread\'s lead), or "linear" (a slider drives another "ratio" times as far). "driver" and "driven" are mate names; "reverse": true runs the driven one the other way. Then change the driver\'s amount with edit_mate.',
    inputSchema: {
      type: "object",
      properties: { assembly: ASSEMBLY_REF, kind: { type: "string", enum: [...RELATION_KIND_NAMES] }, driver: MATE_REF, driven: MATE_REF, ratio: {}, reverse: { type: "boolean" }, name: { type: "string" } },
      required: ["kind", "driver", "driven"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "kind", "driver", "driven", "ratio", "reverse", "name"], "add_mate_relation");
      const asm = findAssembly(s, a.assembly);
      const kind = oneOf(a.kind, RELATION_KIND_NAMES, "kind");
      const k = RELATION_KINDS[kind];
      const driver = byName(asm.mates ?? [], a.driver, "driver", "mate", "add one with add_mate.");
      const driven = byName(asm.mates ?? [], a.driven, "driven", "mate", "add one with add_mate.");
      if (driver.id === driven.id) throw new InputError("driver and driven are the same mate: pick two different ones.");
      if (!canDrive(driver, kind)) throw new InputError(`${driver.name} is a ${MATE_TYPES[driver.type].label} mate and doesn't ${kind === "linear" ? "slide" : "turn"}, so it can't drive a ${k.label} relation. ${kind === "linear" ? "Use a Slider (or Cylindrical) mate." : "Use a Hinge (or Cylindrical) mate."}`);
      if (!canBeDriven(driven, kind)) throw new InputError(`${driven.name} is a ${MATE_TYPES[driven.type].label} mate and doesn't ${kind === "gear" ? "turn" : "slide"}, so a ${k.label} relation can't drive it. ${kind === "gear" ? "A gear relation joins two hinges." : "Use a Slider (or Cylindrical) mate."}`);
      const ratio = a.ratio === undefined ? { text: k.defaultRatio } : amount(a.ratio, "ratio", s.scope(), { unit: k.ratioUnit === "mm" ? "mm" : "" });
      const name = a.name === undefined ? nextRelationName(asm, kind) : text(a.name, "name").slice(0, 80);
      if ((asm.relations ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a relation called "${name}". Choose another name.`);
      const relation: MateRelation = { id: newId("rl"), name, kind, driver: driver.id, driven: driven.id, ratio: ratio.text, ...(bool(a.reverse, "reverse") ? { reverse: true } : {}) };
      const settled = settleSolved(s.doc, asm.id, solve(s, asm));
      const r = await tryAssemblyChange(s, asm.id, putRelation(settled, asm.id, relation), `add ${name}`, [driver.id]);
      const moved = r.asm.instances.filter((i) => r.solved.drivenBy[i.id] === driven.id);
      return say(
        `Added ${name} (${k.label}): ${driver.name} now drives ${driven.name} (${k.ratioLabel.toLowerCase()} ${relation.ratio}${k.ratioUnit === "×" ? "×" : ` ${k.ratioUnit}`}${relation.reverse ? ", reversed" : ""}).`,
        moved.length ? `${moved.map((i) => `${i.name} is now ${placementText(r.solved.placements[i.id] ?? i.placement)}`).join("; ")}.` : null,
        `Turn or slide the driver with edit_mate {"mate": "${driver.name}", "values": {"${k.driverKey}": …}}.`,
      );
    },
  },
  {
    name: "replicate_part",
    title: "Copy a part into every matching hole",
    description:
      'Replicate (as in Onshape): a copy already mated into one hole (a bolt, pin or foot with a Fasten or Hinge mate on the hole\'s round edge or face) is copied into every other hole like it on the same part — each copy with its own mate. "instance": the original copy. Remove it with remove_assembly_item {"replicate": …}.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, instance: { type: "string" }, name: { type: "string" } }, required: ["instance"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "instance", "name"], "replicate_part");
      const asm = findAssembly(s, a.assembly);
      const inst = byName(asm.instances, a.instance, "instance", "copy", "insert parts with insert_into_assembly.");
      const source = replicateSource(asm, inst.id);
      if (typeof source === "string") throw new InputError(`${source} (${inst.name})`);
      const name = a.name === undefined ? nextReplicateName(asm) : text(a.name, "name").slice(0, 80);
      if ((asm.replicates ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a Replicate called "${name}". Choose another name.`);
      const rep = { id: newId("rp"), name, seed: inst.id, mate: source.mate.id };
      await s.checkpoint();
      const parts = builtParts(s);
      const holes = replicateHoles(asm, rep, parts, assembliesOf(s.doc));
      if (!holes.length) throw new InputError(`No other holes like the one ${source.mate.name} holds ${inst.name} in were found on the part it's mated to. Nothing was changed.`);
      const synced = updateAssembly(s.doc, asm.id, (x) => syncReplicate(x, rep, holes, () => newId("i")));
      const solvedAsm = assembliesOf(synced).find((x) => x.id === asm.id)!;
      const next = settlePlacements(synced, asm.id, solveDoc(s, solvedAsm, synced).placements);
      const r = await tryAssemblyChange(s, asm.id, next, `replicate ${inst.name}`);
      const made = r.asm.instances.filter((i) => i.replicaOf?.replicate === rep.id);
      return say(
        `Added ${name}: ${inst.name} copied into ${made.length} more hole${made.length === 1 ? "" : "s"}:`,
        ...made.map((i) => `- ${i.name}: ${placementText(r.solved.placements[i.id] ?? i.placement)}`),
      );
    },
  },
  {
    name: "add_explode_step",
    title: "Add a step to an exploded view",
    description:
      'Add a step to an assembly\'s exploded view: "parts" (copies by name — a sub-assembly moves as one piece — or a part inside a sub-assembly on its own, "Sub <1> / Part <1>") move "distance" mm along "direction" ("x", "y", "z", or "-x"… for the other way). Steps add up, one after another. Only the picture changes (get_views with "assembly", and drawings with "exploded"); mates, exports and checks keep the real places. Remove one with remove_assembly_item {"explode_step": n}.',
    inputSchema: {
      type: "object",
      properties: { assembly: ASSEMBLY_REF, parts: { type: "array", items: { type: "string" } }, direction: { type: "string", enum: ["x", "y", "z", "-x", "-y", "-z"] }, distance: {} },
      required: ["parts", "direction", "distance"],
    },
    run: (s, a) => {
      noExtras(a, ["assembly", "parts", "direction", "distance"], "add_explode_step");
      const asm = findAssembly(s, a.assembly);
      const dir = direction(a.direction, "direction");
      const distance = amount(a.distance, "distance", s.scope());
      if (Math.abs(distance.value) < 1e-9) throw new InputError("distance must not be 0: give how far they move (mm).");
      const leaves = leavesOf(asm, builtParts(s), assembliesOf(s.doc));
      const norm = (x: string) => x.toLowerCase().replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
      const instances: string[] = [];
      const inner: { instanceId: string; path: string[] }[] = [];
      list(a.parts, "parts").forEach((raw, k) => {
        if (typeof raw !== "string" || !raw.trim()) throw new InputError(`parts[${k}]: give a copy's name, e.g. "${asm.instances[0]?.name ?? "Part 1 <1>"}".`);
        const top = asm.instances.find((i) => norm(i.name) === norm(raw) || i.id === raw);
        if (top) {
          if (top.suppressed) throw new InputError(`parts[${k}]: ${top.name} is suppressed (switched off), so it isn't shown.`);
          if (!instances.includes(top.id)) instances.push(top.id);
          return;
        }
        const leaf = leaves.find((l) => l.path.length && (norm(l.name) === norm(raw) || l.key === raw));
        if (!leaf) throw new InputError(`parts[${k}]: there's no "${raw}" in ${asm.name}. The copies are: ${asm.instances.map((i) => `"${i.name}"`).join(", ")}${leaves.some((l) => l.path.length) ? `; parts inside sub-assemblies: ${leafNames(leaves.filter((l) => l.path.length))}` : ""}.`);
        if (!inner.some((p) => p.instanceId === leaf.top && p.path.join("/") === leaf.path.join("/"))) inner.push({ instanceId: leaf.top, path: leaf.path });
      });
      const step: ExplodeStep = { id: newId("xs"), instances, ...(inner.length ? { parts: inner } : {}), axis: dir.axis, ...(dir.flip ? { flip: true } : {}), distance: distance.text };
      if ("error" in stepDistance(step)) throw new InputError(`distance: ${(stepDistance(step) as { error: string }).error}`);
      s.commit(updateAssembly(s.doc, asm.id, (x) => putExplodeStep(x, step)));
      const n = (assembliesOf(s.doc).find((x) => x.id === asm.id)!.explodeSteps ?? []).length;
      const names = [...instances.map((id) => asm.instances.find((i) => i.id === id)!.name), ...inner.map((p) => leaves.find((l) => l.top === p.instanceId && l.path.join("/") === p.path.join("/"))!.name)];
      return say(`Added step ${n} to ${asm.name}'s exploded view: ${names.join(", ")} move${names.length === 1 ? "s" : ""} ${distance.text} mm along ${dir.flip ? "−" : "+"}${dir.axis.toUpperCase()}.`, `Look at it with get_views {"assembly": "${asm.name}"}.`);
    },
  },
  {
    name: "remove_assembly_item",
    title: "Remove a pattern, group, relation, Replicate or explode step",
    description:
      'Take something out of an assembly (one per call): "pattern" (a pattern or mirror by name — its copies go too), "group" (ungroup: the parts stay where they are but move separately), "relation" (a mate relation), "replicate" (a Replicate — its copies and their mates go too), or "explode_step" (a step of the exploded view by number, 1, 2…). Copies and mates are removed with remove_from_assembly and delete_mate.',
    inputSchema: {
      type: "object",
      properties: { assembly: ASSEMBLY_REF, pattern: { type: "string" }, group: { type: "string" }, relation: { type: "string" }, replicate: { type: "string" }, explode_step: { type: "number" } },
    },
    run: async (s, a) => {
      const kinds = ["pattern", "group", "relation", "replicate", "explode_step"] as const;
      noExtras(a, ["assembly", ...kinds], "remove_assembly_item");
      const given = kinds.filter((k) => a[k] !== undefined);
      if (given.length !== 1) throw new InputError(`Give one of ${kinds.map((k) => `"${k}"`).join(", ")} (one thing per call).`);
      const asm = findAssembly(s, a.assembly);
      const kind = given[0];
      const settled = () => settleSolved(s.doc, asm.id, solve(s, asm));
      let doc: JuraCADDocument;
      let what: string;
      if (kind === "pattern") {
        const p = byName(asm.patterns ?? [], a.pattern, "pattern", "pattern", "add one with add_assembly_pattern.");
        what = `${p.name} and its ${asm.instances.filter((i) => i.copyOf?.pattern === p.id).length} copies`;
        doc = updateAssembly(settled(), asm.id, (x) => removePattern(x, p.id));
      } else if (kind === "group") {
        const g = byName(asm.groups ?? [], a.group, "group", "group", "make one with group_parts.");
        what = `${g.name} (its parts stay where they are, and move separately again)`;
        doc = updateAssembly(settlePlacements(s.doc, asm.id, solve(s, asm).placements), asm.id, (x) => removeGroup(x, g.id));
      } else if (kind === "relation") {
        const r = byName(asm.relations ?? [], a.relation, "relation", "relation", "add one with add_mate_relation.");
        what = r.name;
        doc = removeRelation(settled(), asm.id, r.id);
      } else if (kind === "replicate") {
        const r = byName(asm.replicates ?? [], a.replicate, "replicate", "Replicate", "make one with replicate_part.");
        what = `${r.name} and its ${asm.instances.filter((i) => i.replicaOf?.replicate === r.id).length} copies`;
        doc = updateAssembly(settled(), asm.id, (x) => removeReplicate(x, r.id));
      } else {
        const steps = asm.explodeSteps ?? [];
        const n = a.explode_step;
        if (!steps.length) throw new InputError(`${asm.name}'s exploded view has no steps.`);
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > steps.length) throw new InputError(`explode_step must be a step number from 1 to ${steps.length}.`);
        what = `step ${n} of the exploded view`;
        doc = updateAssembly(s.doc, asm.id, (x) => removeExplodeStep(x, steps[n - 1].id));
      }
      await tryAssemblyChange(s, asm.id, doc, `remove ${what}`);
      return say(`Removed ${what} from ${asm.name}.`);
    },
  },
];

