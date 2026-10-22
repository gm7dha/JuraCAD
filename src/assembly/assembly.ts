/**
 * Pure changes to a document's assemblies. Like document.ts, each returns a
 * new document and never changes its input, so undo keeps working.
 */
import { newId } from "../model/document";
import { parsePick } from "../geometry/topoRef";
import type { Assembly, AssemblyGroup, ConnectorSpot, ExplodeStep, AssemblyPattern, Instance, Replicate, Mate, MateConnector, MateRelation, MateType, NamedPosition, JuraCADDocument } from "../model/types";
import { parseRelation } from "./relations";
import { parsePattern, tidyPatterns } from "./patterns";
import { parseReplicate, tidyReplicates } from "./replicate";
import { parseGroup, tidyGroups } from "./groups";
import { parseExplodeStep, tidyExplodeSteps } from "./explode";
import { applyPlacement, IDENTITY, parsePlacement, type Placement, type Vec3 } from "./math";
import { MATE_TYPES } from "./mates";
import { startingLength } from "../model/units";
import { massGrams, materialOf } from "../model/materials";

const assembliesOf = (doc: JuraCADDocument) => doc.assemblies ?? [];

function withAssemblies(doc: JuraCADDocument, assemblies: Assembly[]): JuraCADDocument {
  const { assemblies: _old, ...rest } = doc;
  return assemblies.length ? { ...rest, assemblies } : rest;
}

export function updateAssembly(doc: JuraCADDocument, id: string, fn: (a: Assembly) => Assembly): JuraCADDocument {
  if (!assembliesOf(doc).some((a) => a.id === id)) return doc;
  return withAssemblies(
    doc,
    // Exploded view steps forget parts that any change removed (patterns, Replicate, delete…).
    assembliesOf(doc).map((a) => (a.id === id ? tidyExplodeSteps(fn(a)) : a)),
  );
}

/** Next free name: "Assembly 1", "Assembly 2"… */
export function nextAssemblyName(doc: JuraCADDocument): string {
  const used = new Set(assembliesOf(doc).map((a) => a.name));
  let n = 1;
  while (used.has(`Assembly ${n}`)) n++;
  return `Assembly ${n}`;
}

export function addAssembly(doc: JuraCADDocument, id = newId("a")): JuraCADDocument {
  return withAssemblies(doc, [...assembliesOf(doc), { id, name: nextAssemblyName(doc), instances: [] }]);
}

export function removeAssembly(doc: JuraCADDocument, id: string): JuraCADDocument {
  return withAssemblies(
    doc,
    assembliesOf(doc).filter((a) => a.id !== id),
  );
}

export function renameAssembly(doc: JuraCADDocument, id: string, name: string): JuraCADDocument {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  return updateAssembly(doc, id, (a) => ({ ...a, name: trimmed }));
}

/** "Part 1 <3>" when there are already copies <1> and <2> of Part 1. */
export function nextInstanceName(assembly: Assembly, partName: string): string {
  const used = new Set(assembly.instances.map((i) => i.name));
  let n = 1;
  while (used.has(`${partName} <${n}>`)) n++;
  return `${partName} <${n}>`;
}

/**
 * Add a copy of a part. The first thing in an assembly is fixed where it is
 * (like Onshape), so everything else has something to be placed against.
 */
export function insertInstance(
  doc: JuraCADDocument,
  assemblyId: string,
  part: { id: string; name: string },
  placement: Placement = IDENTITY,
  id = newId("i"),
): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    instances: [...a.instances, { id, partId: part.id, name: nextInstanceName(a, part.name), placement, fixed: a.instances.length === 0 }],
  }));
}

export function updateInstance(
  doc: JuraCADDocument,
  assemblyId: string,
  instanceId: string,
  patch: Partial<Pick<Instance, "name" | "placement" | "fixed" | "configuration" | "suppressed">>,
): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    instances: a.instances.map((i) => {
      if (i.id !== instanceId) return i;
      const next = { ...i, ...patch, name: patch.name?.trim() || i.name };
      if ("configuration" in patch && !patch.configuration) delete next.configuration;
      if ("suppressed" in patch && !patch.suppressed) delete next.suppressed;
      return next;
    }),
  }));
}

