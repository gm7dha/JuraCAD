/**
 * Claude's assembly tools: make an assembly, put copies of parts (or other
 * assemblies) in it, fix them, join them with mates, list the parts, check
 * for clashes, explode it, and look at it. Built on the same pure document
 * edits as the app (src/assembly), so everything stays editable there.
 *
 * Faces and edges on a copy are chosen as on a part (picks.ts: "top", "F3",
 * "E5", {"near": [x, y, z]}) — but as the copy sits in the assembly: "top" is
 * the copy's face facing +Z now, and positions are assembly positions.
 */
import { addAssembly, billOfMaterials, insertInstance, placedBox, putMate, removeInstances, removeMate, renameAssembly, setExplode, settleSolved, spotBeside, updateInstance, type Box3 } from "../assembly/assembly";
import { DEFAULT_CLASH_OPTIONS, assemblyReport, judgeContacts, type ClashOptions } from "../assembly/assemblyCheck";
import { findMesh, meshIdOf } from "../assembly/configured";
import { applyPlacement, compose, eulerDegFromQuat, IDENTITY, quatFromEulerDeg, rotate, type Placement, type Vec3 } from "../assembly/math";
import { MATE_ORDER, MATE_TYPES, nextMateName, solveWithParts, type SolveResult } from "../assembly/mates";
import { isOrigin, originConnector, ORIGIN_PLANES, type OriginPlane } from "../assembly/origin";
import { explodeAssembly, instancesForKernel, partBox } from "../assembly/placed";
import { insertProblem, insertSubAssembly, leavesOf, ownBox, type Leaf } from "../assembly/subassembly";
import { mateInactive } from "../assembly/suppress";
import type { EdgeRef, FaceRef, TopoPick } from "../geometry/topoRef";
import type { InstanceInput, PartMesh } from "../kernel/protocol";
import { newId } from "../model/document";
import type { Assembly, ConnectorSpot, Instance, JuraCADDocument, Mate, MateConnector, MateType } from "../model/types";
import { amount, bool, InputError, list, noExtras, object, oneOf, text, xyz, type Obj } from "./args";
import { pickEdges, pickFaces, PICK_HELP } from "./picks";
import { renderViews, type RenderPart, type RenderView } from "./render";
import type { Session } from "./session";
import { byName, r2, say, type ToolDef, type ToolResult } from "./toolKit";

// ---------------------------------------------------------------------------
// Finding things

const assembliesOf = (doc: JuraCADDocument) => doc.assemblies ?? [];
const MAKE_ONE = 'make one with create_assembly, then insert parts with insert_into_assembly.';

/** The assembly named (or the only one, when there's just one). */
export function findAssembly(s: Session, ref: unknown, where = "assembly"): Assembly {
  const all = assembliesOf(s.doc);
  if ((ref === undefined || ref === null || ref === "") && all.length === 1) return all[0];
  if ((ref === undefined || ref === null || ref === "") && all.length > 1) throw new InputError(`${where}: say which assembly — ${all.map((a) => `"${a.name}"`).join(", ")}.`);
  return byName(all, ref, where, "assembly", MAKE_ONE);
}

/** Every part of every Part Studio as built now (with parts made in other configurations, for assemblies that show them). */
function builtParts(s: Session): PartMesh[] {
  return s.buildAll().parts;
}

/** The parts Claude can insert: every Part Studio's parts in the configuration on show. */
function insertableParts(s: Session): PartMesh[] {
  return builtParts(s).filter((p) => !p.configuration);
}

function solve(s: Session, asm: Assembly, hold: string[] = []): SolveResult {
  return solveWithParts(asm, builtParts(s), { assemblies: assembliesOf(s.doc), hold });
}

const norm = (name: string) => name.toLowerCase().replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();

/** One part shown by the assembly, at any depth: a copy, or a part inside a sub-assembly copy ("Hinge <1> / Pin <1>"). */
interface Target {
  leaf: Leaf;
  /** Where the part sits in the assembly now (its top-level copy's solved place, and its place inside that). */
  placement: Placement;
  mesh: PartMesh;
}

function leafNames(leaves: Leaf[]): string {
  return leaves.map((l) => `"${l.name}"`).join(", ");
}

