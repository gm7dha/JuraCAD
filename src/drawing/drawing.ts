/**
 * Drawing tabs in the document: pure changes (each returns a new document)
 * and reading them safely from files.
 */
import type { Shortening, BreakOut, DetailView, Dimension, DimPoint, Drawing, DrawingPage, DrawingNote, DrawingRevision, DrawingSymbol, DrawingView, GdtCharacteristic, JuraCADDocument, SectionCut, SheetSize, ViewKind } from "../model/types";
import { SECTION_HOSTS, viewKey } from "./sections";
import { FIRST_PAGE, PAGE_FIELDS } from "./pages";
import { FITTABLE } from "./dimensions";

const drawingsOf = (doc: JuraCADDocument) => doc.drawings ?? [];

function withDrawings(doc: JuraCADDocument, drawings: Drawing[]): JuraCADDocument {
  const { drawings: _old, ...rest } = doc;
  return drawings.length ? { ...rest, drawings } : rest;
}

/** Views that can be shown or hidden with a tick (sections are added by drawing a cutting line). */
export const VIEW_KINDS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom", "iso", "flat"];
export const VIEW_LABELS: Record<ViewKind, string> = {
  front: "Front",
  top: "Top",
  right: "Right",
  left: "Left",
  back: "Back",
  bottom: "Bottom",
  iso: "3D (isometric)",
  section: "Section",
  detail: "Detail",
  flat: "Flat pattern (sheet metal)",
};
export const SHEET_SIZES: SheetSize[] = ["A4", "A3", "A2", "A1", "A0", "ANSI A", "ANSI B", "ANSI C", "ANSI D", "ANSI E"];
/** What each sheet size is, for the menu. */
export const SHEET_LABELS: Record<SheetSize, string> = {
  A4: "A4 (297 × 210 mm)",
  A3: "A3 (420 × 297 mm)",
  A2: "A2 (594 × 420 mm)",
  A1: "A1 (841 × 594 mm)",
  A0: "A0 (1189 × 841 mm)",
  "ANSI A": "ANSI A / Letter (11 × 8.5 in)",
  "ANSI B": "ANSI B / Tabloid (17 × 11 in)",
  "ANSI C": "ANSI C (22 × 17 in)",
  "ANSI D": "ANSI D (34 × 22 in)",
  "ANSI E": "ANSI E (44 × 34 in)",
};

/** The views a new drawing starts with: the usual three, plus a 3D view. */
export const DEFAULT_VIEWS: ViewKind[] = ["front", "top", "right", "iso"];

export function nextDrawingName(doc: JuraCADDocument): string {
  const used = new Set(drawingsOf(doc).map((d) => d.name));
  let n = 1;
  while (used.has(`Drawing ${n}`)) n++;
  return `Drawing ${n}`;
}

export function addDrawing(doc: JuraCADDocument, id: string, source: Drawing["source"]): JuraCADDocument {
  // Designs in inches start on US paper, arranged the US way (third-angle).
  const us = doc.units === "in";
  const drawing: Drawing = {
    id,
    name: nextDrawingName(doc),
    source,
    sheet: us ? "ANSI A" : "A4",
    ...(us ? { projection: "third" as const } : {}),
    hiddenLines: true,
    views: DEFAULT_VIEWS.map((kind) => ({ id: `${id}-${kind}`, kind })),
    title: {},
  };
  return withDrawings(doc, [...drawingsOf(doc), drawing]);
}

export function updateDrawing(doc: JuraCADDocument, id: string, fn: (d: Drawing) => Drawing): JuraCADDocument {
  if (!drawingsOf(doc).some((d) => d.id === id)) return doc;
  return withDrawings(
    doc,
    drawingsOf(doc).map((d) => (d.id === id ? fn(d) : d)),
  );
}

export function removeDrawing(doc: JuraCADDocument, id: string): JuraCADDocument {
  return withDrawings(
    doc,
    drawingsOf(doc).filter((d) => d.id !== id),
  );
}

