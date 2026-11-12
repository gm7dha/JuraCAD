/**
 * Edit in context (as in Onshape): a part's Part Studio opened from an
 * assembly, with the assembly's other parts shown round it — faint — to
 * sketch on, snap to and Use edges from, as they sit next to this part.
 *
 * A context is a snapshot (`EditContext`, kept in the document): which
 * copy is being edited, and where every other part sits relative to it.
 * "Update context" takes the snapshot again (parts moved by mates come
 * along, and sketches using their edges follow on the next rebuild). The
 * parts' shapes are always as built now (from their own Part Studios).
 *
 * In the Part Studio the context's parts are named `contextPartId(context,
 * key)` ("ctx:<context>:<key>"): a sketch's links and faces on them carry that
 * id, so the engine finds them in the context (StudioInput.contexts) as it
 * finds the studio's own parts.
 *
 * What's left out: parts from the same Part Studio as the part being edited
 * (they're built there already, and showing them again would make the studio
 * depend on itself), suppressed copies, and copies of missing parts.
 *
 * Pure: no store, no engine.
 */
import { newId } from "../model/document";
import type { Assembly, ContextPart, EditContext, JuraCADDocument } from "../model/types";
import type { PartMesh } from "../kernel/protocol";
import { compose, invert, type Placement } from "./math";
export { parseContexts } from "./featureParse";
import { findMesh, meshIdOf } from "./configured";
import { leavesOf, type Leaf } from "./subassembly";
import { solveWithParts } from "./mates";

/** The id a context's part has in the Part Studio it's shown in. */
export const contextPartId = (contextId: string, key: string): string => `ctx:${contextId}:${key}`;

/** True for the id of a context's part (never a Part Studio's own part). */
export const isContextPartId = (id: string): boolean => id.startsWith("ctx:");

/** The context and part key in a context part's id (null for any other id). */
export function contextPartOf(id: string): { context: string; key: string } | null {
  if (!isContextPartId(id)) return null;
  const rest = id.slice(4);
  const cut = rest.indexOf(":");
  return cut > 0 ? { context: rest.slice(0, cut), key: rest.slice(cut + 1) } : null;
}

const NO_CONTEXTS: EditContext[] = [];

/** The document's contexts (none for older files). */
export const contextsOf = (doc: Pick<JuraCADDocument, "contexts">): EditContext[] => doc.contexts ?? NO_CONTEXTS;

/** The contexts shown in (or used by) one Part Studio. */
export const contextsIn = (doc: Pick<JuraCADDocument, "contexts">, studioId: string): EditContext[] => contextsOf(doc).filter((c) => c.studioId === studioId);

/** The Part Studio a part is in (from the built parts), or null when it isn't built. */
const studioOfPart = (parts: readonly PartMesh[], meshId: string): string | null => findMesh(parts, meshId)?.studioId ?? null;

/**
 * The other parts of an assembly, placed relative to the copy with key `key`
 * (where they sit when that copy is put back at its own origin). Parts from the
 * part's own Part Studio are left out (see the top of this file).
 */
export function contextParts(assembly: Assembly, key: string, parts: readonly PartMesh[], assemblies: readonly Assembly[], places: Record<string, Placement>, leaves: readonly Leaf[] = leavesOf(assembly, parts, assemblies)): ContextPart[] | null {
  const own = leaves.find((l) => l.key === key);
  if (!own) return null;
  const at = (l: Leaf) => {
    const top = places[l.top] ?? assembly.instances.find((i) => i.id === l.top)?.placement;
    if (!top) return null;
    return l.path.length ? compose(top, l.relative) : top;
  };
  const here = at(own);
  if (!here) return null;
  const home = studioOfPart(parts, meshIdOf(own.instance));
  const back = invert(here);
  const out: ContextPart[] = [];
  for (const l of leaves) {
    if (l.key === key) continue;
    const mesh = findMesh(parts, meshIdOf(l.instance));
    const placed = at(l);
    if (!mesh || !placed) continue;
    const studio = mesh.studioId ?? "main";
    if (studio === (home ?? "main")) continue;
    // A copy shown in another configuration is that configuration's part (built as "<part>@<configuration>").
    out.push({
      key: l.key,
      partId: mesh.id,
      studioId: studio,
      name: l.name,
      placement: round(compose(back, placed)),
      ...(l.instance.mirrored ? { mirrored: true } : {}),
    });
  }
  return out;
}

/** A placement with its numbers rounded (so a snapshot taken again with nothing moved is the same). */
function round(p: Placement): Placement {
  const r = (v: number, k: number) => Math.round(v * k) / k || 0;
  return { position: p.position.map((v) => r(v, 1e6)) as Placement["position"], rotation: p.rotation.map((v) => r(v, 1e9)) as Placement["rotation"] };
}