/**
 * Copies of some instances (Onshape's copy and paste), each placed at its
 * original's place moved by `shift`. Mates between the copied parts are
 * copied too, so a hinged pair stays hinged; mates to other parts aren't.
 * Pattern and Replicate copies become ordinary parts. Returns the new ids too.
 */
export function duplicateInstances(
  a: Assembly,
  ids: string[],
  placements: Record<string, Placement>,
  shift: Vec3,
  newId: (prefix: string) => string,
): { assembly: Assembly; ids: string[] } {
  const chosen = a.instances.filter((i) => ids.includes(i.id));
  const map = new Map<string, string>();
  let instances = [...a.instances];
  for (const i of chosen) {
    const id = newId("i");
    map.set(i.id, id);
    const at = placements[i.id] ?? i.placement;
    const base = /^(.*) <\d+>$/.exec(i.name)?.[1] ?? i.name;
    const { copyOf: _c, replicaOf: _r, ...plain } = i;
    instances.push({ ...plain, id, name: nextInstanceName({ ...a, instances }, base), fixed: false, placement: { position: [at.position[0] + shift[0], at.position[1] + shift[1], at.position[2] + shift[2]], rotation: at.rotation } });
  }
  const used = new Set((a.mates ?? []).map((m) => m.name));
  const mateMap = new Map<string, string>();
  const copiedMates: Mate[] = (a.mates ?? [])
    .filter((m) => map.has(m.a.instanceId) && map.has(m.b.instanceId))
    .map((m) => {
      const { replicateOf: _r, ...plain } = m;
      const name = nextFreeName(used, m.name);
      used.add(name);
      const id = newId("m");
      mateMap.set(m.id, id);
      return { ...plain, id, name, a: { ...m.a, instanceId: map.get(m.a.instanceId)! }, b: { ...m.b, instanceId: map.get(m.b.instanceId)! } };
    });
  // Relations between copied mates (gears…), and groups made only of copied parts, come too.
  const usedRelations = new Set((a.relations ?? []).map((r) => r.name));
  const copiedRelations: MateRelation[] = (a.relations ?? [])
    .filter((r) => mateMap.has(r.driver) && mateMap.has(r.driven))
    .map((r) => {
      const name = nextFreeName(usedRelations, r.name);
      usedRelations.add(name);
      return { ...r, id: newId("rl"), name, driver: mateMap.get(r.driver)!, driven: mateMap.get(r.driven)! };
    });
  const usedGroups = new Set((a.groups ?? []).map((g) => g.name));
  const copiedGroups: AssemblyGroup[] = (a.groups ?? [])
    .filter((g) => g.members.every((m) => map.has(m)))
    .map((g) => {
      const name = nextFreeName(usedGroups, g.name);
      usedGroups.add(name);
      return { id: newId("g"), name, members: g.members.map((m) => map.get(m)!), offsets: Object.fromEntries(Object.entries(g.offsets).map(([m, o]) => [map.get(m) ?? m, o])) };
    });
  return {
    assembly: {
      ...a,
      instances,
      ...(copiedMates.length ? { mates: [...(a.mates ?? []), ...copiedMates] } : {}),
      ...(copiedRelations.length ? { relations: [...(a.relations ?? []), ...copiedRelations] } : {}),
      ...(copiedGroups.length ? { groups: [...(a.groups ?? []), ...copiedGroups] } : {}),
    },
    ids: [...map.values()],
  };
}

