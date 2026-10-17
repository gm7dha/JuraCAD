/**
 * Section views: where the cut is in 3D, and which way the section view
 * looks, worked out from a cutting line drawn on a flat view. Used by the
 * geometry engine (to make the cut) and the sheet (to draw the cutting line
 * and its arrows).
 */
import type { BreakOut, Drawing, DrawingView, SectionCut, ViewKind } from "../model/types";
import { VIEW_CAMERAS, viewUp } from "./cameras";

type V3 = [number, number, number];
type P2 = [number, number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Views a cutting line can be drawn on. */
export const SECTION_HOSTS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom"];

/** The key a view's lines are kept under: its kind, or "section:<id>" for a section. */
export function viewKey(v: Pick<DrawingView, "kind" | "section" | "detail">): string {
  if (v.kind === "detail" && v.detail) return `detail:${v.detail}`;
  return v.kind === "section" && v.section ? `section:${v.section}` : v.kind;
}

/** A point on a view from its fractions across the view's box. */
export function fromRel(bounds: [number, number, number, number], rel: P2): P2 {
  return [bounds[0] + rel[0] * (bounds[2] - bounds[0]), bounds[1] + rel[1] * (bounds[3] - bounds[1])];
}

/** A point on a view as fractions across its box. */
export function toRel(bounds: [number, number, number, number], p: P2): P2 {
  const w = bounds[2] - bounds[0] || 1;
  const h = bounds[3] - bounds[1] || 1;
  return [(p[0] - bounds[0]) / w, (p[1] - bounds[1]) / h];
}

export interface SectionGeometry {
  /** A point on the cut (model mm). */
  origin: V3;
  /** Out of the cut, towards the side that's taken away (and towards whoever looks at the section). */
  normal: V3;
  /** The section view's camera: towards the viewer, and right on the paper. */
  toward: V3;
  right: V3;
  /** Which way the section looks, on the host view's paper (for the arrows). */
  look: P2;
}

/**
 * The cut for a line from `a` to `b` (host view mm). The cut contains the line
 * and runs straight back into the host view. The section view is turned so
 * that up is up (Z) where it can be, otherwise along the line.
 */
export function sectionGeometry(host: ViewKind, a: P2, b: P2, flip = false): SectionGeometry | null {
  const { toward: t } = VIEW_CAMERAS[host];
  const r = VIEW_CAMERAS[host].right;
  const u = viewUp(host);
  const at = (p: P2): V3 => [p[0] * r[0] + p[1] * u[0], p[0] * r[1] + p[1] * u[1], p[0] * r[2] + p[1] * u[2]];
  const d = [b[0] - a[0], b[1] - a[1]];
  if (Math.hypot(d[0], d[1]) < 1e-9) return null;
  const along = norm(at([d[0], d[1]]));
  let normal = norm(cross(along, t));
  if (flip) normal = [-normal[0], -normal[1], -normal[2]];
  const z: V3 = [0, 0, 1];
  const upGuess: V3 = [z[0] - normal[0] * normal[2], z[1] - normal[1] * normal[2], z[2] - normal[2] * normal[2]];
  let right: V3;
  if (Math.hypot(...upGuess) > 0.1) {
    const up = norm(upGuess);
    right = cross(up, normal);
  } else {
    // Looking straight up or down: keep the line running across the paper, left to right as drawn on the host.
    right = Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] >= 0 ? along : (along.map((v) => -v) as V3)) : d[1] >= 0 ? along : (along.map((v) => -v) as V3);
  }
  const look: P2 = [-dot(normal, r), -dot(normal, u)];
  return { origin: at(a), normal, toward: normal, right: norm(right), look };
}

/** The next free section letter (I, O and Q are skipped, as they look like numbers). */
export function nextSectionLetter(d: Drawing): string {
  const used = new Set([...(d.sections ?? []), ...(d.details ?? [])].map((s) => s.letter));
  for (const ch of "ABCDEFGHJKLMNPRSTUVWXYZ") if (!used.has(ch)) return ch;
  let n = 1;
  while (used.has(`A${n}`)) n++;
  return `A${n}`;
}