/** A part shown by the assembly, by its copy's name ("Bracket <1>"), or "Sub <1> / Part <1>" inside a sub-assembly. */
function findTarget(s: Session, asm: Assembly, ref: unknown, where: string, solved = solve(s, asm)): Target {
  const parts = builtParts(s);
  const leaves = leavesOf(asm, parts, assembliesOf(s.doc));
  if (typeof ref !== "string" || !ref.trim()) throw new InputError(`${where}: give the name of a copy in ${asm.name}${leaves.length ? `, e.g. "${leaves[0].name}"` : ""}.`);
  const want = norm(ref);
  let leaf = leaves.find((l) => norm(l.name) === want || l.key.toLowerCase() === want);
  if (!leaf) {
    const top = asm.instances.find((i) => i.id.toLowerCase() === want || norm(i.name) === want);
    if (top?.subAssembly) {
      const inner = leaves.filter((l) => l.top === top.id);
      throw new InputError(`${where}: ${top.name} is a sub-assembly (it moves as one piece). Name a part inside it, e.g. ${leafNames(inner.slice(0, 4))}.`);
    }
    if (top?.suppressed) throw new InputError(`${where}: ${top.name} is suppressed (switched off). Switch it back on with place_instance {"suppressed": false} first.`);
    throw new InputError(`${where}: there's no copy called "${ref}" in ${asm.name}. ${leaves.length ? `Its parts are: ${leafNames(leaves)}.` : `It's empty: insert parts with insert_into_assembly.`}`);
  }
  const mesh = findMesh(parts, meshIdOf(leaf.instance));
  if (!mesh) throw new InputError(`${where}: ${leaf.name}'s part no longer exists in its Part Studio. Remove it (remove_from_assembly) or undo the change that removed the part.`);
  const top = asm.instances.find((i) => i.id === leaf!.top)!;
  const at = solved.placements[top.id] ?? top.placement;
  return { leaf, placement: leaf.path.length ? compose(at, leaf.relative) : at, mesh };
}

const flipX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/**
 * A part's faces and edges as they sit in the assembly (moved, turned, and
 * flipped for a mirrored copy), numbered as on the part itself.
 */
function placedFacesAndEdges(t: Target) {
  const mirrored = !!t.leaf.instance.mirrored;
  const point = (p: Vec3) => applyPlacement(t.placement, mirrored ? flipX(p) : p);
  const dir = (v: Vec3) => rotate(t.placement.rotation, mirrored ? flipX(v) : v);
  const faceRefs: FaceRef[] = t.mesh.faceRefs.map((f) => ({ ...f, center: point(f.center), normal: dir(f.normal) }));
  const edgeRefs: EdgeRef[] = t.mesh.edgeRefs.map((e) => ({ ...e, a: point(e.a), b: point(e.b), mid: point(e.mid) }));
  return { ...t.mesh, name: t.leaf.name, faceRefs, edgeRefs };
}

/** For list_faces / list_edges with an instance: the copy's faces and edges as they sit in the assembly. */
export function instanceFaces(s: Session, assemblyRef: unknown, instanceRef: unknown) {
  const asm = findAssembly(s, assemblyRef);
  return placedFacesAndEdges(findTarget(s, asm, instanceRef, "instance"));
}

// ---------------------------------------------------------------------------
// Mates

const MATE_WORDS: Record<string, MateType> = {
  fasten: "fastened",
  fastened: "fastened",
  hinge: "revolute",
  revolute: "revolute",
  slider: "slider",
  cylindrical: "cylindrical",
  planar: "planar",
  pin_slot: "pinSlot",
  pinslot: "pinSlot",
  "pin slot": "pinSlot",
  parallel: "parallel",
  width: "width",
  tangent: "tangent",
  ball: "ball",
};

const MATE_HELP = MATE_ORDER.map((t) => `${t === "fastened" ? "fasten" : t === "revolute" ? "hinge (revolute)" : t === "pinSlot" ? "pin_slot" : t}: ${MATE_TYPES[t].description} Amounts: ${MATE_TYPES[t].values.map((v) => `${v.key} (${v.label}, ${v.unit})`).join(", ")}.`);

const CONNECTOR_HELP =
  `Each end is {"instance": "<copy name>", "face": …} or {"instance": …, "edge": …} (a round edge puts the connector at its centre, on its axis — the usual choice for hinges and pins in holes), optionally "at": "start" | "end" | "middle" on an edge; Width mates take "face" and "face2" (the two sides) on each end; {"origin": "Top" | "Front" | "Right"} is one of the assembly's own planes (it never moves). Faces and edges are chosen as on a part, but as the copy sits in the assembly now: ${PICK_HELP.faces} Edges: "E5" (list_edges with "assembly" and "instance" numbers them) or {"near": [x, y, z]}. A copy inside a sub-assembly is named "Sub <1> / Part <1>".`;

function oneFaceOrEdge(placed: ReturnType<typeof placedFacesAndEdges>, original: PartMesh, o: Obj, key: "face" | "face2" | "edge", where: string): TopoPick {
  const sel = o[key];
  const picks = key === "edge" ? pickEdges(placed, [sel], `${where}.${key}`) : pickFaces(placed, [sel], `${where}.${key}`);
  if (picks.length !== 1) throw new InputError(`${where}.${key}: choose exactly one ${key === "edge" ? "edge" : "face"} (got ${picks.length}).`);
  const pick = picks[0];
  if (key === "edge" && pick.ref.kind !== "edge") throw new InputError(`${where}.edge: "${JSON.stringify(sel)}" is a face; give one edge, e.g. "E5" (list_edges shows them).`);
  // The part's own face or edge (the same number), as the app stores a click.
  const i = pick.ref.kind === "face" ? placed.faceRefs.indexOf(pick.ref) : placed.edgeRefs.indexOf(pick.ref as EdgeRef);
  const ref = pick.ref.kind === "face" ? original.faceRefs[i] : original.edgeRefs[i];
  return { partId: original.id, ref };
}

/** A described end of a mate, as a connector. */
function connector(s: Session, asm: Assembly, raw: unknown, where: string, width: boolean, solved: SolveResult): { c: MateConnector; label: string } {
  const o = object(raw, where);
  if (o.origin !== undefined) {
    noExtras(o, ["origin"], where);
    const plane = oneOf(o.origin, ORIGIN_PLANES, `${where}.origin`) as OriginPlane;
    return { c: originConnector(plane), label: `the assembly's ${plane} plane` };
  }
  noExtras(o, ["instance", "face", "face2", "edge", "at"], where);
  if (o.instance === undefined) throw new InputError(`${where}: give "instance" (a copy's name, e.g. "Bracket <1>") and a "face" or "edge" — or {"origin": "Top"}. ${CONNECTOR_HELP}`);
  const t = findTarget(s, asm, o.instance, `${where}.instance`, solved);
  const placed = placedFacesAndEdges(t);
  if ((o.face === undefined) === (o.edge === undefined)) throw new InputError(`${where}: give either "face" or "edge" (one of them).`);
  if (o.face2 !== undefined && !width) throw new InputError(`${where}.face2 is only for Width mates (the second side).`);
  if (width && (o.face === undefined || o.face2 === undefined)) throw new InputError(`${where}: a Width mate needs "face" and "face2" — the two sides (of the slot on the first end, of the tab on the second).`);
  const pick = oneFaceOrEdge(placed, t.mesh, o, o.edge !== undefined ? "edge" : "face", where);
  const pick2 = width ? oneFaceOrEdge(placed, t.mesh, o, "face2", where) : undefined;
  if (pick2 && pick2.ref === pick.ref) throw new InputError(`${where}: "face" and "face2" are the same face; give the two different sides.`);
  let spot: ConnectorSpot | undefined;
  if (o.at !== undefined) {
    if (o.edge === undefined) throw new InputError(`${where}.at only goes with an edge.`);
    spot = oneOf(o.at, ["start", "end", "middle"] as const, `${where}.at`);
  }
  const c: MateConnector = {
    instanceId: t.leaf.top,
    ...(t.leaf.path.length ? { path: t.leaf.path } : {}),
    pick,
    ...(pick2 ? { pick2 } : {}),
    ...(spot ? { spot } : {}),
  };
  const what = o.edge !== undefined ? `edge ${typeof o.edge === "string" ? o.edge : "near the point given"}` : `face ${typeof o.face === "string" ? o.face : "near the point given"}${pick2 ? ` and ${typeof o.face2 === "string" ? o.face2 : "the face near the point given"}` : ""}`;
  return { c, label: `${t.leaf.name} (${what})` };
}

function placementText(p: Placement): string {
  const turn = eulerDegFromQuat(p.rotation);
  return `at (${p.position.map(r2).join(", ")})${turn.some((v) => Math.abs(v) > 1e-6) ? `, turned ${turn.map(r2).join("°, ")}° about X, Y, Z` : ""}`;
}

function mateText(asm: Assembly, m: Mate, solved: SolveResult, assemblies: readonly Assembly[]): string {
  const end = (c: MateConnector) => {
    if (isOrigin(c)) return "the origin";
    const top = asm.instances.find((i) => i.id === c.instanceId);
    return top ? (c.path?.length ? `${top.name} / …` : top.name) : "(missing)";
  };
  const values = MATE_TYPES[m.type].values.map((v) => `${v.key} ${m.values[v.key] ?? "0"}${v.unit === "°" ? "°" : ""}`).join(", ");
  const off = mateInactive(asm, m, assemblies);
  const err = solved.mateErrors[m.id];
  return `- ${m.name} [${MATE_TYPES[m.type].label}] between ${end(m.a)} and ${end(m.b)}${m.flip ? ", flipped" : ""}; ${values}${off ? ` — ${off}` : err ? ` — PROBLEM: ${err}` : ""}`;
}

// ---------------------------------------------------------------------------
// Reports and pictures

function instancesText(asm: Assembly, solved: SolveResult): string[] {
  return asm.instances.map((i) => {
    const by = solved.drivenBy[i.id] ? asm.mates?.find((m) => m.id === solved.drivenBy[i.id])?.name : null;
    const kind = i.subAssembly ? " (sub-assembly)" : "";
    const state = i.suppressed ? "suppressed (switched off)" : i.fixed ? "fixed" : by ? `placed by ${by}` : "free (not fixed or mated)";
    return `- ${i.name}${kind}: ${state}, ${placementText(solved.placements[i.id] ?? i.placement)}`;
  });
}

function partsListText(s: Session, asm: Assembly, structured: boolean): string {
  const parts = builtParts(s);
  const names = Object.fromEntries(parts.map((p) => [p.id, p.name]));
  const configs = Object.fromEntries((s.doc.configurations ?? []).map((c) => [c.id, c.name]));
  const rows = billOfMaterials(asm, names, configs, undefined, s.doc.partProperties, { assemblies: assembliesOf(s.doc), structured });
  if (!rows.length) return "Parts list: empty.";
  return `Parts list${structured ? " (structured)" : ""}:\n${rows
    .map((r, i) => `${"  ".repeat(r.level ?? 0)}${r.item ?? i + 1}. ${r.name} × ${r.quantity}${r.missing ? " (MISSING: its part no longer exists)" : ""}${r.properties?.number ? ` [${r.properties.number}]` : ""}`)
    .join("\n")}`;
}

/** The assembly's parts in their places (spread out if its exploded view is on), for pictures. */
export function assemblyInstances(s: Session, asm: Assembly, solved = solve(s, asm)): InstanceInput[] {
  const parts = builtParts(s);
  const assemblies = assembliesOf(s.doc);
  const tops = Object.fromEntries(asm.instances.map((i) => [i.id, solved.placements[i.id] ?? i.placement]));
  const shown = asm.explode !== undefined || asm.explodeSteps?.length ? explodeAssembly(asm, parts, tops, asm.explode ?? 0, assemblies) : tops;
  return instancesForKernel(asm, parts, assemblies, solved, shown);
}

const COLOURS: [number, number, number][] = [[176, 196, 222], [222, 190, 150], [170, 210, 170], [215, 170, 200], [230, 220, 140], [160, 200, 215]];
const COLOUR_NAMES = ["blue", "tan", "green", "pink", "yellow", "teal"];

/** A picture of an assembly from some views (for get_views). */
export function assemblyViews(s: Session, asmRef: unknown, views: RenderView[], size: number): ToolResult {
  const asm = findAssembly(s, asmRef);
  const instances = assemblyInstances(s, asm);
  if (!instances.length) throw new InputError(`${asm.name} has nothing in it to look at yet. Insert parts with insert_into_assembly.`);
  const parts = builtParts(s);
  const render: RenderPart[] = [];
  const named: string[] = [];
  instances.forEach((inst, k) => {
    const mesh = findMesh(parts, inst.partId);
    if (!mesh) return;
    const place = (arr: ArrayLike<number>) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i + 2 < arr.length; i += 3) {
        const v: Vec3 = [arr[i], arr[i + 1], arr[i + 2]];
        const p = applyPlacement({ position: inst.position, rotation: inst.rotation }, inst.mirrored ? flipX(v) : v);
        out[i] = p[0];
        out[i + 1] = p[1];
        out[i + 2] = p[2];
      }
      return out;
    };
    render.push({ vertices: place(mesh.vertices), triangles: mesh.triangles, lines: place(mesh.lines), colour: COLOURS[k % COLOURS.length] });
    named.push(`${inst.name} ${COLOUR_NAMES[k % COLOURS.length]}`);
  });
  const img = renderViews(render, views, size);
  const exploded = asm.explode !== undefined || !!asm.explodeSteps?.length;
  return {
    content: [
      { type: "image", data: Buffer.from(img.png).toString("base64"), mimeType: "image/png" },
      { type: "text", text: `${asm.name}${exploded ? " (exploded view)" : ""}. Views: ${img.layout}. Colours: ${named.join(", ")}. describe_assembly gives exact positions.` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Changes

/**
 * Make an assembly change: refused (nothing changed) if it makes a mate that
 * worked stop working; otherwise the parts are left where the mates put them
 * (as the app does) and it's committed.
 */
async function tryAssemblyChange(s: Session, asmId: string, next: JuraCADDocument, verb: string, hold: string[] = []): Promise<{ asm: Assembly; solved: SolveResult }> {
  const before = assembliesOf(s.doc).find((a) => a.id === asmId);
  const beforeErrors = before ? solve(s, before).mateErrors : {};
  await s.checkpoint();
  const asm = assembliesOf(next).find((a) => a.id === asmId)!;
  const solved = solveWithParts(asm, builtParts(s), { assemblies: assembliesOf(next), hold });
  const fresh = (asm.mates ?? []).filter((m) => solved.mateErrors[m.id] && solved.mateErrors[m.id] !== beforeErrors[m.id] && !mateInactive(asm, m, assembliesOf(next)));
  if (fresh.length) {
    throw new InputError(
      `Couldn't ${verb} — ${fresh.map((m) => `${m.name}: ${solved.mateErrors[m.id]}`).join("; ")}\nNothing was changed. Check the faces or edges chosen (list_faces / list_edges with "assembly" and "instance"), try "flip": true, or un-fix a copy (place_instance "fixed": false) so the mate can move it.`,
    );
  }
  s.throwIfCancelled();
  const settled = settleSolved(next, asmId, solved);
  s.commit(settled);
  const out = assembliesOf(settled).find((a) => a.id === asmId)!;
  return { asm: out, solved: solveWithParts(out, builtParts(s), { assemblies: assembliesOf(settled) }) };
}

function rotationOf(v: unknown, where: string, s: Session): [number, number, number] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 3) throw new InputError(`${where} should be three angles [about X, about Y, about Z] in degrees, e.g. [0, 0, 90].`);
  return v.map((x, k) => amount(x, `${where}[${k}]`, s.scope(), { unit: "°" }).value) as [number, number, number];
}

const INSTANCE_REF = { type: "string", description: 'A copy\'s name, e.g. "Bracket <1>" (describe_assembly lists them).' };
const ASSEMBLY_REF = { type: "string", description: 'The assembly\'s name, e.g. "Assembly 1" (optional when there is only one).' };

export const ASSEMBLY_TOOLS: ToolDef[] = [
  {
    name: "create_assembly",
    title: "Make an assembly",
    description:
      "Make a new assembly (a tab where copies of parts are put together and joined with mates, as in Onshape). Then insert_into_assembly, add_mate, describe_assembly, check_assembly. Parts come from every Part Studio of the design.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: 'e.g. "Hinge". Default "Assembly 1", "Assembly 2"…' } } },
    run: (s, a) => {
      noExtras(a, ["name"], "create_assembly");
      const id = newId("a");
      let next = addAssembly(s.doc, id);
      if (a.name !== undefined) {
        const name = text(a.name, "name").slice(0, 80);
        if (assembliesOf(s.doc).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already an assembly called "${name}". Choose another name.`);
        next = renameAssembly(next, id, name);
      }
      s.commit(next);
      const asm = assembliesOf(s.doc).find((x) => x.id === id)!;
      const parts = insertableParts(s);
      return say(
        `Made ${asm.name}. It's empty.`,
        parts.length ? `Parts you can insert: ${parts.map((p) => `"${p.name}"`).join(", ")}.` : "There are no parts yet: build one in the Part Studio first (add_sketch, add_feature).",
        "Next: insert_into_assembly. The first copy is fixed where it is; join the others to it with add_mate.",
      );
    },
  },
  {
    name: "insert_into_assembly",
    title: "Put parts into an assembly",
    description:
      'Insert copies of a part ("part": its name, from any Part Studio) or of another assembly as one piece ("sub_assembly": its name) into an assembly. "count" copies (default 1). Each goes just beside what\'s already there unless "at" [x, y, z] (mm) and "rotate" [about X, about Y, about Z] (degrees) are given. The very first copy in an assembly is fixed where it is (as in Onshape); "fixed" sets it. Copies are named "Bracket <1>", "Bracket <2>"…',
    inputSchema: {
      type: "object",
      properties: {
        assembly: ASSEMBLY_REF,
        part: { type: "string" },
        sub_assembly: { type: "string" },
        count: { type: "number", description: "1–20, default 1." },
        at: { type: "array", items: {}, description: "[x, y, z] in mm (count must be 1)." },
        rotate: { type: "array", items: {}, description: "[about X, about Y, about Z] in degrees." },
        fixed: { type: "boolean" },
      },
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "part", "sub_assembly", "count", "at", "rotate", "fixed"], "insert_into_assembly");
      const asm0 = findAssembly(s, a.assembly);
      if ((a.part === undefined) === (a.sub_assembly === undefined)) throw new InputError('Give either "part" (a part\'s name) or "sub_assembly" (another assembly\'s name).');
      const count = a.count === undefined ? 1 : amount(a.count, "count", s.scope(), { integer: true, min: 1, unit: "" }).value;
      if (count > 20) throw new InputError("count can be at most 20. Insert more in another call, or use a pattern in the app.");
      if (a.at !== undefined && count > 1) throw new InputError('"at" puts one copy in one place: with "count" over 1, leave "at" out (they go side by side) or insert them one at a time.');
      const at = a.at === undefined ? null : xyz(a.at, "at", s.scope()).map((v) => v.value) as Vec3;
      const turn = rotationOf(a.rotate, "rotate", s);
      const fixed = a.fixed === undefined ? undefined : bool(a.fixed, "fixed");
      let doc = s.doc;
      const ids: string[] = [];
      let what: string;
      await s.checkpoint();
      const parts = builtParts(s);
      for (let k = 0; k < count; k++) {
        const asm = assembliesOf(doc).find((x) => x.id === asm0.id)!;
        const solved = solveWithParts(asm, parts, { assemblies: assembliesOf(doc) });
        const rotation = turn ? quatFromEulerDeg(...turn) : IDENTITY.rotation;
        let own: Box3 | null;
        const id = newId("i");
        if (a.part !== undefined) {
          const part = s.part(insertableParts(s), a.part, "part");
          what = part.name;
          own = partBox(part);
          const spot = at ? { position: at, rotation } : own ? spotBeside(boxesInWith(s, asm, solved, doc), placedBox(own, { position: [0, 0, 0], rotation })) : IDENTITY;
          doc = insertInstance(doc, asm.id, { id: part.id, name: part.name }, { position: spot.position, rotation }, id);
        } else {
          const sub = byName(assembliesOf(doc), a.sub_assembly, "sub_assembly", "assembly", MAKE_ONE);
          const problem = insertProblem(doc, asm.id, sub.id);
          if (problem) throw new InputError(`${problem} Nothing was changed.`);
          what = sub.name;
          const probe = insertSubAssembly(doc, asm.id, sub.id, IDENTITY, id);
          const probeAsm = assembliesOf(probe).find((x) => x.id === asm.id)!;
          own = ownBox(probeAsm, probeAsm.instances.find((i) => i.id === id)!, parts, assembliesOf(probe), partBox);
          const spot = at ? { position: at, rotation } : own ? spotBeside(boxesInWith(s, asm, solved, doc), placedBox(own, { position: [0, 0, 0], rotation })) : IDENTITY;
          doc = insertSubAssembly(doc, asm.id, sub.id, { position: spot.position, rotation }, id);
        }
        if (fixed !== undefined) doc = updateInstance(doc, asm.id, id, { fixed });
        ids.push(id);
      }
      const { asm, solved } = await tryAssemblyChange(s, asm0.id, doc, "insert that");
      const added = asm.instances.filter((i) => ids.includes(i.id));
      return say(
        `Inserted ${added.length} cop${added.length === 1 ? "y" : "ies"} of ${what!} into ${asm.name}:`,
        ...added.map((i) => `- ${i.name}: ${i.fixed ? "fixed, " : ""}${placementText(solved.placements[i.id] ?? i.placement)}`),
        `${asm.name} now has ${asm.instances.length} cop${asm.instances.length === 1 ? "y" : "ies"}.`,
        asm.instances.length > 1 ? "Join them with add_mate (the faces are as the copies sit now: list_faces with \"assembly\" and \"instance\")." : null,
      );
    },
  },
  {
    name: "place_instance",
    title: "Move, fix or switch off a copy",
    description:
      'Change a copy in an assembly: "at" [x, y, z] (mm) and "rotate" [about X, about Y, about Z] (degrees) set where it sits (a copy placed by a mate goes where the mate puts it, whatever this says), "fixed": true holds it where it is (mates then move the other part), "suppressed": true switches it off (left out of the parts list, exports and checks), "name" renames it.',
    inputSchema: {
      type: "object",
      properties: { assembly: ASSEMBLY_REF, instance: INSTANCE_REF, at: { type: "array", items: {} }, rotate: { type: "array", items: {} }, fixed: { type: "boolean" }, suppressed: { type: "boolean" }, name: { type: "string" } },
      required: ["instance"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "instance", "at", "rotate", "fixed", "suppressed", "name"], "place_instance");
      const asm = findAssembly(s, a.assembly);
      const inst = byName(asm.instances, a.instance, "instance", "copy", "insert parts with insert_into_assembly.");
      const solved = solve(s, asm);
      const now = solved.placements[inst.id] ?? inst.placement;
      const at = a.at === undefined ? null : (xyz(a.at, "at", s.scope()).map((v) => v.value) as Vec3);
      const turn = rotationOf(a.rotate, "rotate", s);
      const patch: Partial<Pick<Instance, "name" | "placement" | "fixed" | "suppressed">> = {};
      if (at || turn) patch.placement = { position: at ?? now.position, rotation: turn ? quatFromEulerDeg(...turn) : now.rotation };
      if (a.fixed !== undefined) patch.fixed = bool(a.fixed, "fixed");
      if (a.suppressed !== undefined) patch.suppressed = bool(a.suppressed, "suppressed");
      if (a.name !== undefined) {
        const name = text(a.name, "name").slice(0, 80);
        if (asm.instances.some((i) => i.id !== inst.id && i.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a copy called "${name}" in ${asm.name}. Choose another name.`);
        patch.name = name;
      }
      if (!Object.keys(patch).length) throw new InputError('Say what to change: "at", "rotate", "fixed", "suppressed" or "name".');
      // Fixing a copy keeps it where the mates have put it.
      if (patch.fixed && !patch.placement) patch.placement = now;
      const r = await tryAssemblyChange(s, asm.id, updateInstance(s.doc, asm.id, inst.id, patch), `change ${inst.name}`);
      const after = r.asm.instances.find((i) => i.id === inst.id)!;
      const by = r.solved.drivenBy[inst.id] ? r.asm.mates?.find((m) => m.id === r.solved.drivenBy[inst.id])?.name : null;
      return say(
        `${after.name}: ${after.suppressed ? "suppressed (switched off)" : after.fixed ? "fixed" : by ? `placed by ${by}` : "free"}, ${placementText(r.solved.placements[after.id] ?? after.placement)}.`,
        patch.placement && by && !after.fixed ? `Note: ${by} decides where it sits, so the position given only matters if that mate is removed.` : null,
      );
    },
  },
  {
    name: "remove_from_assembly",
    title: "Take copies out of an assembly",
    description: "Remove copies from an assembly (by name), with the mates on them.",
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, instances: { type: "array", items: { type: "string" } } }, required: ["instances"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "instances"], "remove_from_assembly");
      const asm = findAssembly(s, a.assembly);
      const gone = list(a.instances, "instances").map((r, i) => byName(asm.instances, r, `instances[${i}]`, "copy", "insert parts with insert_into_assembly."));
      // Others stay where the mates had put them.
      const settled = settleSolved(s.doc, asm.id, solve(s, asm));
      const r = await tryAssemblyChange(s, asm.id, removeInstances(settled, asm.id, gone.map((i) => i.id)), "remove them");
      return say(`Removed ${gone.map((i) => i.name).join(", ")} from ${r.asm.name}; it has ${r.asm.instances.length} cop${r.asm.instances.length === 1 ? "y" : "ies"} left.`);
    },
  },
  {
    name: "add_mate",
    title: "Join two parts with a mate",
    description:
      `Join two copies in an assembly with a mate, as in Onshape: "first" (stays put) and "second" (moves to meet it). Each mate lines up a connector on each: on a flat face its centre with Z out of the face; on a round edge or face its centre and axis. Without "flip" the two Z directions point at each other (face to face, e.g. a lid's bottom on a box's top); "flip": true points them the same way. "values" set the amounts, e.g. {"gap": 2} or {"angle": 90} (mm and degrees, or maths as text). Types:\n${MATE_HELP.join("\n")}\n${CONNECTOR_HELP}\nIf the mate can't be satisfied, nothing is changed and the reason is given.`,
    inputSchema: {
      type: "object",
      properties: {
        assembly: ASSEMBLY_REF,
        type: { type: "string", enum: ["fasten", "hinge", "revolute", "slider", "cylindrical", "planar", "pin_slot", "parallel", "width", "tangent", "ball"] },
        first: { type: "object", description: '{"instance": "Base <1>", "face": "top"} or {"instance", "edge": "E5"} or {"origin": "Top"}' },
        second: { type: "object", description: '{"instance": "Lid <1>", "face": "bottom"}' },
        flip: { type: "boolean" },
        values: { type: "object" },
        name: { type: "string" },
      },
      required: ["type", "first", "second"],
    },
    run: async (s, a) => {
      noExtras(a, ["assembly", "type", "first", "second", "flip", "values", "name"], "add_mate");
      const asm = findAssembly(s, a.assembly);
      const word = typeof a.type === "string" ? a.type.trim().toLowerCase() : "";
      const type = MATE_WORDS[word];
      if (!type) throw new InputError(`type must be one of ${Object.keys(MATE_WORDS).filter((k) => !k.includes(" ") && k !== "pinslot" && k !== "fastened").map((k) => `"${k}"`).join(", ")} (got ${JSON.stringify(a.type)}).`);
      const solved = solve(s, asm);
      const first = connector(s, asm, a.first, "first", type === "width", solved);
      const second = connector(s, asm, a.second, "second", type === "width", solved);
      if (isOrigin(second.c) && !isOrigin(first.c)) throw new InputError('The origin never moves, so put it as "first" (the end that stays put).');
      if (isOrigin(first.c) && isOrigin(second.c)) throw new InputError("A mate needs at least one copy: both ends are the origin.");
      if (first.c.instanceId === second.c.instanceId && !isOrigin(first.c)) {
        throw new InputError(`Both ends are on ${asm.instances.find((i) => i.id === first.c.instanceId)?.name}${first.c.path || second.c.path ? " (a sub-assembly moves as one piece)" : ""}. A mate joins two different copies.`);
      }
      const defs = MATE_TYPES[type].values;
      const values: Record<string, string> = Object.fromEntries(defs.map((d) => [d.key, "0"]));
      if (a.values !== undefined) {
        const given = object(a.values, "values");
        noExtras(given, defs.map((d) => d.key), `values (for a ${MATE_TYPES[type].label} mate)`);
        for (const d of defs) {
          if (given[d.key] === undefined) continue;
          values[d.key] = amount(given[d.key], `values.${d.key}`, s.scope(), { unit: d.unit === "°" ? "°" : "mm" }).text;
        }
      }
      const name = a.name === undefined ? nextMateName(asm, type) : text(a.name, "name").slice(0, 80);
      const mate: Mate = { id: newId("m"), name, type, a: first.c, b: second.c, flip: bool(a.flip, "flip"), values };
      const r = await tryAssemblyChange(s, asm.id, putMate(s.doc, asm.id, mate), `add the ${MATE_TYPES[type].label} mate`, [mate.id]);
      const moved = r.asm.instances.filter((i) => r.solved.drivenBy[i.id] === mate.id);
      const fixedBoth = [first.c, second.c].every((c) => isOrigin(c) || r.asm.instances.find((i) => i.id === c.instanceId)?.fixed);
      return say(
        `Added ${mate.name} (${MATE_TYPES[type].label}) between ${first.label} and ${second.label}.`,
        moved.length ? `It places ${moved.map((i) => `${i.name} ${placementText(r.solved.placements[i.id] ?? i.placement)}`).join("; ")}.` : null,
        fixedBoth ? "Note: both ends are fixed, so nothing moved. Un-fix the second copy (place_instance \"fixed\": false) to let the mate place it." : null,
        MATE_TYPES[type].values.some((v) => v.free) ? `It can still move: ${MATE_TYPES[type].values.filter((v) => v.free).map((v) => v.label.toLowerCase()).join(", ")}.` : "It's held solid.",
        "Look at it with get_views {\"assembly\": …}.",
      );
    },
  },
  {
    name: "delete_mate",
    title: "Remove a mate",
    description: "Remove a mate from an assembly (by name). The parts stay where it had put them.",
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, mate: { type: "string" } }, required: ["mate"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "mate"], "delete_mate");
      const asm = findAssembly(s, a.assembly);
      const mate = byName(asm.mates ?? [], a.mate, "mate", "mate", "add one with add_mate.");
      const settled = settleSolved(s.doc, asm.id, solve(s, asm));
      await tryAssemblyChange(s, asm.id, removeMate(settled, asm.id, mate.id), `remove ${mate.name}`);
      return say(`Removed ${mate.name}. The parts it held stay where they were, and are free to move.`);
    },
  },
  {
    name: "describe_assembly",
    title: "Describe an assembly",
    description:
      'An assembly as it is now: each copy (fixed, or which mate places it, and where it sits), each mate (type, ends, amounts, problems), the exploded view, and the parts list (each part once with how many; "structured": true lists sub-assemblies with their parts under them). With no assembly given and several in the design, lists them.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, structured: { type: "boolean" } } },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, ["assembly", "structured"], "describe_assembly");
      const all = assembliesOf(s.doc);
      if (a.assembly === undefined && all.length !== 1) {
        if (!all.length) return say(`The design has no assemblies yet: ${MAKE_ONE}`);
        return say(`The design has ${all.length} assemblies: ${all.map((x) => `"${x.name}" (${x.instances.length} copies, ${(x.mates ?? []).length} mates)`).join(", ")}. Say which one with "assembly".`);
      }
      const asm = findAssembly(s, a.assembly);
      const solved = solve(s, asm);
      const assemblies = assembliesOf(s.doc);
      const leaves = leavesOf(asm, builtParts(s), assemblies);
      const inner = leaves.filter((l) => l.path.length);
      return say(
        `${asm.name}: ${asm.instances.length} cop${asm.instances.length === 1 ? "y" : "ies"}, ${(asm.mates ?? []).length} mate(s).`,
        asm.instances.length ? `Copies:\n${instancesText(asm, solved).join("\n")}` : "No copies yet: insert parts with insert_into_assembly.",
        inner.length ? `Parts inside sub-assemblies (name them like this in add_mate): ${leafNames(inner)}.` : null,
        (asm.mates ?? []).length ? `Mates:\n${(asm.mates ?? []).map((m) => mateText(asm, m, solved, assemblies)).join("\n")}` : "No mates yet.",
        asm.explode !== undefined ? `Exploded view: on (spread ${asm.explode}).` : null,
        partsListText(s, asm, bool(a.structured, "structured")),
      );
    },
  },
  {
    name: "check_assembly",
    title: "Check an assembly for clashes",
    description:
      'Check an assembly with the real shapes: parts that overlap (clash), mates that don\'t work, and copies whose part is missing. "tolerance" (mm, default 0.01): overlaps and gaps up to this count as touching. "list_touching": true also lists parts that only touch.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, tolerance: { type: "number" }, list_touching: { type: "boolean" } } },
    readOnly: true,
    run: async (s, a) => {
      noExtras(a, ["assembly", "tolerance", "list_touching"], "check_assembly");
      const asm = findAssembly(s, a.assembly);
      const tolerance = a.tolerance === undefined ? DEFAULT_CLASH_OPTIONS.tolerance : amount(a.tolerance, "tolerance", s.scope(), { min: 0 }).value;
      if (tolerance > 10) throw new InputError("tolerance can be at most 10 mm.");
      const options: ClashOptions = { ...DEFAULT_CLASH_OPTIONS, tolerance, ignoreTouching: !bool(a.list_touching, "list_touching") };
      await s.checkpoint();
      const solved = solve(s, asm);
      const assemblies = assembliesOf(s.doc);
      const instances = instancesForKernel(asm, builtParts(s), assemblies, solved);
      await s.checkpoint();
      const measured = instances.length > 1 ? s.withWholeEngine((e) => e.clashes(instances, options.tolerance, !options.ignoreTouching)) : [];
      const names = Object.fromEntries(builtParts(s).map((p) => [p.id, p.name]));
      const report = assemblyReport(asm, solved, names, judgeContacts(measured, options), options, { suppressed: asm.instances.filter((i) => i.suppressed).length }, assemblies);
      return say(
        `${asm.name}: ${report.headline}`,
        ...report.parts.map((p) => `${p.name}:\n${p.findings.map((f) => `- ${f.level === "error" ? "PROBLEM: " : f.level === "warn" ? "CLASH: " : ""}${f.text}`).join("\n")}`),
      );
    },
  },
  {
    name: "explode_assembly",
    title: "Explode an assembly",
    description:
      'Show an assembly spread apart (an exploded view) so you can see how it goes together: "spread" 0.2–10 (1 = each part moves out from the middle by its own distance from it again), or "spread": 0 to put it back together. Only the picture changes (get_views with "assembly", and drawings of it with "exploded"); mates, exports and clash checks keep the real places.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, spread: { type: "number" } }, required: ["spread"] },
    run: (s, a) => {
      noExtras(a, ["assembly", "spread"], "explode_assembly");
      const asm = findAssembly(s, a.assembly);
      const spread = amount(a.spread, "spread", s.scope(), { min: 0, unit: "" }).value;
      if (spread > 10) throw new InputError("spread can be at most 10.");
      const next = setExplode(s.doc, asm.id, spread === 0 ? null : spread);
      if (next === s.doc || JSON.stringify(assembliesOf(next)) === JSON.stringify(assembliesOf(s.doc))) return say(spread === 0 ? `${asm.name} is already together.` : `${asm.name} is already spread ${spread}.`);
      s.commit(next);
      return say(spread === 0 ? `${asm.name} is back together.` : `${asm.name} is now shown spread apart (${spread}). Look at it with get_views {"assembly": "${asm.name}"}.`);
    },
  },
];