/** "Hinge 3" for a copy of "Hinge 1" (the next free number), or "Lid hinge (copy)". */
function nextFreeName(used: Set<string>, name: string): string {
  const m = /^(.*) (\d+)$/.exec(name);
  if (m) {
    let n = Number(m[2]) + 1;
    while (used.has(`${m[1]} ${n}`)) n++;
    return `${m[1]} ${n}`;
  }
  let candidate = `${name} (copy)`;
  for (let n = 2; used.has(candidate); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

/**
 * Show another part in an instance (Onshape's Replace instance), with its
 * pattern and Replicate copies. Mates on it are kept: each looks for the
 * most similar face or edge on the new part (pick it again if it's wrong).
 * An instance still carrying its part's name ("Bolt <2>") takes the new one's.
 */
export function replaceInstancePart(a: Assembly, instanceId: string, part: { id: string; name: string }, oldPartName?: string): Assembly {
  const target = a.instances.find((i) => i.id === instanceId);
  if (!target || target.partId === part.id) return a;
  const reps = new Set((a.replicates ?? []).filter((r) => r.seed === instanceId).map((r) => r.id));
  const changing = new Set(a.instances.filter((i) => i.id === instanceId || i.copyOf?.seed === instanceId || (i.replicaOf && reps.has(i.replicaOf.replicate))).map((i) => i.id));
  const instances: Instance[] = [];
  a.instances.forEach((i, k) => {
    if (!changing.has(i.id)) {
      instances.push(i);
      return;
    }
    // Another part has its own configurations: show it as in the Part Studio.
    const { configuration: _c, ...plain } = i;
    const auto = /^(.*) <\d+>$/.exec(i.name);
    const renamed = auto && (oldPartName === undefined || auto[1] === oldPartName);
    const others = { ...a, instances: [...instances, ...a.instances.slice(k + 1)] };
    instances.push({ ...plain, partId: part.id, name: renamed ? nextInstanceName(others, part.name) : i.name });
  });
  const repick = (c: MateConnector): MateConnector =>
    changing.has(c.instanceId) ? { ...c, pick: { ...c.pick, partId: part.id }, ...(c.pick2 ? { pick2: { ...c.pick2, partId: part.id } } : {}) } : c;
  return { ...a, instances, ...(a.mates ? { mates: a.mates.map((m) => ({ ...m, a: repick(m.a), b: repick(m.b) })) } : {}) };
}

/** Add or replace a relation. */
export function putRelation(doc: JuraCADDocument, assemblyId: string, relation: MateRelation): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const list = a.relations ?? [];
    return { ...a, relations: list.some((r) => r.id === relation.id) ? list.map((r) => (r.id === relation.id ? relation : r)) : [...list, relation] };
  });
}

/** Save the mates' amounts as they are now under a name (Onshape's named positions). */
export function savePosition(doc: JuraCADDocument, assemblyId: string, id: string, name: string): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const values = Object.fromEntries((a.mates ?? []).map((m) => [m.id, { ...m.values }]));
    return { ...a, positions: [...(a.positions ?? []), { id, name, values }] };
  });
}

/** Put the mates back to a saved position (mates made since then stay as they are). */
export function applyPosition(doc: JuraCADDocument, assemblyId: string, id: string): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const pos = a.positions?.find((p) => p.id === id);
    if (!pos || !a.mates) return a;
    return { ...a, mates: a.mates.map((m) => (pos.values[m.id] ? { ...m, values: { ...m.values, ...pos.values[m.id] } } : m)) };
  });
}

export function removePosition(doc: JuraCADDocument, assemblyId: string, id: string): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const { positions: _old, ...rest } = a;
    const left = (a.positions ?? []).filter((p) => p.id !== id);
    return left.length ? { ...rest, positions: left } : rest;
  });
}

/** Next free name: "Position 1", "Position 2"… */
export function nextPositionName(a: Assembly): string {
  const used = new Set((a.positions ?? []).map((p) => p.name));
  let n = 1;
  while (used.has(`Position ${n}`)) n++;
  return `Position ${n}`;
}

/** Remove a relation. */
export function removeRelation(doc: JuraCADDocument, assemblyId: string, id: string): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const { relations: _old, ...rest } = a;
    const left = (a.relations ?? []).filter((r) => r.id !== id);
    return left.length ? { ...rest, relations: left } : rest;
  });
}

/** Remove instances, and the mates that joined them to anything. */
export function removeInstances(doc: JuraCADDocument, assemblyId: string, ids: string[]): JuraCADDocument {
  const gone = new Set(ids);
  return updateAssembly(doc, assemblyId, (a) =>
    tidyExplodeSteps(tidyGroups(tidyReplicates(
      tidyPatterns(
        withMates(
          { ...a, instances: a.instances.filter((i) => !gone.has(i.id)) },
          (a.mates ?? []).filter((m) => !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId)),
        ),
      ),
    ))),
  );
}