export function renameDrawing(doc: JuraCADDocument, id: string, name: string): JuraCADDocument {
  const trimmed = name.trim();
  return trimmed ? updateDrawing(doc, id, (d) => ({ ...d, name: trimmed })) : doc;
}

/** Show or hide one kind of view (shown views keep their place; a hidden view's dimensions go with it). */
export function toggleView(drawing: Drawing, kind: ViewKind): Drawing {
  // (The room kept for dimensions was worked out for the old views: dropped.)
  const d = withoutFit(drawing);
  const has = d.views.some((v) => v.kind === kind);
  if (!has) return { ...d, views: [...d.views, { id: `${d.id}-${kind}`, kind }] };
  const out: Drawing = { ...d, views: d.views.filter((v) => v.kind !== kind) };
  const dims = (d.dimensions ?? []).filter((x) => x.view !== kind);
  if (dims.length) out.dimensions = dims;
  else delete out.dimensions;
  return out;
}

/**
 * The views to ask the geometry engine for: the drawing's own views (sections
 * and details are asked for separately), plus the view each detail is taken
 * from — even when that view is hidden — so a detail doesn't vanish when its
 * view is unticked.
 */
export function projectionKinds(d: Pick<Drawing, "views" | "details">): ViewKind[] {
  const out: ViewKind[] = [];
  const add = (k: ViewKind) => !out.includes(k) && out.push(k);
  for (const v of d.views) if (v.kind !== "section" && v.kind !== "detail") add(v.kind);
  for (const x of d.details ?? []) if (d.views.some((v) => v.kind === "detail" && v.detail === x.id)) add(x.host);
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

export function putNote(d: Drawing, note: DrawingNote): Drawing {
  const notes = d.notes ?? [];
  return { ...d, notes: notes.some((x) => x.id === note.id) ? notes.map((x) => (x.id === note.id ? note : x)) : [...notes, note] };
}

/** The next revision letter: A, B, … Z, then AA, AB… */
export function nextRevision(d: Pick<Drawing, "revisions">): string {
  const last = d.revisions?.[d.revisions.length - 1]?.rev ?? "";
  if (!/^[A-Z]+$/.test(last)) return "A";
  const chars = last.split("");
  let i = chars.length - 1;
  while (i >= 0 && chars[i] === "Z") chars[i--] = "A";
  if (i < 0) chars.unshift("A");
  else chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
  return chars.join("");
}

export function removeNote(d: Drawing, id: string): Drawing {
  const left = (d.notes ?? []).filter((x) => x.id !== id);
  const { notes: _old, ...rest } = d;
  return left.length ? { ...rest, notes: left } : rest;
}

/**
 * Put just the lined-up views (front, top, sides, back, bottom) back in their
 * automatic places — e.g. after switching first/third angle — keeping where
 * the 3D, section, detail and flat pattern views were moved to.
 */
export function arrangeLinedUp(d: Drawing): Drawing {
  const lined = new Set<ViewKind>(["front", "top", "right", "left", "back", "bottom"]);
  return { ...withoutFit(d), views: d.views.map(({ at, ...v }) => (lined.has(v.kind) || !at ? v : { ...v, at })) };
}

/**
 * A drawing without its saved room for dimensions (Drawing.fit) — for when
 * the sheet, the views or how they're arranged change, so it isn't stale.
 */
export function withoutFit(d: Drawing): Drawing {
  if (!d.fit) return d;
  const { fit: _old, ...rest } = d;
  return rest;
}

/** Put every view back in its automatic place (dropping any saved room for dimensions). */
export function arrangeViews(d: Drawing): Drawing {
  return { ...withoutFit(d), views: d.views.map(({ at: _at, ...v }) => v) };
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
      sections.push({ id: rs.id, letter, host: rs.host as ViewKind, a, b, ...(rs.flip === true ? { flip: true } : {}), ...(rs.aux === true ? { aux: true } : {}) });
    }
    const breakouts: BreakOut[] = [];
    for (const x of Array.isArray(r.breakouts) ? r.breakouts : []) {
      const rx = (x ?? {}) as Record<string, unknown>;
      const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every(num) ? (v as [number, number]) : null);
      const a = pair(rx.a);
      const b = pair(rx.b);
      if (typeof rx.id !== "string" || !SECTION_HOSTS.includes(rx.host as ViewKind) || !a || !b || !num(rx.depth) || (rx.depth as number) <= 0) continue;
      breakouts.push({ id: rx.id, host: rx.host as ViewKind, a, b, depth: rx.depth as number });
    }
    const shortened: Shortening[] = [];
    for (const x of Array.isArray(r.shortened) ? r.shortened : []) {
      const rx = (x ?? {}) as Record<string, unknown>;
      if (typeof rx.id !== "string" || !SECTION_HOSTS.includes(rx.host as ViewKind) || (rx.axis !== "x" && rx.axis !== "y") || !num(rx.from) || !num(rx.to)) continue;
      const from = Math.max(0, Math.min(1, rx.from as number));
      const to = Math.max(0, Math.min(1, rx.to as number));
      if (Math.abs(to - from) < 1e-6) continue;
      shortened.push({ id: rx.id, host: rx.host as ViewKind, axis: rx.axis, from: Math.min(from, to), to: Math.max(from, to) });
    }
    const details: DetailView[] = [];
    for (const x of Array.isArray(r.details) ? r.details : []) {
      const rx = (x ?? {}) as Record<string, unknown>;
      const centre = Array.isArray(rx.centre) && rx.centre.length === 2 && rx.centre.every(num) ? (rx.centre as [number, number]) : null;
      if (typeof rx.id !== "string" || details.some((d) => d.id === rx.id) || !SECTION_HOSTS.includes(rx.host as ViewKind) || !centre) continue;
      if (!num(rx.radius) || (rx.radius as number) <= 0) continue;
      const zoom = num(rx.zoom) && (rx.zoom as number) > 0 ? Math.min(50, rx.zoom as number) : 2;
      const letter = typeof rx.letter === "string" && rx.letter.trim() ? rx.letter.trim().slice(0, 3) : "B";
      details.push({ id: rx.id, letter, host: rx.host as ViewKind, centre, radius: rx.radius as number, zoom });
    }
    const views: DrawingView[] = [];
    for (const v of Array.isArray(r.views) ? r.views : []) {
      const rv = (v ?? {}) as Record<string, unknown>;
      if (typeof rv.id !== "string" || typeof rv.kind !== "string") continue;
      const at = Array.isArray(rv.at) && rv.at.length === 2 && rv.at.every(num) ? (rv.at as [number, number]) : undefined;
      // (A view's own scale; detail views have their enlargement instead.)
      const own = num(rv.scale) && (rv.scale as number) > 0 && rv.kind !== "detail" ? { scale: Math.min(1000, rv.scale as number) } : {};
      if (rv.kind === "section") {
        let id = typeof rv.section === "string" ? rv.section : null;
        // Drawings saved before sections could be chosen had one section, front to back, at `sectionAt`.
        if (!id && !sections.length) {
          const f = num(r.sectionAt) ? Math.max(0.01, Math.min(0.99, r.sectionAt as number)) : 0.5;
          sections.push({ id: "A", letter: "A", host: "top", a: [0, f], b: [1, f] });
          id = "A";
        }
        if (!id || !sections.some((s) => s.id === id) || views.some((x) => x.kind === "section" && x.section === id)) continue;
        views.push({ id: rv.id, kind: "section", section: id, ...(at ? { at } : {}), ...own });
        continue;
      }
      if (rv.kind === "detail") {
        const id = typeof rv.detail === "string" ? rv.detail : null;
        if (!id || !details.some((x) => x.id === id) || views.some((x) => x.kind === "detail" && x.detail === id)) continue;
        views.push({ id: rv.id, kind: "detail", detail: id, ...(at ? { at } : {}) });
        continue;
      }
      if (!VIEW_KINDS.includes(rv.kind as ViewKind)) continue;
      if (views.some((x) => x.kind === rv.kind)) continue;
      views.push({ id: rv.id, kind: rv.kind as ViewKind, ...(at ? { at } : {}), ...own });
    }
    // Sections without a view are dropped.
    const shownSections = sections.filter((s) => views.some((v) => v.kind === "section" && v.section === s.id));
    const t = (r.title ?? {}) as Record<string, unknown>;
    const title: Drawing["title"] = {};
    for (const k of ["title", "drawnBy", "material", "notes", "partNumber", "company"] as const) {
      const v = text(t[k], k === "notes" ? 1000 : 200);
      if (v) title[k] = v;
    }
    const viewKeys = new Set(views.map((v) => viewKey(v)));
    const dimensions = (Array.isArray(r.dimensions) ? r.dimensions : [])
      .map((raw) => {
        // Dimensions on the old single section view.
        const old = raw && typeof raw === "object" && (raw as Record<string, unknown>).view === "section";
        return parseDimension(old ? { ...(raw as object), view: "section:A" } : raw);
      })
      .filter((x): x is Dimension => x !== null && viewKeys.has(x.view));
    const notes = (Array.isArray(r.notes) ? r.notes : [])
      .map((raw): DrawingNote | null => {
        const n = (raw ?? {}) as Record<string, unknown>;
        const at = Array.isArray(n.at) && n.at.length === 2 && n.at.every(num) ? (n.at as [number, number]) : null;
        if (typeof n.id !== "string" || !at || typeof n.text !== "string") return null;
        const leader = Array.isArray(n.leader) && n.leader.length === 2 && n.leader.every(num) ? (n.leader as [number, number]) : null;
        const symbol = parseSymbol(n.symbol);
        return { id: n.id, at, text: n.text.slice(0, 2000), ...(symbol ? { symbol } : {}), ...(leader ? { leader } : {}) };
      })
      .filter((x): x is DrawingNote => x !== null);
    const revisions = (Array.isArray(r.revisions) ? r.revisions : [])
      .map((raw): DrawingRevision | null => {
        const v = (raw ?? {}) as Record<string, unknown>;
        if (typeof v.id !== "string") return null;
        const str = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : "");
        return { id: v.id, rev: str(v.rev, 8), description: str(v.description, 200), date: str(v.date, 20) };
      })
      .filter((x): x is DrawingRevision => x !== null)
      .slice(0, 20);
    out.push({
      ...(dimensions.length ? { dimensions } : {}),
      ...(notes.length ? { notes } : {}),
      ...(revisions.length ? { revisions } : {}),
      id: r.id,
      name: text(r.name, 80)?.trim() || "Drawing",
      source,
      sheet: SHEET_SIZES.includes(r.sheet as SheetSize) ? (r.sheet as SheetSize) : "A4",
      ...(r.projection === "third" ? { projection: "third" as const } : {}),
      ...(num(r.scale) && (r.scale as number) > 0 ? { scale: r.scale as number } : {}),
      hiddenLines: r.hiddenLines !== false,
      views,
      title,
      ...(shownSections.length ? { sections: shownSections } : {}),
      ...(breakouts.length ? { breakouts } : {}),
      ...(shortened.length ? { shortened } : {}),
      ...(details.some((x) => views.some((v) => v.kind === "detail" && v.detail === x.id))
        ? { details: details.filter((x) => views.some((v) => v.kind === "detail" && v.detail === x.id)) }
        : {}),
      ...(r.centreLines === false ? { centreLines: false } : {}),
      ...(r.threadSymbols === false ? { threadSymbols: false } : {}),
      ...(r.holeTable === true ? { holeTable: true } : {}),
      ...(r.balloons === false ? { balloons: false } : {}),
      ...(r.exploded === true ? { exploded: true } : {}),
      ...(isPlaces(r.places) ? { places: r.places as number } : {}),
      ...(r.dualUnits === true ? { dualUnits: true } : {}),
      ...(r.tangentEdges === false ? { tangentEdges: false } : {}),
      ...parseFit(r.fit),
      ...(Array.isArray(r.holeTableAt) && r.holeTableAt.length === 2 && r.holeTableAt.every(num) ? { holeTableAt: r.holeTableAt as [number, number] } : {}),
      ...parsePages(r),
    });
  }
  return out;
}

