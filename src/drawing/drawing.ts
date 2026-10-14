/**
 * Drawing tabs in the document: pure changes (each returns a new document)
 * and reading them safely from files.
 */
import type { Dimension, DimPoint, Drawing, DrawingView, PartSmithDocument, SectionCut, SheetSize, ViewKind } from "../model/types";
import { SECTION_HOSTS } from "./sections";

const drawingsOf = (doc: PartSmithDocument) => doc.drawings ?? [];

function withDrawings(doc: PartSmithDocument, drawings: Drawing[]): PartSmithDocument {
  const { drawings: _old, ...rest } = doc;
  return drawings.length ? { ...rest, drawings } : rest;
}

/** Views that can be shown or hidden with a tick (sections are added by drawing a cutting line). */
export const VIEW_KINDS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom", "iso"];
export const VIEW_LABELS: Record<ViewKind, string> = {
  front: "Front",
  top: "Top",
  right: "Right",
  left: "Left",
  back: "Back",
  bottom: "Bottom",
  iso: "3D (isometric)",
  section: "Section",
};
export const SHEET_SIZES: SheetSize[] = ["A4", "A3", "A2"];

/** The views a new drawing starts with: the usual three, plus a 3D view. */
export const DEFAULT_VIEWS: ViewKind[] = ["front", "top", "right", "iso"];

export function nextDrawingName(doc: PartSmithDocument): string {
  const used = new Set(drawingsOf(doc).map((d) => d.name));
  let n = 1;
  while (used.has(`Drawing ${n}`)) n++;
  return `Drawing ${n}`;
}

export function addDrawing(doc: PartSmithDocument, id: string, source: Drawing["source"]): PartSmithDocument {
  const drawing: Drawing = {
    id,
    name: nextDrawingName(doc),
    source,
    sheet: "A4",
    hiddenLines: true,
    views: DEFAULT_VIEWS.map((kind) => ({ id: `${id}-${kind}`, kind })),
    title: {},
  };
  return withDrawings(doc, [...drawingsOf(doc), drawing]);
}

export function updateDrawing(doc: PartSmithDocument, id: string, fn: (d: Drawing) => Drawing): PartSmithDocument {
  if (!drawingsOf(doc).some((d) => d.id === id)) return doc;
  return withDrawings(
    doc,
    drawingsOf(doc).map((d) => (d.id === id ? fn(d) : d)),
  );
}

export function removeDrawing(doc: PartSmithDocument, id: string): PartSmithDocument {
  return withDrawings(
    doc,
    drawingsOf(doc).filter((d) => d.id !== id),
  );
}

export function renameDrawing(doc: PartSmithDocument, id: string, name: string): PartSmithDocument {
  const trimmed = name.trim();
  return trimmed ? updateDrawing(doc, id, (d) => ({ ...d, name: trimmed })) : doc;
}

/** Show or hide one kind of view (shown views keep their place; a hidden view's dimensions go with it). */
export function toggleView(d: Drawing, kind: ViewKind): Drawing {
  const has = d.views.some((v) => v.kind === kind);
  if (!has) return { ...d, views: [...d.views, { id: `${d.id}-${kind}`, kind }] };
  const out: Drawing = { ...d, views: d.views.filter((v) => v.kind !== kind) };
  const dims = (d.dimensions ?? []).filter((x) => x.view !== kind);
  if (dims.length) out.dimensions = dims;
  else delete out.dimensions;
  return out;
}

/** Add a dimension, or replace the one with the same id. */
export function putDimension(d: Drawing, dim: Dimension): Drawing {
  const dims = d.dimensions ?? [];
  return { ...d, dimensions: dims.some((x) => x.id === dim.id) ? dims.map((x) => (x.id === dim.id ? dim : x)) : [...dims, dim] };
}

export function removeDimension(d: Drawing, id: string): Drawing {
  const left = (d.dimensions ?? []).filter((x) => x.id !== id);
  const { dimensions: _old, ...rest } = d;
  return left.length ? { ...rest, dimensions: left } : rest;
}

/** Put every view back in its automatic place. */
export function arrangeViews(d: Drawing): Drawing {
  return { ...d, views: d.views.map(({ at: _at, ...v }) => v) };
}

// ---------------------------------------------------------------------------
// Reading from files

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