/** The boxes round what's in an assembly now (copies already added in this call count too), so a new copy goes beside them. */
function boxesInWith(s: Session, asm: Assembly, solved: SolveResult, doc: JuraCADDocument): Box3[] {
  const parts = builtParts(s);
  const out: Box3[] = [];
  for (const i of asm.instances) {
    if (i.suppressed) continue;
    const b = ownBox(asm, i, parts, assembliesOf(doc), partBox);
    if (b) out.push(placedBox(b, solved.placements[i.id] ?? i.placement));
  }
  return out;
}

/** Export an assembly's parts in their places (export_model with "assembly"). */
export async function exportAssemblyBytes(s: Session, asm: Assembly, format: "stl" | "3mf" | "step"): Promise<{ bytes: Uint8Array; count: number }> {
  const solved = solve(s, asm);
  const instances = instancesForKernel(asm, builtParts(s), assembliesOf(s.doc), solved);
  if (!instances.length) throw new InputError(`${asm.name} has nothing in it to export yet. Insert parts with insert_into_assembly.`);
  await s.checkpoint();
  const bytes = await s.withWholeEngine(async (e) => {
    if (format === "stl") return new Uint8Array(e.exportStl([], "normal", instances).stl);
    if (format === "3mf") return new Uint8Array(e.export3mf([], "normal", `${s.doc.name} ${asm.name}`, s.doc.appearance ?? {}, instances).data);
    return new Uint8Array((await e.exportStep([], s.doc.appearance ?? {}, instances)).step);
  });
  return { bytes, count: instances.length };
}