/** The assembly with just these mates (and the relations between mates still there). */
export function withMates(a: Assembly, mates: Mate[]): Assembly {
  const { mates: _old, relations: oldRelations, ...rest } = a;
  // Gear, rack and screw relations go with the mates they link.
  const ids = new Set(mates.map((m) => m.id));
  const relations = (oldRelations ?? []).filter((r) => ids.has(r.driver) && ids.has(r.driven));
  return { ...rest, ...(mates.length ? { mates } : {}), ...(relations.length ? { relations } : {}) };
}

/** Add a mate, or replace the one with the same id. */
export function putMate(doc: JuraCADDocument, assemblyId: string, mate: Mate): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const mates = a.mates ?? [];
    return withMates(a, mates.some((m) => m.id === mate.id) ? mates.map((m) => (m.id === mate.id ? mate : m)) : [...mates, mate]);
  });
}

export function removeMate(doc: JuraCADDocument, assemblyId: string, mateId: string): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => tidyReplicates(withMates(a, (a.mates ?? []).filter((m) => m.id !== mateId))));
}

/** Spread the parts apart for an exploded view (null puts them back together; 0 shows only the exploded view's steps). */
export function setExplode(doc: JuraCADDocument, assemblyId: string, amount: number | null): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const { explode: _old, ...rest } = a;
    return amount !== null && Number.isFinite(amount) && amount >= 0 ? { ...rest, explode: Math.min(amount, 10) } : rest;
  });
}

/** Store where the mates put each part, so it stays there if a mate is later removed. */
export function settlePlacements(doc: JuraCADDocument, assemblyId: string, placements: Record<string, Placement>): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    instances: a.instances.map((i) => {
      const p = placements[i.id];
      if (!p || i.fixed) return i;
      const same = p.position.every((v, k) => Math.abs(v - i.placement.position[k]) < 1e-9) && p.rotation.every((v, k) => Math.abs(v - i.placement.rotation[k]) < 1e-12);
      return same ? i : { ...i, placement: p };
    }),
  }));
}

/**
 * Store where the solve put everything: each part's place, and the movements
 * that loops of mates adjusted (so the next solve starts from there and a
 * linkage stays the way it was left). Amounts typed as maths or variables
 * are left as typed.
 */
export function settleSolved(
  doc: JuraCADDocument,
  assemblyId: string,
  solved: { placements: Record<string, Placement>; adjusted?: Record<string, Record<string, number>> },
): JuraCADDocument {
  const settled = settlePlacements(doc, assemblyId, solved.placements);
  const adjusted = solved.adjusted ?? {};
  if (!Object.keys(adjusted).length) return settled;
  return updateAssembly(settled, assemblyId, (a) => ({
    ...a,
    ...(a.mates
      ? {
          mates: a.mates.map((m) => {
            const changes = adjusted[m.id];
            if (!changes) return m;
            const values = { ...m.values };
            for (const [key, v] of Object.entries(changes)) {
              const typed = (values[key] ?? "").trim();
              if (typed && !isPlainAmount(typed)) continue;
              const unit = MATE_TYPES[m.type].values.find((d) => d.key === key)?.unit;
              // Tidy numbers: to a thousandth (of a degree, or of a mm), and nothing left as "-0.000004".
              const tidy = Math.abs(v) < 5e-4 ? 0 : Math.round(v * 1000) / 1000;
              values[key] = unit === "mm" ? startingLength(tidy) : String(tidy === 0 ? 0 : tidy);
            }
            return { ...m, values };
          }),
        }
      : {}),
  }));
}

/** A typed amount that's just a number (in mm, or inches as " in"), not maths or a variable. */
const isPlainAmount = (typed: string) => /^-?\d*\.?\d+(e-?\d+)?( in)?$/i.test(typed);

export interface BomRow {
  partId: string;
  name: string;
  quantity: number;
  /** True when the part no longer exists in the Part Studio. */
  missing: boolean;
  /** The part's material (e.g. "PLA"), when known. */
  material?: string;
  /** What one of them weighs (grams), when known. */
  massEach?: number;
  /** A surface (a skin with no inside): it has no weight. */
  surface?: boolean;
}

