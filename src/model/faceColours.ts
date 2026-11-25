/**
 * Face colours (Onshape's Appearance on a face): a part's faces may each have a colour of their own, on top of the
 * part's colour (`doc.appearance`). Faces are renumbered by every rebuild, so each colour keeps what its face looked
 * like when it was coloured (a FaceRef, as feature picks do) and is found again on the part as it is now with the same
 * strict matching the engine uses for faces that sketches follow (`strictMatch`: near and unambiguous). A face that
 * can't be found is left out — the part just shows its own colour there — and counted, so the app can say so quietly.
 * Pure: the 3D view, the export and the Parts list all use these.
 */
import { parsePick, sameRef, strictMatch, type FaceRef } from "../geometry/topoRef";
import { DEFAULT_PART_COLOUR, normaliseColour } from "./colours";
import { spoolFor, spoolLabel } from "../terrain/bambuColours";
import type { JuraCADDocument } from "./types";

/** One coloured face of a part. */
export interface FaceColour {
  /** What the face looked like when it was coloured (found again on each rebuild). */
  face: FaceRef;
  /** "#rrggbb". */
  colour: string;
  /** Bambu Lab spool code (bambuColours.ts) when the colour was picked from Bambu's filaments. */
  spool?: string;
}

/** Part id → its coloured faces. */
export type FaceAppearance = Record<string, FaceColour[]>;

/** What a part's mesh must give to find its faces again: each face's description (same order as its faceGroups). */
export interface FacesOfPart {
  faceRefs: FaceRef[];
  vertices: ArrayLike<number>;
}

/** A part's size as the engine measures it (its box's diagonal), from its display mesh. */
export function sizeOfMesh(vertices: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], vertices[i + k]);
      hi[k] = Math.max(hi[k], vertices[i + k]);
    }
  return lo[0] === Infinity ? 0 : Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** Where each of a part's face colours is now: face index → colour (+ spool), and how many couldn't be found. */
export interface ResolvedFaces {
  colours: Map<number, { colour: string; spool?: string }>;
  lost: number;
}

const NOTHING: ResolvedFaces = { colours: new Map(), lost: 0 };

/**
 * Find a part's coloured faces on its faces as they are now (`faceRefs`, `size` the part's box diagonal). Later
 * entries win where two land on one face. A face not found (gone, or too like another to tell) is counted as lost.
 */
export function resolveFaceColours(list: readonly FaceColour[] | undefined, faceRefs: readonly FaceRef[], size: number): ResolvedFaces {
  if (!list?.length) return NOTHING;
  const colours = new Map<number, { colour: string; spool?: string }>();
  let lost = 0;
  for (const fc of list) {
    const i = strictMatch(fc.face, faceRefs as FaceRef[], size);
    if (i === null) lost++;
    else colours.set(i, { colour: fc.colour, ...(fc.spool ? { spool: fc.spool } : {}) });
  }
  return { colours, lost };
}

const resolvedCache = new WeakMap<FacesOfPart, WeakMap<readonly FaceColour[], ResolvedFaces>>();

/** resolveFaceColours for a part's mesh, cached per mesh and list (the 3D view asks on every change). */
export function facesColoured(list: readonly FaceColour[] | undefined, part: FacesOfPart): ResolvedFaces {
  if (!list?.length) return NOTHING;
  let byList = resolvedCache.get(part);
  if (!byList) resolvedCache.set(part, (byList = new WeakMap()));
  let r = byList.get(list);
  if (!r) byList.set(list, (r = resolveFaceColours(list, part.faceRefs, sizeOfMesh(part.vertices))));
  return r;
}

/**
 * The document with these faces of a part coloured (colour null = back to the part's own colour). `now` is the part's
 * faces as they are now (its mesh's faceRefs), so an earlier colour on the same face is replaced, not kept beside it.
 * Old documents without any face colours stay without the field.
 */
export function setFaceColoursIn(
  doc: JuraCADDocument,
  partId: string,
  faces: readonly number[],
  colour: string | null,
  now: FacesOfPart,
  spool?: string,
): JuraCADDocument {
  const chosen = new Set(faces.filter((i) => now.faceRefs[i] && now.faceRefs[i].surface !== "UNKNOWN"));
  if (!chosen.size) return doc;
  const size = sizeOfMesh(now.vertices);
  const before = doc.faceAppearance?.[partId] ?? [];
  // Keep the colours of other faces (and ones not found now: they may come back when an edit is undone).
  const kept = before.filter((fc) => {
    const i = strictMatch(fc.face, now.faceRefs, size);
    return i === null || !chosen.has(i);
  });
  const c = colour ? normaliseColour(colour) : null;
  const added: FaceColour[] = c ? [...chosen].sort((a, b) => a - b).map((i) => ({ face: now.faceRefs[i], colour: c, ...(spool ? { spool } : {}) })) : [];
  return withPartFaces(doc, partId, [...kept, ...added]);
}

/** The document with all of a part's face colours taken off. */
export function clearFaceColoursIn(doc: JuraCADDocument, partId: string): JuraCADDocument {
  return withPartFaces(doc, partId, []);
}

