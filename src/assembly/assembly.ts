/**
 * Pure changes to a document's assemblies. Like document.ts, each returns a
 * new document and never changes its input, so undo keeps working.
 */
import { newId } from "../model/document";
import { parsePick } from "../geometry/topoRef";
import type { Assembly, AssemblyGroup, AssemblyPattern, Instance, Replicate, Mate, MateConnector, MateRelation, MateType, NamedPosition, PartSmithDocument } from "../model/types";
import { parseRelation } from "./relations";
import { parsePattern, tidyPatterns } from "./patterns";
import { parseReplicate, tidyReplicates } from "./replicate";
import { parseGroup, tidyGroups } from "./groups";
import { applyPlacement, IDENTITY, parsePlacement, type Placement, type Vec3 } from "./math";

const assembliesOf = (doc: PartSmithDocument) => doc.assemblies ?? [];

function withAssemblies(doc: PartSmithDocument, assemblies: Assembly[]): PartSmithDocument {
  const { assemblies: _old, ...rest } = doc;
  return assemblies.length ? { ...rest, assemblies } : rest;
}

export function updateAssembly(doc: PartSmithDocument, id: string, fn: (a: Assembly) => Assembly): PartSmithDocument {
  if (!assembliesOf(doc).some((a) => a.id === id)) return doc;
  return withAssemblies(
    doc,
    assembliesOf(doc).map((a) => (a.id === id ? fn(a) : a)),
  );
}

/** Next free name: "Assembly 1", "Assembly 2"… */
export function nextAssemblyName(doc: PartSmithDocument): string {
  const used = new Set(assembliesOf(doc).map((a) => a.name));
  let n = 1;
  while (used.has(`Assembly ${n}`)) n++;
  return `Assembly ${n}`;
}

export function addAssembly(doc: PartSmithDocument, id = newId("a")): PartSmithDocument {
  return withAssemblies(doc, [...assembliesOf(doc), { id, name: nextAssemblyName(doc), instances: [] }]);
}

export function removeAssembly(doc: PartSmithDocument, id: string): PartSmithDocument {
  return withAssemblies(
    doc,
    assembliesOf(doc).filter((a) => a.id !== id),
  );
}

export function renameAssembly(doc: PartSmithDocument, id: string, name: string): PartSmithDocument {
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
  doc: PartSmithDocument,
  assemblyId: string,
  part: { id: string; name: string },
  placement: Placement = IDENTITY,
  id = newId("i"),
): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    instances: [...a.instances, { id, partId: part.id, name: nextInstanceName(a, part.name), placement, fixed: a.instances.length === 0 }],
  }));
}

export function updateInstance(
  doc: PartSmithDocument,
  assemblyId: string,
  instanceId: string,
  patch: Partial<Pick<Instance, "name" | "placement" | "fixed" | "configuration">>,
): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    instances: a.instances.map((i) => {
      if (i.id !== instanceId) return i;
      const next = { ...i, ...patch, name: patch.name?.trim() || i.name };
      if ("configuration" in patch && !patch.configuration) delete next.configuration;
      return next;
    }),
  }));
}

/** Add or replace a relation. */
export function putRelation(doc: PartSmithDocument, assemblyId: string, relation: MateRelation): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const list = a.relations ?? [];
    return { ...a, relations: list.some((r) => r.id === relation.id) ? list.map((r) => (r.id === relation.id ? relation : r)) : [...list, relation] };
  });
}

/** Save the mates' amounts as they are now under a name (Onshape's named positions). */
export function savePosition(doc: PartSmithDocument, assemblyId: string, id: string, name: string): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const values = Object.fromEntries((a.mates ?? []).map((m) => [m.id, { ...m.values }]));
    return { ...a, positions: [...(a.positions ?? []), { id, name, values }] };
  });
}

/** Put the mates back to a saved position (mates made since then stay as they are). */
export function applyPosition(doc: PartSmithDocument, assemblyId: string, id: string): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const pos = a.positions?.find((p) => p.id === id);
    if (!pos || !a.mates) return a;
    return { ...a, mates: a.mates.map((m) => (pos.values[m.id] ? { ...m, values: { ...m.values, ...pos.values[m.id] } } : m)) };
  });
}

export function removePosition(doc: PartSmithDocument, assemblyId: string, id: string): PartSmithDocument {
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
export function removeRelation(doc: PartSmithDocument, assemblyId: string, id: string): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const { relations: _old, ...rest } = a;
    const left = (a.relations ?? []).filter((r) => r.id !== id);
    return left.length ? { ...rest, relations: left } : rest;
  });
}