/** What the parts list can say about the part an instance shows: its material (key) and solid volume (mm³; null for a surface). */
export type BomInfo = (instance: Instance) => { material?: string; volume: number | null } | null;

/** Bill of materials: each part once, with how many copies are in the assembly (in order of first use). */
export function billOfMaterials(assembly: Assembly, partNames: Record<string, string>, configurationNames: Record<string, string> = {}, info?: BomInfo): BomRow[] {
  const rows = new Map<string, BomRow>();
  // Suppressed parts aren't in the parts list (like Onshape).
  for (const i of assembly.instances) {
    if (i.suppressed) continue;
    // A part in another configuration is a different line ("Bracket (Large)").
    const cfgKey = i.configuration && configurationNames[i.configuration] ? `${i.partId}@${i.configuration}` : i.partId;
    // A mirrored copy is the opposite hand: a different part to make.
    const key = i.mirrored ? `${cfgKey}~mirrored` : cfgKey;
    const row = rows.get(key);
    if (row) row.quantity++;
    else {
      const name = partNames[i.partId];
      const base = name ?? i.name.replace(/\s*<\d+>$/, "");
      const cfg = cfgKey !== i.partId ? ` (${configurationNames[i.configuration!]})` : "";
      const props = name !== undefined ? info?.(i) : null;
      rows.set(key, {
        partId: key,
        name: base + cfg + (i.mirrored ? " (mirrored)" : ""),
        quantity: 1,
        missing: name === undefined,
        ...(props ? { material: materialOf(props.material).label } : {}),
        ...(props && props.volume !== null && props.volume > 0 ? { massEach: massGrams(props.volume, props.material) } : {}),
        ...(props && props.volume === null ? { surface: true } : {}),
      });
    }
  }
  return [...rows.values()];
}

/** What everything in the parts list weighs together (grams), and whether any part's weight is unknown (surfaces weigh nothing). */
export function bomTotalMass(rows: BomRow[]): { grams: number; partial: boolean } {
  let grams = 0;
  let partial = false;
  for (const r of rows) {
    if (r.surface) continue;
    if (r.massEach === undefined) partial = true;
    else grams += r.massEach * r.quantity;
  }
  return { grams, partial };
}