/**
 * A drawing's sheets 2, 3… Each is read the same way as sheet 1 (so the same
 * checks apply), as a drawing of its own with the shared settings.
 */
function parsePages(r: Record<string, unknown>): Pick<Drawing, "pages"> {
  if (!Array.isArray(r.pages)) return {};
  const shared: Record<string, unknown> = { ...r };
  for (const k of [...PAGE_FIELDS, "pages", "sectionAt"]) delete shared[k];
  const pages: DrawingPage[] = [];
  for (const raw of (r.pages as unknown[]).slice(0, 50)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || p.id === FIRST_PAGE || pages.some((x) => x.id === p.id)) continue;
    const fields: Record<string, unknown> = {};
    for (const k of PAGE_FIELDS) if (p[k] !== undefined) fields[k] = p[k];
    const [read] = parseDrawings([{ ...shared, ...fields }]);
    if (!read) continue;
    const page: Record<string, unknown> = { id: p.id };
    for (const k of PAGE_FIELDS) if (read[k] !== undefined) page[k] = read[k];
    pages.push(page as DrawingPage);
  }
  return pages.length ? { pages } : {};
}

/** A saved Fit to sheet plan (see Drawing.fit). */
function parseFit(raw: unknown): Pick<Drawing, "fit"> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const gap = num(r.gap) && (r.gap as number) > 0 ? Math.min(40, r.gap as number) : undefined;
  const fit = { ...(gap ? { gap } : {}), ...(r.down === true ? { down: true as const } : {}) };
  return Object.keys(fit).length ? { fit } : {};
}