export function parseDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || out.some((d) => d.id === r.id)) continue;
    const src = r.source as Record<string, unknown> | null | undefined;
    const source: Drawing["source"] =
      src && (src.kind === "part" || src.kind === "assembly") && typeof src.id === "string" ? { kind: src.kind as "part" | "assembly", id: src.id } : null;
    const sections: SectionCut[] = [];
    for (const s of Array.isArray(r.sections) ? r.sections : []) {
      const rs = (s ?? {}) as Record<string, unknown>;
      const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every(num) ? (v as [number, number]) : null);
      const a = pair(rs.a);
      const b = pair(rs.b);
      if (typeof rs.id !== "string" || sections.some((x) => x.id === rs.id) || !SECTION_HOSTS.includes(rs.host as ViewKind) || !a || !b) continue;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
      const letter = typeof rs.letter === "string" && rs.letter.trim() ? rs.letter.trim().slice(0, 3) : "A";
      sections.push({ id: rs.id, letter, host: rs.host as ViewKind, a, b, ...(rs.flip === true ? { flip: true } : {}) });
    }
    const views: DrawingView[] = [];
    for (const v of Array.isArray(r.views) ? r.views : []) {
      const rv = (v ?? {}) as Record<string, unknown>;
      if (typeof rv.id !== "string" || typeof rv.kind !== "string") continue;
      const at = Array.isArray(rv.at) && rv.at.length === 2 && rv.at.every(num) ? (rv.at as [number, number]) : undefined;
      if (rv.kind === "section") {
        let id = typeof rv.section === "string" ? rv.section : null;
        // Drawings saved before sections could be chosen had one section, front to back, at `sectionAt`.
        if (!id && !sections.length) {
          const f = num(r.sectionAt) ? Math.max(0.01, Math.min(0.99, r.sectionAt as number)) : 0.5;
          sections.push({ id: "A", letter: "A", host: "top", a: [0, f], b: [1, f] });
          id = "A";
        }
        if (!id || !sections.some((s) => s.id === id) || views.some((x) => x.kind === "section" && x.section === id)) continue;
        views.push({ id: rv.id, kind: "section", section: id, ...(at ? { at } : {}) });
        continue;
      }
      if (!VIEW_KINDS.includes(rv.kind as ViewKind)) continue;
      if (views.some((x) => x.kind === rv.kind)) continue;
      views.push({ id: rv.id, kind: rv.kind as ViewKind, ...(at ? { at } : {}) });
    }
    // Sections without a view are dropped.
    const shownSections = sections.filter((s) => views.some((v) => v.kind === "section" && v.section === s.id));
    const t = (r.title ?? {}) as Record<string, unknown>;
    const title: Drawing["title"] = {};
    for (const k of ["title", "drawnBy", "material", "notes"] as const) {
      const v = text(t[k], k === "notes" ? 1000 : 200);
      if (v) title[k] = v;
    }
    const viewKeys = new Set(views.map((v) => (v.kind === "section" ? `section:${v.section}` : v.kind)));
    const dimensions = (Array.isArray(r.dimensions) ? r.dimensions : [])
      .map((raw) => {
        // Dimensions on the old single section view.
        const old = raw && typeof raw === "object" && (raw as Record<string, unknown>).view === "section";
        return parseDimension(old ? { ...(raw as object), view: "section:A" } : raw);
      })
      .filter((x): x is Dimension => x !== null && viewKeys.has(x.view));
    out.push({
      ...(dimensions.length ? { dimensions } : {}),
      id: r.id,
      name: text(r.name, 80)?.trim() || "Drawing",
      source,
      sheet: SHEET_SIZES.includes(r.sheet as SheetSize) ? (r.sheet as SheetSize) : "A4",
      ...(num(r.scale) && (r.scale as number) > 0 ? { scale: r.scale as number } : {}),
      hiddenLines: r.hiddenLines !== false,
      views,
      title,
      ...(shownSections.length ? { sections: shownSections } : {}),
      ...(r.centreLines === false ? { centreLines: false } : {}),
      ...(r.balloons === false ? { balloons: false } : {}),
      ...(r.exploded === true ? { exploded: true } : {}),
    });
  }
  return out;
}

const DIM_TYPES = new Set(["horizontal", "vertical", "aligned", "diameter", "radius"]);

function parseDimPoint(raw: unknown): DimPoint | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every(num) ? (v as [number, number]) : null);
  const at = pair(p.at);
  const rel = pair(p.rel);
  return at && rel ? { at, rel } : null;
}

function parseDimension(raw: unknown): Dimension | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.type !== "string" || !DIM_TYPES.has(r.type)) return null;
  if (typeof r.view !== "string" || !(VIEW_KINDS.includes(r.view as ViewKind) || /^section:.+/.test(r.view))) return null;
  const a = parseDimPoint(r.a);
  if (!a) return null;
  const type = r.type as Dimension["type"];
  const round = type === "diameter" || type === "radius";
  const b = round ? null : parseDimPoint(r.b);
  if (!round && !b) return null;
  if (round && !(num(r.r) && (r.r as number) > 0)) return null;
  return {
    id: r.id,
    view: r.view,
    type,
    a,
    ...(b ? { b } : {}),
    ...(round ? { r: r.r as number } : {}),
    offset: num(r.offset) ? (r.offset as number) : 8,
    ...(num(r.angle) ? { angle: r.angle as number } : {}),
  };
}