/** The bill of materials as a CSV file's text (opens in any spreadsheet). */
export function bomCsv(rows: BomRow[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const extra = rows.some((r) => r.material !== undefined || r.massEach !== undefined);
  const grams = (g: number | undefined) => (g === undefined ? "" : String(Math.round(g * 10) / 10));
  if (!extra) return ["Item,Part,Quantity", ...rows.map((r, i) => `${i + 1},${cell(r.name)},${r.quantity}`)].join("\n") + "\n";
  return (
    [
      "Item,Part,Quantity,Material,Weight each (g),Weight (g)",
      ...rows.map((r, i) => `${i + 1},${cell(r.name)},${r.quantity},${cell(r.material ?? "")},${grams(r.massEach)},${grams(r.massEach === undefined ? undefined : r.massEach * r.quantity)}`),
    ].join("\n") + "\n"
  );
}

/** Volume (mm³) enclosed by a closed triangle mesh (x, y, z corners; three corner numbers per triangle). */
export function meshVolume(vertices: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = 3 * triangles[t];
    const b = 3 * triangles[t + 1];
    const c = 3 * triangles[t + 2];
    const [ax, ay, az] = [vertices[a], vertices[a + 1], vertices[a + 2]];
    const [bx, by, bz] = [vertices[b], vertices[b + 1], vertices[b + 2]];
    const [cx, cy, cz] = [vertices[c], vertices[c + 1], vertices[c + 2]];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

// ---------------------------------------------------------------------------
// Reading from files and browser storage



const MATE_TYPE_NAMES = new Set<string>(["fastened", "revolute", "slider", "cylindrical", "planar", "ball", "pinSlot", "parallel", "width", "tangent"]);

const SPOTS = new Set<string>(["start", "end", "middle", "clicked"]);

function parseConnector(raw: unknown): MateConnector | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const pick = parsePick(c.pick);
  if (typeof c.instanceId !== "string" || !pick) return null;
  const pick2 = c.pick2 ? parsePick(c.pick2) : null;
  const point = Array.isArray(c.point) && c.point.length === 3 && c.point.every((v) => typeof v === "number" && Number.isFinite(v)) ? (c.point as [number, number, number]) : null;
  const spot = typeof c.spot === "string" && SPOTS.has(c.spot) && (c.spot !== "clicked" || point) ? (c.spot as ConnectorSpot) : null;
  return { instanceId: c.instanceId, pick, ...(pick2 ? { pick2 } : {}), ...(spot ? { spot } : {}), ...(point ? { point } : {}) };
}

function parseMate(raw: unknown, ids: Set<string>): Mate | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || ids.has(m.id) || typeof m.type !== "string" || !MATE_TYPE_NAMES.has(m.type)) return null;
  const a = parseConnector(m.a);
  const b = parseConnector(m.b);
  if (!a || !b) return null;
  ids.add(m.id);
  const values: Record<string, string> = {};
  if (m.values && typeof m.values === "object") {
    for (const [k, v] of Object.entries(m.values as Record<string, unknown>)) {
      if (typeof v === "string") values[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) values[k] = String(v);
    }
  }
  let limits: Mate["limits"];
  if (m.limits && typeof m.limits === "object") {
    for (const [k, v] of Object.entries(m.limits as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const l = v as Record<string, unknown>;
      const end: { min?: string; max?: string } = {};
      for (const e of ["min", "max"] as const) {
        if (typeof l[e] === "string" && (l[e] as string).trim()) end[e] = l[e] as string;
        else if (typeof l[e] === "number" && Number.isFinite(l[e])) end[e] = String(l[e]);
      }
      if (end.min !== undefined || end.max !== undefined) (limits ??= {})[k] = end;
    }
  }
  return {
    id: m.id,
    name: typeof m.name === "string" && m.name.trim() ? m.name : "Mate",
    type: m.type as MateType,
    a,
    b,
    flip: m.flip === true,
    values,
    ...(limits ? { limits } : {}),
    ...(m.suppressed === true ? { suppressed: true } : {}),
    ...(typeof m.replicateOf === "string" ? { replicateOf: m.replicateOf } : {}),
  };
}