/** Decimal places a dimension can be set to show. */
export const PLACES = [0, 1, 2, 3, 4];
const isPlaces = (v: unknown) => typeof v === "number" && PLACES.includes(v);

const DIM_TYPES = new Set(["horizontal", "vertical", "aligned", "diameter", "radius", "ordinate", "angle", "chamfer", "arcLength"]);

function parseDimPoint(raw: unknown): DimPoint | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every(num) ? (v as [number, number]) : null);
  const at = pair(p.at);
  const rel = pair(p.rel);
  return at && rel ? { at, rel } : null;
}

/** An angle dimension's second edge and which way its arms open. */
function angleParts(r: Record<string, unknown>): Pick<Dimension, "c" | "d" | "rays"> {
  const c = parseDimPoint(r.c);
  const d = parseDimPoint(r.d);
  const rays = Array.isArray(r.rays) && r.rays.length === 2 ? (r.rays.map((v) => (v === -1 ? -1 : 1)) as [number, number]) : undefined;
  return { ...(c ? { c } : {}), ...(d ? { d } : {}), ...(rays ? { rays } : {}) };
}

function parseDimension(raw: unknown): Dimension | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.type !== "string" || !DIM_TYPES.has(r.type)) return null;
  if (typeof r.view !== "string" || !(VIEW_KINDS.includes(r.view as ViewKind) || /^(section|detail):.+/.test(r.view))) return null;
  const a = parseDimPoint(r.a);
  if (!a) return null;
  const type = r.type as Dimension["type"];
  const round = type === "diameter" || type === "radius" || type === "arcLength";
  // (An arc length also keeps a point on its arc, to tell it from other arcs round the same centre.)
  const b = round && type !== "arcLength" ? null : parseDimPoint(r.b);
  if ((!round || type === "arcLength") && !b) return null;
  if (round && !(num(r.r) && (r.r as number) > 0)) return null;
  if (type === "angle" && !(parseDimPoint(r.c) && parseDimPoint(r.d))) return null;
  return {
    id: r.id,
    view: r.view,
    type,
    a,
    ...(b ? { b } : {}),
    ...(round ? { r: r.r as number } : {}),
    offset: num(r.offset) ? (r.offset as number) : 8,
    ...(num(r.angle) ? { angle: r.angle as number } : {}),
    ...(num(r.textAlong) && r.textAlong !== 0 ? { textAlong: r.textAlong as number } : {}),
    ...(num(r.textAcross) && r.textAcross !== 0 ? { textAcross: r.textAcross as number } : {}),
    ...(type === "ordinate" ? { axis: r.axis === "v" ? ("v" as const) : ("h" as const) } : {}),
    ...(r.tolerance && typeof r.tolerance === "object" && num((r.tolerance as Record<string, unknown>).plus) && num((r.tolerance as Record<string, unknown>).minus)
      ? { tolerance: { plus: Math.abs((r.tolerance as { plus: number }).plus), minus: Math.abs((r.tolerance as { minus: number }).minus) } }
      : {}),
    ...(typeof r.prefix === "string" && r.prefix ? { prefix: r.prefix.slice(0, 40) } : {}),
    ...(typeof r.suffix === "string" && r.suffix ? { suffix: r.suffix.slice(0, 40) } : {}),
    ...(r.callout === true && type === "diameter" ? { callout: true } : {}),
    ...(type === "angle" ? angleParts(r) : {}),
    ...(isPlaces(r.places) ? { places: r.places as number } : {}),
    ...(r.frame === "basic" || r.frame === "inspection" ? { frame: r.frame } : {}),
    ...parseLimitsFit(r.limitsFit, type),
    ...(type === "chamfer" && (r.along === "h" || r.along === "v") ? { along: r.along } : {}),
  };
}