/** Why a copy can't be edited in context, in plain words (null when it can). */
export function contextProblem(assembly: Assembly, key: string, parts: readonly PartMesh[], assemblies: readonly Assembly[]): string | null {
  const leaf = leavesOf(assembly, parts, assemblies).find((l) => l.key === key);
  if (!leaf) return "That part isn't in this assembly any more.";
  if (!findMesh(parts, meshIdOf(leaf.instance))) return "That part hasn't been built yet. Wait a moment, then try again.";
  if (leaf.instance.mirrored) return "A mirrored copy can't be edited in context: edit the copy it mirrors instead.";
  return null;
}

/**
 * Edit the copy with key `key` in context: its context (made, or taken again
 * if there is one already for this assembly and copy). `places` = the
 * assembly's solved places (the solve is run when not given).
 */
export function takeContext(
  doc: JuraCADDocument,
  assemblyId: string,
  key: string,
  parts: readonly PartMesh[],
  places?: Record<string, Placement>,
  id: string = newId("ctx"),
): { doc: JuraCADDocument; context: EditContext } | { error: string } {
  const all = doc.assemblies ?? [];
  const assembly = all.find((a) => a.id === assemblyId);
  if (!assembly) return { error: "That assembly no longer exists." };
  const problem = contextProblem(assembly, key, parts, all);
  if (problem) return { error: problem };
  const leaves = leavesOf(assembly, parts, all);
  const leaf = leaves.find((l) => l.key === key)!;
  const studioId = studioOfPart(parts, meshIdOf(leaf.instance)) ?? "main";
  const solved = places ?? solveWithParts(assembly, parts as PartMesh[], { assemblies: all }).placements;
  const others = contextParts(assembly, key, parts, all, solved, leaves) ?? [];
  const old = contextsOf(doc).find((c) => c.assemblyId === assemblyId && c.instance === key && c.studioId === studioId);
  const context: EditContext = {
    id: old?.id ?? id,
    name: `${assembly.name} (${leaf.name})`,
    studioId,
    assemblyId,
    instance: key,
    parts: others,
    ...(old?.hidden ? { hidden: true } : {}),
  };
  if (old && JSON.stringify(old) === JSON.stringify(context)) return { doc, context: old };
  const contexts = old ? contextsOf(doc).map((c) => (c.id === old.id ? context : c)) : [...contextsOf(doc), context];
  return { doc: { ...doc, contexts }, context };
}

/** "Update context": take the snapshot again (an error when its assembly or copy is gone). */
export function updateContext(doc: JuraCADDocument, contextId: string, parts: readonly PartMesh[], places?: Record<string, Placement>): { doc: JuraCADDocument; context: EditContext } | { error: string } {
  const c = contextsOf(doc).find((x) => x.id === contextId);
  if (!c) return { error: "That context no longer exists." };
  return takeContext(doc, c.assemblyId, c.instance, parts, places, c.id);
}

/** Show or hide a context's parts (hidden ones still work for sketches already using them). */
export function setContextHidden(doc: JuraCADDocument, contextId: string, hidden: boolean): JuraCADDocument {
  const contexts = contextsOf(doc).map((c) => {
    if (c.id !== contextId) return c;
    const { hidden: _h, ...rest } = c;
    return hidden ? { ...rest, hidden: true } : rest;
  });
  return { ...doc, contexts };
}

/** Remove a context (sketches using its parts then say those references are lost). */
export function removeContext(doc: JuraCADDocument, contextId: string): JuraCADDocument {
  const contexts = contextsOf(doc).filter((c) => c.id !== contextId);
  const { contexts: _c, ...rest } = doc;
  return contexts.length ? { ...rest, contexts } : rest;
}

/** Contexts of a Part Studio that's gone are forgotten. */
export function tidyContexts(doc: JuraCADDocument, studioIds: readonly string[]): JuraCADDocument {
  const list = contextsOf(doc);
  const kept = list.filter((c) => studioIds.includes(c.studioId));
  if (kept.length === list.length) return doc;
  const { contexts: _c, ...rest } = doc;
  return kept.length ? { ...rest, contexts: kept } : rest;
}

/** What the engine needs to build a Part Studio's contexts: each part's id there, the part it shows and where. */
export interface ContextInput {
  id: string;
  parts: { id: string; partId: string; studioId: string; placement: Placement; mirrored?: boolean }[];
}

/** The engine's view of one Part Studio's contexts (undefined when it has none, so older designs build exactly as before). */
export function contextInputs(doc: Pick<JuraCADDocument, "contexts">, studioId: string): ContextInput[] | undefined {
  const list = contextsIn(doc, studioId);
  if (!list.length) return undefined;
  return list.map((c) => ({
    id: c.id,
    parts: c.parts.map((p) => ({ id: contextPartId(c.id, p.key), partId: p.partId, studioId: p.studioId, placement: p.placement, ...(p.mirrored ? { mirrored: true } : {}) })),
  }));
}