function withPartFaces(doc: JuraCADDocument, partId: string, list: FaceColour[]): JuraCADDocument {
  const all = { ...(doc.faceAppearance ?? {}) };
  if (list.length) all[partId] = list;
  else delete all[partId];
  const { faceAppearance: _old, ...rest } = doc;
  return Object.keys(all).length ? { ...rest, faceAppearance: all } : rest;
}

/** Face colours by part from untrusted JSON (anything odd is dropped). */
export function parseFaceAppearance(raw: unknown): FaceAppearance {
  const out: FaceAppearance = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const list: FaceColour[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      const colour = normaliseColour(d.colour);
      const pick = parsePick({ partId: id, ref: d.face });
      if (!colour || !pick || pick.ref.kind !== "face") continue;
      // The same face twice: the later one wins.
      const at = list.findIndex((x) => sameRef(x.face, pick.ref));
      if (at >= 0) list.splice(at, 1);
      list.push({ face: pick.ref, colour, ...(typeof d.spool === "string" && /^\d{3,8}$/.test(d.spool) ? { spool: d.spool } : {}) });
    }
    if (list.length) out[id] = list;
  }
  return out;
}

/** Spool codes by part from untrusted JSON. */
export function parsePartSpools(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && /^\d{3,8}$/.test(v)) out[id] = v;
  return out;
}

/** The document with a part's Bambu spool set (null = none: a colour of your own). */
export function setPartSpoolIn(doc: JuraCADDocument, partId: string, spool: string | null): JuraCADDocument {
  const all = { ...(doc.partSpools ?? {}) };
  if (spool) all[partId] = spool;
  else delete all[partId];
  if (all[partId] === doc.partSpools?.[partId] && (spool !== null || !doc.partSpools?.[partId])) return doc;
  const { partSpools: _old, ...rest } = doc;
  return Object.keys(all).length ? { ...rest, partSpools: all } : rest;
}

/** For an assembly's copies: each copy's mesh key gets its part's face colours. */
export function faceColoursByKey(all: FaceAppearance, keys: { key: string; partId: string }[]): FaceAppearance {
  const out: FaceAppearance = {};
  for (const k of keys) if (all[k.partId]) out[k.key] = all[k.partId];
  return out;
}

/** "1 face colour" / "3 face colours". */
export const faceColourWords = (n: number) => `${n} face colour${n === 1 ? "" : "s"}`;

/**
 * What the 3D view draws: for each mesh shown (a part, or an assembly's copy — `partOf` gives its part), face index →
 * colour. Meshes whose part has no face colours are left out.
 */
export function shownFaceColours(
  meshes: readonly (FacesOfPart & { id: string })[],
  all: FaceAppearance | undefined,
  partOf: (meshId: string) => string | undefined = (id) => id,
): Record<string, Record<number, string>> {
  const out: Record<string, Record<number, string>> = {};
  if (!all || !Object.keys(all).length) return out;
  for (const m of meshes) {
    const list = all[partOf(m.id) ?? ""];
    if (!list?.length) continue;
    const r = facesColoured(list, m);
    if (!r.colours.size) continue;
    const faces: Record<number, string> = {};
    for (const [i, c] of r.colours) faces[i] = c.colour;
    out[m.id] = faces;
  }
  return out;
}

/** How many filaments a multi-colour 3MF of these parts will use (each distinct colour: parts' own, then their faces'). */
export function filamentsFor(doc: Pick<JuraCADDocument, "appearance" | "faceAppearance">, partIds: readonly string[]): number {
  const colours = new Set<string>();
  for (const id of partIds) colours.add((doc.appearance?.[id] ?? DEFAULT_PART_COLOUR).toLowerCase());
  for (const id of partIds) for (const f of doc.faceAppearance?.[id] ?? []) colours.add(f.colour.toLowerCase());
  return colours.size;
}

/** "3 filaments, load them in this order: 1 Jade White (PLA Basic), 2 Red (PLA Basic), 3 your own colour #123456." */
export function filamentsNote(filaments: readonly { colour: string; spool?: string }[]): string {
  const named = filaments.map((f, i) => {
    const s = spoolFor(f.colour, f.spool);
    return `${i + 1} ${s ? spoolLabel(s) : f.colour.toLowerCase() === DEFAULT_PART_COLOUR ? "the usual grey (any filament you like)" : `your own colour ${f.colour}`}`;
  });
  return `${filaments.length === 1 ? "1 filament" : `${filaments.length} filaments`}, load them in this order: ${named.join(", ")}.`;
}

/** What exports are given for face colours (none = undefined: the plain files, as before). */
export function faceColoursForExport(doc: Pick<JuraCADDocument, "faceAppearance" | "partSpools">): { faceAppearance: FaceAppearance; partSpools?: Record<string, string> } | undefined {
  return doc.faceAppearance && Object.keys(doc.faceAppearance).length ? { faceAppearance: doc.faceAppearance, ...(doc.partSpools ? { partSpools: doc.partSpools } : {}) } : undefined;
}