/** A saved limits-and-fits class ("H7", "g6", "H7/g6"), kept as typed (checked when shown). */
function parseLimitsFit(raw: unknown, type: Dimension["type"]): Pick<Dimension, "limitsFit"> {
  if (!raw || typeof raw !== "object" || !FITTABLE.has(type)) return {};
  const r = raw as Record<string, unknown>;
  const cls = typeof r.class === "string" ? r.class.replace(/\s+/g, "").slice(0, 12) : "";
  return cls ? { limitsFit: { class: cls, ...(r.limits === true ? { limits: true as const } : {}) } } : {};
}

const CHARACTERISTICS = new Set<GdtCharacteristic>([
  "straightness",
  "flatness",
  "circularity",
  "cylindricity",
  "profileLine",
  "profileSurface",
  "perpendicularity",
  "parallelism",
  "angularity",
  "position",
  "concentricity",
  "symmetry",
  "runout",
  "totalRunout",
]);

/** A saved drawing symbol (null if it isn't one). */
function parseSymbol(raw: unknown): DrawingSymbol | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  if (r.kind === "datum") return { kind: "datum", letter: str(r.letter, 3) || "A" };
  if (r.kind === "finish") return { kind: "finish", ra: str(r.ra, 12), ...(r.machined === false ? { machined: false } : {}) };
  if (r.kind === "fcf" && CHARACTERISTICS.has(r.characteristic as GdtCharacteristic)) {
    const datums = (Array.isArray(r.datums) ? r.datums : []).slice(0, 3).map((d) => str(d, 6));
    return { kind: "fcf", characteristic: r.characteristic as GdtCharacteristic, tolerance: str(r.tolerance, 16), datums, ...(r.diameter === true ? { diameter: true } : {}) };
  }
  return null;
}