/** Add a section, with its view. */
export function addSection(d: Drawing, cut: Omit<SectionCut, "letter"> & { letter?: string }): Drawing {
  const section: SectionCut = { ...cut, letter: cut.letter ?? nextSectionLetter(d) };
  return {
    ...d,
    sections: [...(d.sections ?? []), section],
    views: [...d.views, { id: `${d.id}-section-${section.id}`, kind: "section", section: section.id }],
  };
}

/** Change one section. */
export function updateSection(d: Drawing, id: string, fn: (s: SectionCut) => SectionCut): Drawing {
  return { ...d, sections: (d.sections ?? []).map((s) => (s.id === id ? fn(s) : s)) };
}

/** A section's name on the sheet: "SECTION A-A", or "VIEW A" for an auxiliary view. */
export function sectionTitle(s: Pick<SectionCut, "letter" | "aux">): string {
  return s.aux ? `VIEW ${s.letter}` : `SECTION ${s.letter}-${s.letter}`;
}

/** Remove a section, its view, and the dimensions on it. */
export function removeSection(d: Drawing, id: string): Drawing {
  const key = `section:${id}`;
  const sections = (d.sections ?? []).filter((s) => s.id !== id);
  const dims = (d.dimensions ?? []).filter((x) => x.view !== key);
  const { sections: _s, dimensions: _d, ...rest } = d;
  return {
    ...rest,
    views: d.views.filter((v) => !(v.kind === "section" && v.section === id)),
    ...(sections.length ? { sections } : {}),
    ...(dims.length ? { dimensions: dims } : {}),
  };
}

/** What the geometry engine needs for each section view. */
export interface SectionRequest {
  key: string;
  host: ViewKind;
  a: P2;
  b: P2;
  flip: boolean;
  /** An auxiliary view: look square-on to the line without cutting. */
  aux?: boolean;
}

export function sectionRequests(d: Drawing): SectionRequest[] {
  return (d.sections ?? [])
    .filter((s) => d.views.some((v) => v.kind === "section" && v.section === s.id))
    .map((s) => ({ key: `section:${s.id}`, host: s.host, a: s.a, b: s.b, flip: !!s.flip, aux: !!s.aux }));
}

/** What the geometry engine needs for each broken-out cut. */
export interface BreakOutRequest {
  host: ViewKind;
  a: P2;
  b: P2;
  depth: number;
}

export function breakOutRequests(d: Drawing): BreakOutRequest[] {
  const shown = new Set(d.views.map((v) => v.kind));
  return (d.breakouts ?? []).filter((b) => shown.has(b.host)).map((b) => ({ host: b.host, a: b.a, b: b.b, depth: b.depth }));
}

/** Add, change or remove a broken-out cut. */
export function putBreakOut(d: Drawing, b: BreakOut): Drawing {
  const list = d.breakouts ?? [];
  return { ...d, breakouts: list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b] };
}

export function removeBreakOut(d: Drawing, id: string): Drawing {
  const list = (d.breakouts ?? []).filter((x) => x.id !== id);
  const { breakouts: _old, ...rest } = d;
  return list.length ? { ...rest, breakouts: list } : rest;
}

/**
 * Sections whose cutting line misses the part (their view came back empty).
 * Only known once the views shown are up to date: while new ones are being
 * worked out, a section just drawn isn't in the old ones yet, and says nothing.
 */
export function missedSections(d: Pick<Drawing, "sections">, projections: Partial<Record<string, { bounds: unknown }>> | null, upToDate: boolean): Set<string> {
  if (!projections || !upToDate) return new Set();
  return new Set((d.sections ?? []).filter((s) => !projections[`section:${s.id}`]?.bounds).map((s) => s.id));
}
