/**
 * Named views (Onshape's): the camera saved under a name, per Part Studio or assembly, to come back to later.
 * Kept in the document (`doc.namedViews`; missing in older files) so they're saved and undoable. Pure.
 */
import type { JuraCADDocument } from "./types";

type V3 = [number, number, number];

export interface NamedView {
  id: string;
  name: string;
  /** The Part Studio's or assembly's id it belongs to. */
  owner: string;
  /** From the point looked at towards the camera (unit length). */
  dir: V3;
  /** The point looked at. */
  target: V3;
  /** How far it's zoomed in (the 3D view's own zoom). */
  zoom: number;
  /** Which way is up on screen. */
  up: V3;
}

/** A camera as the 3D view gives it (and takes it back). */
export interface CameraState {
  dir: V3;
  target: V3;
  zoom: number;
  up: V3;
}

export const MAX_VIEW_NAME = 60;

const NO_VIEWS: NamedView[] = [];

/** The views saved for a Part Studio or assembly, in the order they were saved. */
export function viewsOf(doc: JuraCADDocument, owner: string): NamedView[] {
  const all = doc.namedViews;
  if (!all?.length) return NO_VIEWS;
  return all.filter((v) => v.owner === owner);
}

/** "View 1", "View 2"… — the first not yet used there. */
export function nextViewName(doc: JuraCADDocument, owner: string): string {
  const used = new Set(viewsOf(doc, owner).map((v) => v.name.toLowerCase()));
  for (let n = 1; ; n++) if (!used.has(`view ${n}`)) return `View ${n}`;
}

export function cleanViewName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_VIEW_NAME);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec = (v: unknown): V3 | null => (Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0], v[1], v[2]] : null);
const unit = (v: V3): V3 | null => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
};

/** A camera made safe to keep: unit directions, a positive zoom. Null if it can't be. */
export function cleanCamera(c: { dir: unknown; target: unknown; zoom: unknown; up: unknown }): CameraState | null {
  const dir = vec(c.dir);
  const target = vec(c.target);
  const up = vec(c.up);
  if (!dir || !target || !up || !finite(c.zoom) || c.zoom <= 0) return null;
  const d = unit(dir);
  const u = unit(up);
  if (!d || !u) return null;
  return { dir: d, target, zoom: c.zoom, up: u };
}

/** Save the camera under a name (a name used there already is replaced, as saving over it). */
export function saveNamedView(doc: JuraCADDocument, owner: string, name: string, camera: CameraState, id: string): JuraCADDocument {
  const clean = cleanViewName(name) || nextViewName(doc, owner);
  const cam = cleanCamera(camera);
  if (!cam) return doc;
  const all = doc.namedViews ?? [];
  const same = all.find((v) => v.owner === owner && v.name.toLowerCase() === clean.toLowerCase());
  const view: NamedView = { id: same?.id ?? id, name: clean, owner, ...cam };
  return { ...doc, namedViews: same ? all.map((v) => (v === same ? view : v)) : [...all, view] };
}

/** Problem with a new name for a view (empty, or another view there has it), or null. */
export function viewNameProblem(doc: JuraCADDocument, id: string, name: string): string | null {
  const clean = cleanViewName(name);
  if (!clean) return "Give the view a name.";
  const view = doc.namedViews?.find((v) => v.id === id);
  if (!view) return null;
  if (viewsOf(doc, view.owner).some((v) => v.id !== id && v.name.toLowerCase() === clean.toLowerCase())) return `There's already a view called “${clean}”.`;
  return null;
}

export function renameNamedView(doc: JuraCADDocument, id: string, name: string): JuraCADDocument {
  if (viewNameProblem(doc, id, name)) return doc;
  const clean = cleanViewName(name);
  const all = doc.namedViews ?? [];
  if (!all.some((v) => v.id === id && v.name !== clean)) return doc;
  return { ...doc, namedViews: all.map((v) => (v.id === id ? { ...v, name: clean } : v)) };
}

export function removeNamedView(doc: JuraCADDocument, id: string): JuraCADDocument {
  const all = doc.namedViews ?? [];
  if (!all.some((v) => v.id === id)) return doc;
  return withViews(doc, all.filter((v) => v.id !== id));
}

/** Forget every view of a Part Studio or assembly that's gone. */
export function removeViewsOf(doc: JuraCADDocument, owner: string): JuraCADDocument {
  const all = doc.namedViews ?? [];
  if (!all.some((v) => v.owner === owner)) return doc;
  return withViews(doc, all.filter((v) => v.owner !== owner));
}

function withViews(doc: JuraCADDocument, views: NamedView[]): JuraCADDocument {
  if (views.length) return { ...doc, namedViews: views };
  const { namedViews: _gone, ...rest } = doc;
  return rest;
}

/** Read the saved views from a file (anything odd is left out). */
export function parseNamedViews(raw: unknown): NamedView[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedView[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const v = r as Record<string, unknown>;
    if (typeof v.id !== "string" || ids.has(v.id) || typeof v.owner !== "string" || typeof v.name !== "string") continue;
    const name = cleanViewName(v.name);
    const cam = cleanCamera({ dir: v.dir, target: v.target, zoom: v.zoom, up: v.up });
    if (!name || !cam) continue;
    ids.add(v.id);
    out.push({ id: v.id, name, owner: v.owner, ...cam });
  }
  return out;
}
