/**
 * Keeping drilled copies where they really are (assembly features).
 *
 * The mate solver's cut copies are cut with each part WHERE THE DOCUMENT HAS IT
 * (`storedCutInputs` in placed.ts), while the copies shown are cut where the
 * solve puts them. The two agree as long as a drilled part sits where it's
 * stored. A Part Studio change can move it without anyone touching the
 * assembly — the base it's fastened to made wider slides it along — and then
 * a pin mated into its hole would follow the hole of the solver's copy, off
 * the hole that's shown.
 *
 * So each copy an assembly's own features change is stored where the solve now
 * puts it — as settleSolved does after a mate is made — and the solver's copies
 * are then cut there. Nothing else is touched (parts not cut keep their stored
 * places). The app does it once for each new set of built parts (after a
 * rebuild, when the solver's cut copies for them have arrived); the extension
 * solves with the settled assemblies each time, which is cached per assemblies
 * and parts. A settled state settles to itself, so it never repeats itself.
 * Sub-assemblies are settled before the assemblies using them.
 *
 * Pure: no store, no engine.
 */
import { solveWithParts, type CutMeshes } from "./mates";
import type { Placement } from "./math";
import { cutsFor } from "./assemblyFeatures";
import type { Assembly, JuraCADDocument } from "../model/types";
import type { PartMesh } from "../kernel/protocol";

/** Moved further than this (mm, or about 0.0001° of turn) counts as moved. */
const MOVED = 1e-6;

/** Whether `p` is somewhere else than `q` (moved or turned). */
function elsewhere(p: Placement, q: Placement): boolean {
  if (p.position.some((v, k) => Math.abs(v - q.position[k]) > MOVED)) return true;
  const same = p.rotation.every((v, k) => Math.abs(v - q.rotation[k]) < 1e-7) || p.rotation.every((v, k) => Math.abs(v + q.rotation[k]) < 1e-7);
  return !same;
}

/** The assemblies, each after every sub-assembly it holds (a circle, which files never keep, is broken anywhere). */
function childrenFirst(assemblies: readonly Assembly[]): Assembly[] {
  const out: Assembly[] = [];
  const seen = new Set<string>();
  const visit = (a: Assembly) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    for (const i of a.instances) {
      const sub = i.subAssembly ? assemblies.find((x) => x.id === i.subAssembly) : undefined;
      if (sub) visit(sub);
    }
    out.push(a);
  };
  assemblies.forEach(visit);
  return out;
}

/** Settled states, by assemblies and parts (a settled state maps to itself). */
const settled = new WeakMap<readonly Assembly[], WeakMap<readonly PartMesh[], readonly Assembly[]>>();

function keep(from: readonly Assembly[], parts: readonly PartMesh[], to: readonly Assembly[]): void {
  let byParts = settled.get(from);
  if (!byParts) settled.set(from, (byParts = new WeakMap()));
  byParts.set(parts, to);
}

/**
 * The assemblies with every copy their own features cut stored where the solve puts it now (see the file's note).
 * The same array when nothing moved, so callers can tell nothing changed. `cutMeshes` are the solver's cut copies
 * for `assemblies` (missing = those remembered for them, as every solve finds).
 */
export function settleCutCopies(assemblies: readonly Assembly[], parts: readonly PartMesh[], cutMeshes?: CutMeshes): readonly Assembly[] {
  const known = settled.get(assemblies)?.get(parts);
  if (known) return known;
  let list = assemblies;
  for (const a of childrenFirst(assemblies)) {
    if (!a.features?.length) continue;
    const drilled = a.instances.filter((i) => !i.fixed && !i.subAssembly && !i.suppressed && cutsFor(a, i.id));
    if (!drilled.length) continue;
    const solved = solveWithParts(a, parts as PartMesh[], { assemblies: list, ...(cutMeshes ? { cutMeshes } : {}) });
    const go = drilled.filter((i) => solved.placements[i.id] && elsewhere(solved.placements[i.id], i.placement));
    if (!go.length) continue;
    const ids = new Set(go.map((i) => i.id));
    const now = list.find((x) => x.id === a.id) ?? a;
    const next: Assembly = { ...now, instances: now.instances.map((i) => (ids.has(i.id) ? { ...i, placement: solved.placements[i.id] } : i)) };
    list = list.map((x) => (x.id === a.id ? next : x));
  }
  keep(assemblies, parts, list);
  if (list !== assemblies) keep(list, parts, list);
  return list;
}

/** `settleCutCopies` for a whole document: the same document when nothing moved. */
export function settleCutCopiesIn(doc: JuraCADDocument, parts: readonly PartMesh[], cutMeshes?: CutMeshes): JuraCADDocument {
  const list = doc.assemblies;
  if (!list?.some((a) => a.features?.length)) return doc;
  const next = settleCutCopies(list, parts, cutMeshes);
  return next === list ? doc : { ...doc, assemblies: next as Assembly[] };
}