/** Check assemblies from untrusted JSON. Bad entries are dropped rather than failing the whole file. */
export function parseAssemblies(raw: unknown): Assembly[] {
  if (!Array.isArray(raw)) return [];
  const out: Assembly[] = [];
  const ids = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== "string" || ids.has(r.id)) continue;
    ids.add(r.id);
    const instances: Instance[] = [];
    for (const i of Array.isArray(r.instances) ? r.instances : []) {
      if (!i || typeof i !== "object") continue;
      const ri = i as Record<string, unknown>;
      if (typeof ri.id !== "string" || typeof ri.partId !== "string" || ids.has(ri.id)) continue;
      ids.add(ri.id);
      const copy = (ri.copyOf ?? null) as Record<string, unknown> | null;
      instances.push({
        id: ri.id,
        partId: ri.partId,
        name: typeof ri.name === "string" && ri.name.trim() ? ri.name : "Part",
        placement: parsePlacement(ri.placement),
        fixed: ri.fixed === true,
        ...(typeof ri.configuration === "string" && ri.configuration ? { configuration: ri.configuration } : {}),
        ...(ri.mirrored === true ? { mirrored: true } : {}),
        ...(ri.suppressed === true ? { suppressed: true } : {}),
        ...(ri.replicaOf && typeof (ri.replicaOf as Record<string, unknown>).replicate === "string" && Number.isInteger((ri.replicaOf as Record<string, unknown>).index)
          ? { replicaOf: { replicate: (ri.replicaOf as { replicate: string }).replicate, index: (ri.replicaOf as { index: number }).index }, fixed: false }
          : {}),
        ...(copy && typeof copy.pattern === "string" && typeof copy.seed === "string" && typeof copy.index === "number" && Number.isInteger(copy.index) && copy.index > 0
          ? { copyOf: { pattern: copy.pattern, seed: copy.seed, index: copy.index }, fixed: false }
          : {}),
      });
    }
    const mates: Mate[] = [];
    for (const m of Array.isArray(r.mates) ? r.mates : []) {
      const mate = parseMate(m, ids);
      if (mate) mates.push(mate);
    }
    const assembly: Assembly = {
      id: r.id,
      name: typeof r.name === "string" && r.name.trim() ? r.name : "Assembly",
      instances,
      ...(typeof r.explode === "number" && Number.isFinite(r.explode) && r.explode >= 0 ? { explode: Math.min(r.explode, 10) } : {}),
    };
    const mateIds = new Set(mates.map((m) => m.id));
    const relations = (Array.isArray(r.relations) ? r.relations : [])
      .map(parseRelation)
      .filter((x): x is MateRelation => !!x && mateIds.has(x.driver) && mateIds.has(x.driven));
    const positions: NamedPosition[] = [];
    for (const raw of Array.isArray(r.positions) ? r.positions : []) {
      const p = (raw ?? {}) as Record<string, unknown>;
      if (typeof p.id !== "string" || !p.values || typeof p.values !== "object") continue;
      const values: Record<string, Record<string, string>> = {};
      for (const [mid, v] of Object.entries(p.values as Record<string, unknown>)) {
        if (!mateIds.has(mid) || !v || typeof v !== "object") continue;
        values[mid] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
      }
      positions.push({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 80) : "Position", values });
    }
    const instanceIds = new Set(instances.map((i) => i.id));
    const patterns = (Array.isArray(r.patterns) ? r.patterns : []).map((p) => parsePattern(p, instanceIds)).filter((p): p is AssemblyPattern => !!p);
    const replicates = (Array.isArray(r.replicates) ? r.replicates : []).map(parseReplicate).filter((x): x is Replicate => !!x);
    // Each part in one group at most.
    const explodeSteps = (Array.isArray(r.explodeSteps) ? r.explodeSteps : []).map(parseExplodeStep).filter((x): x is ExplodeStep => !!x);
    const groups: AssemblyGroup[] = [];
    for (const raw of Array.isArray(r.groups) ? r.groups : []) {
      const g = parseGroup(raw);
      if (g && g.members.every((m) => instanceIds.has(m) && !groups.some((x) => x.members.includes(m)))) groups.push(g);
    }
    out.push(
      tidyExplodeSteps(tidyGroups(tidyReplicates(tidyPatterns({
        ...(mates.length ? { ...assembly, mates } : assembly),
        ...(relations.length ? { relations } : {}),
        ...(positions.length ? { positions } : {}),
        ...(patterns.length ? { patterns } : {}),
        ...(replicates.length ? { replicates } : {}),
        ...(groups.length ? { groups } : {}),
        ...(explodeSteps.length ? { explodeSteps } : {}),
      })))),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where to put a newly inserted copy

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** Bounding box of a list of x, y, z corners (null if there are none). */
export function boundsOfVertices(v: ArrayLike<number>): Box3 | null {
  if (v.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = v[i + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return { min, max };
}

/** The box around a part's box once it's placed (turned boxes get bigger to hold every corner). */
export function placedBox(box: Box3, placement: Placement): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const p = applyPlacement(placement, [x, y, z]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
  return { min, max };
}

/** A part's box as a mirrored instance shows it (flipped across its own YZ plane). */
export function mirroredBox(box: Box3): Box3 {
  return { min: [-box.max[0], box.min[1], box.min[2]], max: [-box.min[0], box.max[1], box.max[2]] };
}

/**
 * A placement for a new copy that sits just beside (in +X) everything already
 * in the assembly, so it doesn't land inside another part. The first copy
 * stays exactly where the part is in the Part Studio.
 */
export function spotBeside(existing: Box3[], part: Box3, gap = 10): Placement {
  if (existing.length === 0) return IDENTITY;
  const right = Math.max(...existing.map((b) => b.max[0]));
  return { position: [right + gap - part.min[0], 0, 0], rotation: [0, 0, 0, 1] };
}