/** Remove instances, and the mates that joined them to anything. */
export function removeInstances(doc: PartSmithDocument, assemblyId: string, ids: string[]): PartSmithDocument {
  const gone = new Set(ids);
  return updateAssembly(doc, assemblyId, (a) =>
    tidyGroups(tidyReplicates(
      tidyPatterns(
        withMates(
          { ...a, instances: a.instances.filter((i) => !gone.has(i.id)) },
          (a.mates ?? []).filter((m) => !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId)),
        ),
      ),
    )),
  );
}

function withMates(a: Assembly, mates: Mate[]): Assembly {
  const { mates: _old, ...rest } = a;
  return mates.length ? { ...rest, mates } : rest;
}

/** Add a mate, or replace the one with the same id. */
export function putMate(doc: PartSmithDocument, assemblyId: string, mate: Mate): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const mates = a.mates ?? [];
    return withMates(a, mates.some((m) => m.id === mate.id) ? mates.map((m) => (m.id === mate.id ? mate : m)) : [...mates, mate]);
  });
}

export function removeMate(doc: PartSmithDocument, assemblyId: string, mateId: string): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => tidyReplicates(withMates(a, (a.mates ?? []).filter((m) => m.id !== mateId))));
}

/** Spread the parts apart for an exploded view (null or 0 puts them back together). */
export function setExplode(doc: PartSmithDocument, assemblyId: string, amount: number | null): PartSmithDocument {
  return updateAssembly(doc, assemblyId, (a) => {
    const { explode: _old, ...rest } = a;
    return amount && amount > 0 ? { ...rest, explode: amount } : rest;
  });
}

/** Store where the mates put each part, so it stays there if a mate is later removed. */
export function settlePlacements(doc: PartSmithDocument, assemblyId: string, placements: Record<string, Placement>): PartSmithDocument {
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

export interface BomRow {
  partId: string;
  name: string;
  quantity: number;
  /** True when the part no longer exists in the Part Studio. */
  missing: boolean;
}

/** Bill of materials: each part once, with how many copies are in the assembly (in order of first use). */
export function billOfMaterials(assembly: Assembly, partNames: Record<string, string>, configurationNames: Record<string, string> = {}): BomRow[] {
  const rows = new Map<string, BomRow>();
  for (const i of assembly.instances) {
    // A part in another configuration is a different line ("Bracket (Large)").
    const key = i.configuration && configurationNames[i.configuration] ? `${i.partId}@${i.configuration}` : i.partId;
    const row = rows.get(key);
    if (row) row.quantity++;
    else {
      const name = partNames[i.partId];
      const base = name ?? i.name.replace(/\s*<\d+>$/, "");
      const cfg = key !== i.partId ? ` (${configurationNames[i.configuration!]})` : "";
      rows.set(key, { partId: key, name: base + cfg, quantity: 1, missing: name === undefined });
    }
  }
  return [...rows.values()];
}

/** The bill of materials as a CSV file's text (opens in any spreadsheet). */
export function bomCsv(rows: BomRow[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["Item,Part,Quantity", ...rows.map((r, i) => `${i + 1},${cell(r.name)},${r.quantity}`)].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Reading from files and browser storage



const MATE_TYPE_NAMES = new Set<string>(["fastened", "revolute", "slider", "cylindrical", "planar", "ball", "pinSlot", "parallel"]);

function parseConnector(raw: unknown): MateConnector | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const pick = parsePick(c.pick);
  if (typeof c.instanceId !== "string" || !pick) return null;
  return { instanceId: c.instanceId, pick };
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
      ...(typeof r.explode === "number" && Number.isFinite(r.explode) && r.explode > 0 ? { explode: Math.min(r.explode, 10) } : {}),
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
    const groups: AssemblyGroup[] = [];
    for (const raw of Array.isArray(r.groups) ? r.groups : []) {
      const g = parseGroup(raw);
      if (g && g.members.every((m) => instanceIds.has(m) && !groups.some((x) => x.members.includes(m)))) groups.push(g);
    }
    out.push(
      tidyGroups(tidyReplicates(tidyPatterns({
        ...(mates.length ? { ...assembly, mates } : assembly),
        ...(relations.length ? { relations } : {}),
        ...(positions.length ? { positions } : {}),
        ...(patterns.length ? { patterns } : {}),
        ...(replicates.length ? { replicates } : {}),
        ...(groups.length ? { groups } : {}),
      }))),
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
