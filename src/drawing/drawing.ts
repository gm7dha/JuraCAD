/**
 * Drawing tabs in the document: pure changes (each returns a new document)
 * and reading them safely from files.
 */
import type { Drawing, DrawingView, PartSmithDocument, SheetSize, ViewKind } from "../model/types";

const drawingsOf = (doc: PartSmithDocument) => doc.drawings ?? [];

function withDrawings(doc: PartSmithDocument, drawings: Drawing[]): PartSmithDocument {
  const { drawings: _old, ...rest } = doc;
  return drawings.length ? { ...rest, drawings } : rest;
}

export const VIEW_KINDS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom", "iso"];
export const VIEW_LABELS: Record<ViewKind, string> = {
  front: "Front",
  top: "Top",
  right: "Right",
  left: "Left",
  back: "Back",
  bottom: "Bottom",
  iso: "3D (isometric)",
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

/** Show or hide one kind of view (shown views keep their place). */
export function toggleView(d: Drawing, kind: ViewKind): Drawing {
  const has = d.views.some((v) => v.kind === kind);
  return {
    ...d,
    views: has ? d.views.filter((v) => v.kind !== kind) : [...d.views, { id: `${d.id}-${kind}`, kind }],
  };
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
    const views: DrawingView[] = [];
    for (const v of Array.isArray(r.views) ? r.views : []) {
      const rv = (v ?? {}) as Record<string, unknown>;
      if (typeof rv.id !== "string" || typeof rv.kind !== "string" || !VIEW_KINDS.includes(rv.kind as ViewKind)) continue;
      if (views.some((x) => x.kind === rv.kind)) continue;
      const at = Array.isArray(rv.at) && rv.at.length === 2 && rv.at.every(num) ? (rv.at as [number, number]) : undefined;
      views.push({ id: rv.id, kind: rv.kind as ViewKind, ...(at ? { at } : {}) });
    }
    const t = (r.title ?? {}) as Record<string, unknown>;
    const title: Drawing["title"] = {};
    for (const k of ["title", "drawnBy", "material", "notes"] as const) {
      const v = text(t[k], k === "notes" ? 1000 : 200);
      if (v) title[k] = v;
    }
    out.push({
      id: r.id,
      name: text(r.name, 80)?.trim() || "Drawing",
      source,
      sheet: SHEET_SIZES.includes(r.sheet as SheetSize) ? (r.sheet as SheetSize) : "A4",
      ...(num(r.scale) && (r.scale as number) > 0 ? { scale: r.scale as number } : {}),
      hiddenLines: r.hiddenLines !== false,
      views,
      title,
    });
  }
  return out;
}
