/**
 * Claude's drawing tools: make a 2D drawing of a part or an assembly, choose
 * the paper, scale and views, add section and detail views, dimension it
 * (automatically, or between described points), fill in the title block,
 * look at the sheet and save it as PDF, SVG or DXF — all with the same pure
 * drawing code as the app's drawing tab (src/drawing), so the drawing opens
 * there exactly as Claude made it.
 */
import { DETAIL_HOSTS, addDetail } from "../drawing/details";
import { addDrawing, renameDrawing, SHEET_SIZES, toggleView, updateDrawing, VIEW_KINDS, VIEW_LABELS, withoutFit } from "../drawing/drawing";
import { autoDimensions, rowOffset, rowSide, type Side } from "../drawing/autoDimension";
import { projectPoint, VIEW_CAMERAS, viewUp } from "../drawing/cameras";
import { dimLabel, dimPoint, measureDim, resolveDim, snapPoints } from "../drawing/dimensions";
import { sheetDxf, sheetsPdf, sheetSvg } from "../drawing/export";
import { changePage, pageIds, pageOf, nextLetterOnAnySheet } from "../drawing/pages";
import { addSection, fromRel, sectionGeometry, SECTION_HOSTS, toRel } from "../drawing/sections";
import { dimStyle, drawingViewKeys, fitDrawing, layoutSheet, offSheetMessage, scaleLabel, STANDARD_SCALES, type PlacedView, type Projections, type SheetInfo, type SheetLayout } from "../drawing/sheet";
import { drawingSubject, finishProjections, projectionPlan, sheetInfo, viewScales, type DrawingSubject } from "../drawing/sheetSource";
import type { ViewProjection } from "../kernel/protocol";
import { newId } from "../model/document";
import type { Dimension, Drawing, JuraCADDocument, ViewKind } from "../model/types";
import { setLengthUnit } from "../model/units";
import { amount, bool, InputError, list, noExtras, object, oneOf, text, xyz, type Obj } from "./args";
import { findAssembly } from "./assemblyTools";
import type { Build, Session } from "./session";
import { sheetPicture } from "./sheetPicture";
import { byName, checkFree, fileNameFor, needFolder, r2, say, writeOut, type ToolDef } from "./toolKit";

type P2 = [number, number];
type V3 = [number, number, number];

const drawingsOf = (doc: JuraCADDocument) => doc.drawings ?? [];
const MAKE_ONE = "make one with create_drawing.";

export function findDrawing(s: Session, ref: unknown, where = "drawing"): Drawing {
  const all = drawingsOf(s.doc);
  if ((ref === undefined || ref === null || ref === "") && all.length === 1) return all[0];
  if ((ref === undefined || ref === null || ref === "") && all.length > 1) throw new InputError(`${where}: say which drawing — ${all.map((d) => `"${d.name}"`).join(", ")}.`);
  return byName(all, ref, where, "drawing", MAKE_ONE);
}

/** The id of sheet `n` (1, 2…) of a drawing. */
function pageIdFor(d: Drawing, raw: unknown): string {
  const ids = pageIds(d);
  if (raw === undefined || raw === null) return ids[0];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > ids.length) {
    throw new InputError(`sheet must be a sheet number from 1 to ${ids.length} (${d.name} has ${ids.length} sheet${ids.length === 1 ? "" : "s"}).`);
  }
  return ids[raw - 1];
}

// ---------------------------------------------------------------------------
// Working out the sheet

/** Views worked out by the engine, per build of the whole design (a new build starts afresh). */
const projectionCache = new WeakMap<Build, Map<string, ViewProjection>>();

/** One view from the engine (or the cache), with a checkpoint before it so a cancelled call stops between views. */
async function projectOne(s: Session, subject: DrawingSubject, request: { kind?: ViewKind; section?: ReturnType<typeof projectionPlan>["sections"][number] }, plan: ReturnType<typeof projectionPlan>): Promise<ViewProjection> {
  const build = s.buildAll();
  let cache = projectionCache.get(build);
  if (!cache) projectionCache.set(build, (cache = new Map()));
  const breakouts = request.kind ? plan.breakouts.filter((b) => b.host === request.kind) : [];
  const key = JSON.stringify([subject.partIds, subject.instances ?? null, request, plan.hidden, plan.tangent, breakouts]);
  const hit = cache.get(key);
  if (hit) return hit;
  await s.checkpoint();
  const [view] = s.withWholeEngine((e) =>
    request.kind ? e.project(subject.partIds, subject.instances, [request.kind], plan.hidden, [], breakouts, plan.tangent) : e.project(subject.partIds, subject.instances, [], plan.hidden, [request.section!], [], plan.tangent),
  );
  cache.set(key, view);
  return view;
}

interface Sheet {
  /** The drawing as one sheet (its own views, dimensions…). */
  page: Drawing;
  pageId: string;
  number: number;
  count: number;
  subject: DrawingSubject;
  projections: Projections;
  info: SheetInfo;
  layout: SheetLayout;
}

/** Lay one sheet of a drawing out, as the app does (views from the engine, then the sheet's shapes). */
async function sheetOf(s: Session, d: Drawing, pageId: string, doc: JuraCADDocument = s.doc): Promise<Sheet> {
  const page = pageOf(d, pageId);
  const parts = s.buildAll().parts;
  const subject = drawingSubject(page, doc, parts);
  if (!subject) {
    throw new InputError(
      d.source?.kind === "assembly"
        ? `${d.name} shows an assembly that no longer exists. Make a new drawing with create_drawing.`
        : `The part ${d.name} shows no longer exists (it may have been renamed away or deleted). Make a new drawing of a part that's there with create_drawing.`,
    );
  }
  const plan = projectionPlan(page);
  const list: ViewProjection[] = [];
  for (const kind of plan.kinds) list.push(await projectOne(s, subject, { kind }, plan));
  for (const section of plan.sections) list.push(await projectOne(s, subject, { section }, plan));
  const projections = finishProjections(list, page);
  const ids = pageIds(d);
  const number = ids.indexOf(pageId) + 1;
  const info = sheetInfo(page, doc, parts, subject.name, subject.instances, number, ids.length);
  // The numbers on the sheet in the design's own unit (as the app shows them).
  setLengthUnit(s.doc.units === "in" ? "in" : "mm");
  try {
    return { page, pageId, number, count: ids.length, subject, projections, info, layout: layoutSheet(page, projections, info) };
  } finally {
    setLengthUnit("mm");
  }
}

/** "Front", "Section A", "Detail B", "Auxiliary view C". */
function viewName(page: Drawing, key: string): string {
  if (key.startsWith("section:")) {
    const c = page.sections?.find((x) => `section:${x.id}` === key);
    return c?.aux ? `Auxiliary view ${c.letter}` : `Section ${c?.letter ?? "?"}`;
  }
  if (key.startsWith("detail:")) return `Detail ${page.details?.find((x) => `detail:${x.id}` === key)?.letter ?? "?"}`;
  return VIEW_LABELS[key as ViewKind] ?? key;
}

/** A view on a sheet named as Claude would: "front", "section A", "detail B", "auxiliary C" (any capitals). */
function viewKeyFor(page: Drawing, raw: unknown, where: string): string {
  const keys = drawingViewKeys(page);
  const names = keys.map((k) => `"${viewName(page, k).toLowerCase().replace("auxiliary view", "auxiliary")}"`).join(", ");
  if (typeof raw !== "string" || !raw.trim()) throw new InputError(`${where}: name a view on the sheet: ${names || "(there are none yet)"}.`);
  const want = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/ view$/, "");
  const hit = keys.find((k) => {
    const n = viewName(page, k).toLowerCase();
    return k === want || n === want || n.replace("auxiliary view", "auxiliary") === want || n.replace(" view", "") === want || (want === "iso" && k === "iso") || (want === "3d" && k === "iso");
  });
  if (!hit) throw new InputError(`${where}: there's no "${raw}" view on this sheet. Its views are: ${names || "none"}.${VIEW_KINDS.includes(want as ViewKind) ? ` Add it with edit_drawing "views".` : ""}`);
  return hit;
}

const AXIS_WORDS = (v: V3) => {
  const k = v.findIndex((x) => Math.abs(x) > 0.999);
  return k < 0 ? `(${v.map(r2).join(", ")})` : `${v[k] > 0 ? "" : "−"}${"XYZ"[k]}`;
};

/** How a view's own flat coordinates relate to the model: "across = X, up = Z". */
function viewAxes(page: Drawing, key: string, projections: Projections): string | null {
  const kind = key.startsWith("detail:") ? page.details?.find((x) => `detail:${x.id}` === key)?.host : (key as ViewKind);
  if (kind && kind !== "iso" && kind !== "flat" && VIEW_CAMERAS[kind] && !key.startsWith("section:")) {
    return `across = ${AXIS_WORDS(VIEW_CAMERAS[kind].right as V3)}, up = ${AXIS_WORDS(viewUp(kind) as V3)}`;
  }
  const frame = sectionFrame(page, key, projections);
  return frame ? `across = ${AXIS_WORDS(frame.right)}, up = ${AXIS_WORDS(frame.up)}` : null;
}

/** A section or auxiliary view's directions in the model (from the line on its host view). */
function sectionFrame(page: Drawing, key: string, projections: Projections): { right: V3; up: V3 } | null {
  const cut = page.sections?.find((x) => `section:${x.id}` === key);
  const host = cut ? projections[cut.host] : undefined;
  if (!cut || !host?.bounds) return null;
  const geo = sectionGeometry(cut.host, fromRel(host.bounds, cut.a), fromRel(host.bounds, cut.b), cut.flip);
  if (!geo) return null;
  const t = geo.toward as V3;
  const r = geo.right as V3;
  return { right: r, up: [t[1] * r[2] - t[2] * r[1], t[2] * r[0] - t[0] * r[2], t[0] * r[1] - t[1] * r[0]] };
}

/** A described point on a view: [x, y, z] in the model (seen from the view), or [across, up] in the view's own mm. */
function viewPoint(page: Drawing, key: string, projections: Projections, raw: unknown, s: Session, where: string): P2 {
  if (Array.isArray(raw) && raw.length === 2) return [amount(raw[0], `${where}[0]`, s.scope()).value, amount(raw[1], `${where}[1]`, s.scope()).value];
  if (!Array.isArray(raw) || raw.length !== 3) throw new InputError(`${where} should be a point of the model [x, y, z] (mm), or [across, up] in the view's own mm.`);
  const p = xyz(raw, where, s.scope()).map((v) => v.value) as V3;
  const kind = key.startsWith("detail:") ? page.details?.find((x) => `detail:${x.id}` === key)?.host : (key as ViewKind);
  if (key === "iso") throw new InputError(`${where}: the 3D view can't be dimensioned. Use the front, top or a side view.`);
  if (kind && !key.startsWith("section:")) return projectPoint(kind, p);
  const frame = sectionFrame(page, key, projections);
  if (!frame) throw new InputError(`${where}: give the point as [across, up] in this view's own mm.`);
  return [p[0] * frame.right[0] + p[1] * frame.right[1] + p[2] * frame.right[2], p[0] * frame.up[0] + p[1] * frame.up[1] + p[2] * frame.up[2]];
}

const fmt2 = (p: P2) => `(${r2(p[0])}, ${r2(p[1])})`;

/** The corner, end or circle centre of a view nearest a point, or an explanation with the nearest ones. */
function snapTo(p: ViewProjection, at: P2, name: string, where: string): P2 {
  const pts = snapPoints(p);
  if (!pts.length) throw new InputError(`${where}: ${name} has no corners or ends to measure to.`);
  const d = (q: P2) => Math.hypot(q[0] - at[0], q[1] - at[1]);
  const sorted = [...pts].sort((a, b) => d(a) - d(b));
  const [x0, y0, x1, y1] = p.bounds ?? [0, 0, 1, 1];
  const tol = Math.max(0.5, 0.02 * Math.hypot(x1 - x0, y1 - y0));
  if (d(sorted[0]) <= tol) return sorted[0];
  throw new InputError(
    `${where}: there's no corner, end or circle centre at ${fmt2(at)} on ${name} (seen in the view's own mm). The nearest are: ${sorted.slice(0, 6).map(fmt2).join(", ")}. Use one of those, or describe_drawing for the view's size.`,
  );
}

/** The circle or arc of a view nearest a point (its centre or a point on it). */
function circleAt(p: ViewProjection, at: P2, name: string, where: string): ViewProjection["circles"][number] {
  const visible = p.circles.filter((c) => !c.hidden);
  const pool = visible.length ? visible : p.circles;
  if (!pool.length) throw new InputError(`${where}: ${name} has no circles or arcs. Choose another view (one that looks along the hole or pin).`);
  const score = (c: (typeof pool)[number]) => Math.min(Math.hypot(c.cx - at[0], c.cy - at[1]), Math.abs(Math.hypot(c.cx - at[0], c.cy - at[1]) - c.r));
  const best = [...pool].sort((a, b) => score(a) - score(b) || b.r - a.r)[0];
  const [x0, y0, x1, y1] = p.bounds ?? [0, 0, 1, 1];
  if (score(best) > Math.max(0.5, 0.02 * Math.hypot(x1 - x0, y1 - y0))) {
    throw new InputError(`${where}: there's no circle at ${fmt2(at)} on ${name}. Its circles: ${pool.slice(0, 8).map((c) => `⌀${r2(2 * c.r)} at ${fmt2([c.cx, c.cy])}`).join(", ")}.`);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Descriptions

function sheetLines(s: Session, d: Drawing, sh: Sheet): string[] {
  const page = sh.page;
  const style = dimStyle(page);
  const scaleText = `${scaleLabel(sh.layout.scale)}${page.scale === undefined ? " (chosen to fit)" : ""}`;
  const off = offSheetMessage(sh.layout, (v: PlacedView) => viewName(page, v.key));
  const views = sh.layout.views.map((v) => {
    const p = sh.projections[v.key];
    const axes = viewAxes(page, v.key, sh.projections);
    const b = p?.bounds;
    const circles = (p?.circles ?? []).filter((c) => !c.hidden && c.full);
    const shown = circles.slice(0, 10).map((c) => `⌀${r2(2 * c.r)} at ${fmt2([c.cx, c.cy])}`);
    return `- ${viewName(page, v.key)}${v.scale !== sh.layout.scale ? ` (scale ${scaleLabel(v.scale)})` : ""}${axes ? ` — ${axes}` : ""}${b ? `; from ${fmt2([b[0], b[1]])} to ${fmt2([b[2], b[3]])} mm` : "; EMPTY (nothing to draw here)"}${shown.length ? `; circles: ${shown.join(", ")}${circles.length > shown.length ? ` and ${circles.length - shown.length} more` : ""}` : ""}`;
  });
  const dims = (page.dimensions ?? []).map((dim) => {
    const p = sh.projections[dim.view];
    if (!p) return `- ${viewName(page, dim.view)}: a ${dim.type} dimension (its view isn't shown)`;
    const r = resolveDim(dim, p);
    setLengthUnit(s.doc.units === "in" ? "in" : "mm");
    const label = dimLabel(dim, measureDim(dim, r), style);
    setLengthUnit("mm");
    return `- ${viewName(page, dim.view)}: ${label} (${dim.type}${dim.b ? ` from ${fmt2(r.a)} to ${fmt2(r.b ?? r.a)}` : ` at ${fmt2(r.a)}`})${r.found ? "" : " — LOST: what it measured isn't there any more"}`;
  });
  const t = page.title;
  const title = [t.title && `title "${t.title}"`, t.partNumber && `part number "${t.partNumber}"`, t.material && `material "${t.material}"`, t.drawnBy && `drawn by "${t.drawnBy}"`, t.company && `company "${t.company}"`, t.notes && `notes "${t.notes.replace(/\n/g, " / ")}"`].filter(Boolean);
  return [
    `${d.name}: ${page.source?.kind === "assembly" ? "assembly" : "part"} "${sh.subject.name}"${sh.count > 1 ? `, sheet ${sh.number} of ${sh.count}` : ""}. Paper ${page.sheet}, scale ${scaleText}, ${page.projection === "third" ? "third-angle (US)" : "first-angle (ISO)"} projection, hidden lines ${page.hiddenLines ? "shown dashed" : "not shown"}${d.exploded ? ", exploded" : ""}.`,
    views.length ? `Views (points in each view's own mm):\n${views.join("\n")}` : "No views yet: add some with edit_drawing \"views\".",
    dims.length ? `Dimensions:\n${dims.join("\n")}` : "No dimensions yet (auto_dimension adds the usual ones; add_dimension adds one).",
    sh.info.bom?.length ? `Parts list on the sheet: ${sh.info.bom.map((b) => `${b.item}. ${b.name} × ${b.quantity}`).join("; ")}.` : null,
    `Title block: ${title.length ? title.join(", ") : "nothing filled in yet"} (date ${sh.info.date}).`,
    sh.layout.tooBig ? "PROBLEM: the views don't fit the paper even at the smallest scale. Choose bigger paper (edit_drawing \"paper\")." : null,
    off ? `PROBLEM: ${off}` : null,
  ].filter((x): x is string => !!x);
}

// ---------------------------------------------------------------------------
// Settings shared by create_drawing and edit_drawing

const STANDARD_VIEWS = VIEW_KINDS;
const TITLE_KEYS: Record<string, keyof Drawing["title"]> = { title: "title", drawn_by: "drawnBy", material: "material", notes: "notes", part_number: "partNumber", company: "company" };

function parseScale(raw: unknown, s: Session): number | undefined {
  if (raw === "fit" || raw === "auto") return undefined;
  if (typeof raw === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
    if (m) {
      const v = Number(m[1]) / Number(m[2]);
      if (v > 0 && Number.isFinite(v)) return checkScale(v);
    }
  }
  if (typeof raw === "number" || typeof raw === "string") {
    const v = amount(raw, "scale", s.scope(), { unit: "", positive: true }).value;
    return checkScale(v);
  }
  throw new InputError('scale should be "fit" (the biggest standard scale that fits), or like "1:2" (half size) or "2:1" (twice size).');
}

function checkScale(v: number): number {
  if (v < 0.001 || v > 100) throw new InputError(`scale ${v} is out of range: use between 1:1000 and 100:1, e.g. "1:2".`);
  const standard = STANDARD_SCALES.find((x) => Math.abs(x - v) / x < 1e-6);
  return standard ?? v;
}

/** Apply the settings Claude gave to one sheet of a drawing (and the drawing's shared ones). */
function applySettings(s: Session, d: Drawing, pageId: string, a: Obj): Drawing {
  let out = d;
  const onPage = (fn: (p: Drawing) => Drawing) => (out = changePage(out, pageId, fn));
  if (a.paper !== undefined) {
    const paper = oneOf(a.paper, SHEET_SIZES, "paper");
    onPage((p) => withoutFit({ ...p, sheet: paper }));
  }
  if (a.scale !== undefined) {
    const scale = parseScale(a.scale, s);
    onPage((p) => {
      const { scale: _old, ...rest } = withoutFit(p);
      return scale === undefined ? rest : { ...rest, scale };
    });
  }
  if (a.views !== undefined) {
    const want = list(a.views, "views", { allowEmpty: true }).map((v, i) => {
      const k = typeof v === "string" ? v.trim().toLowerCase().replace(/^3d$/, "iso") : v;
      return oneOf(k, STANDARD_VIEWS, `views[${i}]`);
    });
    if (want.includes("flat") && d.source?.kind !== "part") throw new InputError('views: "flat" (a flat pattern) is only for a sheet metal part.');
    onPage((p) => {
      let q = p;
      for (const kind of STANDARD_VIEWS) {
        const has = q.views.some((v) => v.kind === kind);
        if (has !== want.includes(kind)) q = toggleView(q, kind);
      }
      // Sections and details drawn on a view that's gone go too.
      const lost = (q.sections ?? []).filter((c) => !want.includes(c.host)).length + (q.details ?? []).filter((c) => !want.includes(c.host)).length;
      if (lost) throw new InputError(`views: a section or detail is drawn on a view you'd take away. Keep ${[...new Set([...(q.sections ?? []), ...(q.details ?? [])].map((c) => c.host))].join(" and ")} in the list.`);
      return q;
    });
  }
  if (a.projection !== undefined) {
    const proj = oneOf(a.projection, ["first", "third"] as const, "projection");
    const { projection: _p, ...rest } = withoutFit(out);
    out = proj === "third" ? { ...rest, projection: "third" } : rest;
  }
  if (a.hidden_lines !== undefined) out = { ...out, hiddenLines: bool(a.hidden_lines, "hidden_lines") };
  if (a.exploded !== undefined) {
    const on = bool(a.exploded, "exploded");
    if (on && out.source?.kind !== "assembly") throw new InputError('"exploded" is only for drawings of an assembly.');
    const { exploded: _e, ...rest } = out;
    out = on ? { ...rest, exploded: true } : rest;
  }
  if (a.title !== undefined) {
    const t = object(a.title, "title");
    noExtras(t, Object.keys(TITLE_KEYS), "title");
    const title = { ...out.title };
    for (const [k, field] of Object.entries(TITLE_KEYS)) {
      if (t[k] === undefined) continue;
      if (t[k] === null || t[k] === "") delete title[field];
      else {
        if (typeof t[k] !== "string") throw new InputError(`title.${k} should be some text (or "" to clear it).`);
        title[field] = (t[k] as string).slice(0, k === "notes" ? 1000 : 200);
      }
    }
    out = { ...out, title };
  }
  return out;
}

const SETTINGS_SCHEMA = {
  paper: { type: "string", enum: [...SHEET_SIZES], description: "Paper size: A4…A0, or ANSI A…E (US). Default A4 (ANSI A for designs in inches)." },
  scale: { description: '"fit" (default: the biggest standard scale that fits), or "1:2", "2:1", "1:1"…' },
  views: { type: "array", items: { type: "string", enum: [...VIEW_KINDS] }, description: 'The standard views: "front", "top", "right", "left", "back", "bottom", "iso" (3D), "flat" (sheet metal flat pattern). Default front, top, right, iso.' },
  projection: { type: "string", enum: ["first", "third"], description: '"first" (ISO, UK/Europe: top view below the front) or "third" (US: top view above).' },
  hidden_lines: { type: "boolean", description: "Show hidden edges dashed (default true)." },
  exploded: { type: "boolean", description: "Assembly drawings: show it spread apart (its exploded view)." },
  title: { type: "object", description: 'Title block: {"title", "part_number", "material", "drawn_by", "company", "notes"} (text; "" clears one).' },
};

/**
 * Lay the changed drawing out and keep the change only if it works: refused
 * (nothing changed) if its views can't be made, or `problem` finds fault.
 */
async function commitDrawing(s: Session, next: JuraCADDocument, d: Drawing, pageId: string, verb: string, problem?: (sh: Sheet) => string | null): Promise<Sheet> {
  const after = drawingsOf(next).find((x) => x.id === d.id)!;
  let sh: Sheet;
  try {
    sh = await sheetOf(s, after, pageId, next);
  } catch (e) {
    if (e instanceof InputError) throw new InputError(`Couldn't ${verb}: ${e.message} Nothing was changed.`);
    throw e;
  }
  if (!sh.layout.views.length && drawingViewKeys(sh.page).length) throw new InputError(`Couldn't ${verb}: none of its views has anything to draw. Nothing was changed.`);
  const why = problem?.(sh);
  if (why) throw new InputError(`Couldn't ${verb}: ${why} Nothing was changed.`);
  s.throwIfCancelled();
  s.commit(next);
  return sh;
}

const DRAWING_REF = { type: "string", description: 'The drawing\'s name, e.g. "Drawing 1" (optional when there is only one).' };
const SHEET_REF = { type: "number", description: "Which sheet (1, 2…; default 1) — drawings made in the app can have several." };

export const DRAWING_TOOLS: ToolDef[] = [
  {
    name: "create_drawing",
    title: "Make a 2D drawing",
    description:
      `Make a 2D engineering drawing (a sheet with views, dimensions and a title block, as in Onshape) of a part ("part": its name; default the latest part) or of an assembly ("assembly": its name; it gets a parts list and numbered balloons). Settings: paper, scale, views, projection, hidden_lines, exploded, title (see edit_drawing). Then auto_dimension or add_dimension, add_section_view, add_detail_view, view_drawing to look at it, and export_drawing for a PDF, SVG or DXF.`,
    inputSchema: { type: "object", properties: { part: { type: "string" }, assembly: { type: "string" }, name: { type: "string" }, ...SETTINGS_SCHEMA } },
    run: async (s, a) => {
      noExtras(a, ["part", "assembly", "name", ...Object.keys(SETTINGS_SCHEMA)], "create_drawing");
      if (a.part !== undefined && a.assembly !== undefined) throw new InputError('Give either "part" or "assembly", not both.');
      let source: Drawing["source"];
      if (a.assembly !== undefined) source = { kind: "assembly", id: findAssembly(s, a.assembly).id };
      else {
        const all = s.buildAll().parts.filter((p) => !p.configuration);
        const part = a.part === undefined ? s.part(s.build().parts, undefined, "part") : s.part(all, a.part, "part");
        source = { kind: "part", id: part.id };
      }
      const id = newId("d");
      let next = addDrawing(s.doc, id, source);
      if (a.name !== undefined) {
        const name = text(a.name, "name").slice(0, 80);
        if (drawingsOf(s.doc).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a drawing called "${name}". Choose another name.`);
        next = renameDrawing(next, id, name);
      }
      const made = drawingsOf(next).find((x) => x.id === id)!;
      const settled = applySettings(s, made, pageIds(made)[0], a);
      next = updateDrawing(next, id, () => settled);
      const sh = await commitDrawing(s, next, settled, pageIds(settled)[0], "make the drawing");
      return say(`Made ${settled.name}.`, ...sheetLines(s, settled, sh), "Next: auto_dimension (or add_dimension), view_drawing to look at it, export_drawing to save a PDF.");
    },
  },
  {
    name: "edit_drawing",
    title: "Change a drawing's settings",
    description:
      'Change a drawing: "paper" (A4…A0, ANSI A…E), "scale" ("fit", "1:2", "2:1"…), "views" (the standard views to show — the list replaces the old one; a view taken away takes its dimensions with it), "projection" ("first" ISO / "third" US), "hidden_lines", "exploded" (assembly drawings), "title" (title block: title, part_number, material, drawn_by, company, notes), "name". Only what\'s given changes.',
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF, name: { type: "string" }, ...SETTINGS_SCHEMA }, required: [] },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "name", ...Object.keys(SETTINGS_SCHEMA)], "edit_drawing");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      let changed = applySettings(s, d, pageId, a);
      if (a.name !== undefined) {
        const name = text(a.name, "name").slice(0, 80);
        if (drawingsOf(s.doc).some((x) => x.id !== d.id && x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`There's already a drawing called "${name}". Choose another name.`);
        changed = { ...changed, name };
      }
      if (JSON.stringify(changed) === JSON.stringify(d)) return say(`${d.name} already has those settings; nothing changed.`);
      const sh = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, `change ${d.name}`);
      return say(`Changed ${changed.name}.`, ...sheetLines(s, changed, sh));
    },
  },
  {
    name: "add_section_view",
    title: "Add a section view",
    description:
      'Add a section view: the part cut straight through along a line drawn on another view ("on": "front", "top", "right", "left", "back" or "bottom" — a view on the sheet), shown as its own view "SECTION A-A". The line is "vertical" or "horizontal" on that view ("direction", default vertical) through "through" [x, y, z] (a model point, default the middle), or runs "from" [x, y, z] "to" [x, y, z]. "flip": true looks the other way. "auxiliary": true instead adds an auxiliary view: the whole part seen square-on to the line (to show a sloping face at its true size).',
    inputSchema: {
      type: "object",
      properties: {
        drawing: DRAWING_REF,
        sheet: SHEET_REF,
        on: { type: "string", enum: [...SECTION_HOSTS] },
        direction: { type: "string", enum: ["vertical", "horizontal"] },
        through: { type: "array", items: {} },
        from: { type: "array", items: {} },
        to: { type: "array", items: {} },
        flip: { type: "boolean" },
        auxiliary: { type: "boolean" },
      },
      required: ["on"],
    },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "on", "direction", "through", "from", "to", "flip", "auxiliary"], "add_section_view");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      const host = oneOf(a.on, SECTION_HOSTS, "on");
      const page = pageOf(d, pageId);
      if (!page.views.some((v) => v.kind === host)) throw new InputError(`The ${host} view isn't on the sheet, so the line can't be drawn on it. Add it first with edit_drawing "views", or choose another view.`);
      const sh = await sheetOf(s, d, pageId);
      const hp = sh.projections[host];
      if (!hp?.bounds) throw new InputError(`The ${host} view is empty, so there's nothing to cut.`);
      const flat = (raw: unknown, where: string) => projectPoint(host, xyz(raw, where, s.scope()).map((v) => v.value) as V3);
      let ra: P2;
      let rb: P2;
      if (a.from !== undefined || a.to !== undefined) {
        if (a.from === undefined || a.to === undefined) throw new InputError('Give both "from" and "to" (or neither, and use "direction" and "through").');
        if (a.direction !== undefined || a.through !== undefined) throw new InputError('Give either "from" and "to", or "direction" and "through" — not both.');
        ra = toRel(hp.bounds, flat(a.from, "from"));
        rb = toRel(hp.bounds, flat(a.to, "to"));
        if (Math.hypot(rb[0] - ra[0], rb[1] - ra[1]) < 1e-6) throw new InputError('"from" and "to" land on the same spot of the view; give two points apart (seen from that view).');
      } else {
        const dir = oneOf(a.direction, ["vertical", "horizontal"] as const, "direction", "vertical");
        const mid: P2 = a.through === undefined ? [(hp.bounds[0] + hp.bounds[2]) / 2, (hp.bounds[1] + hp.bounds[3]) / 2] : flat(a.through, "through");
        const rel = toRel(hp.bounds, mid);
        // A little past the part either side, as you'd draw it.
        ra = dir === "vertical" ? [rel[0], -0.15] : [-0.15, rel[1]];
        rb = dir === "vertical" ? [rel[0], 1.15] : [1.15, rel[1]];
      }
      const id = newId("sc");
      const aux = bool(a.auxiliary, "auxiliary");
      // The cut is the whole line, carried on both ways: it must pass through the part as the view sees it.
      if (!aux) {
        const side = (q: P2) => (rb[0] - ra[0]) * (q[1] - ra[1]) - (rb[1] - ra[1]) * (q[0] - ra[0]);
        const corners: P2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const signs = corners.map(side);
        if (!(Math.min(...signs) < -1e-9 && Math.max(...signs) > 1e-9)) {
          const b = hp.bounds;
          throw new InputError(`The cutting line misses the part on the ${host} view (it spans ${fmt2([b[0], b[1]])} to ${fmt2([b[2], b[3]])} there, ${viewAxes(page, host, sh.projections)}). Nothing was changed. Put "through" inside the part.`);
        }
      }
      const changed = changePage(d, pageId, (p) => addSection(withoutFit(p), { id, host, a: ra, b: rb, ...(a.flip === true ? { flip: true } : {}), ...(aux ? { aux: true } : {}), letter: nextLetterOnAnySheet(d) }));
      const key = `section:${id}`;
      const after = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "add the section", (x) =>
        x.projections[key]?.bounds ? null : `the cutting line misses the part, so there's nothing to show. Put "through" inside the part (describe_drawing gives the ${host} view's extent).`,
      );
      return say(`Added ${viewName(after.page, key)} (cut along a line on the ${host} view).`, ...sheetLines(s, changed, after));
    },
  },
  {
    name: "add_detail_view",
    title: "Add a detail view",
    description:
      'Add a detail view: a circle on a view ("on": front, top, right, left, back or bottom) around "around" [x, y, z] (a model point) with "radius" (mm, on the part), shown again "zoom" times bigger (default 2) as "DETAIL B".',
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF, on: { type: "string", enum: [...DETAIL_HOSTS] }, around: { type: "array", items: {} }, radius: {}, zoom: { type: "number" } }, required: ["on", "around", "radius"] },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "on", "around", "radius", "zoom"], "add_detail_view");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      const host = oneOf(a.on, DETAIL_HOSTS, "on");
      if (!pageOf(d, pageId).views.some((v) => v.kind === host)) throw new InputError(`The ${host} view isn't on the sheet. Add it first with edit_drawing "views", or choose another view.`);
      const radius = amount(a.radius, "radius", s.scope(), { positive: true }).value;
      const zoom = a.zoom === undefined ? 2 : amount(a.zoom, "zoom", s.scope(), { unit: "", min: 1.1 }).value;
      if (zoom > 20) throw new InputError("zoom can be at most 20.");
      const sh = await sheetOf(s, d, pageId);
      const hp = sh.projections[host];
      if (!hp?.bounds) throw new InputError(`The ${host} view is empty, so there's nothing to show bigger.`);
      const centre = toRel(hp.bounds, projectPoint(host, xyz(a.around, "around", s.scope()).map((v) => v.value) as V3));
      const id = newId("dt");
      const changed = changePage(d, pageId, (p) => addDetail(withoutFit(p), { id, host, centre, radius, zoom, letter: nextLetterOnAnySheet(d) }));
      const key = `detail:${id}`;
      const after = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "add the detail", (x) =>
        x.projections[key]?.bounds ? null : `the circle doesn't take in any of the ${host} view's lines. Put "around" on the part, or make "radius" bigger.`,
      );
      return say(`Added ${viewName(after.page, key)} (${zoom}× the ${host} view around ${fmt2(projectPoint(host, xyz(a.around, "around", s.scope()).map((v) => v.value) as V3))}).`, ...sheetLines(s, changed, after));
    },
  },
  {
    name: "auto_dimension",
    title: "Dimension a drawing automatically",
    description: "Add the dimensions a drawing usually needs — overall sizes, positions of holes and steps from a corner, and hole sizes — to its front, top and side views, as the app's Auto dimension does (it then makes room for them). Existing dimensions are kept.",
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF } },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet"], "auto_dimension");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      const sh = await sheetOf(s, d, pageId);
      const page = sh.page;
      const keys = drawingViewKeys(page);
      const third = page.projection === "third";
      const existing = page.dimensions ?? [];
      const added = autoDimensions(sh.projections, keys, existing, viewScales(page, sh.layout.scale), () => newId("dm"), third);
      if (!added.length) {
        const hasViews = keys.some((k) => k !== "iso" && !k.startsWith("section:"));
        return say(hasViews ? `${d.name} is already dimensioned; nothing more to add.` : "Auto dimension needs a front, top or side view: add one with edit_drawing \"views\".");
      }
      const next = fitDrawing(page, sh.projections, sh.info, (scale) => [...existing, ...autoDimensions(sh.projections, keys, existing, viewScales(page, scale), () => newId("dm"), third)]);
      const count = (next.dimensions?.length ?? 0) - existing.length;
      const changed = changePage(d, pageId, () => next);
      const after = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "dimension it");
      return say(`Added ${count} dimension${count === 1 ? "" : "s"} to ${d.name}.`, ...sheetLines(s, changed, after));
    },
  },
  {
    name: "add_dimension",
    title: "Add a dimension to a drawing",
    description:
      'Add one dimension to a view of a drawing ("view": "front", "top", "right"…, "section A", "detail B"). A length between two points: "from" and "to"; a circle or arc\'s size: "circle". Points are model points [x, y, z] (mm; seen from the view) or [across, up] in the view\'s own mm (describe_drawing gives each view\'s directions and extent); each snaps to the nearest corner, end or circle centre. "type": "horizontal", "vertical" or "aligned" for lengths (default: horizontal or vertical when the points line up that way, else aligned); "diameter" or "radius" for circles (default diameter for a full circle). "side": "above", "below", "left" or "right" of the view (default the usual side). "tolerance": ± amount (mm), or {"plus": …, "minus": …}.',
    inputSchema: {
      type: "object",
      properties: {
        drawing: DRAWING_REF,
        sheet: SHEET_REF,
        view: { type: "string" },
        from: { type: "array", items: {} },
        to: { type: "array", items: {} },
        circle: { type: "array", items: {} },
        type: { type: "string", enum: ["horizontal", "vertical", "aligned", "diameter", "radius"] },
        side: { type: "string", enum: ["above", "below", "left", "right"] },
        tolerance: {},
      },
      required: ["view"],
    },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "view", "from", "to", "circle", "type", "side", "tolerance"], "add_dimension");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      const sh = await sheetOf(s, d, pageId);
      const page = sh.page;
      const key = viewKeyFor(page, a.view, "view");
      const p = sh.projections[key];
      const name = viewName(page, key);
      if (!p?.bounds) throw new InputError(`${name} is empty, so there's nothing to dimension there.`);
      if (key === "iso") throw new InputError("The 3D view can't be dimensioned (its sizes aren't true lengths). Use the front, top or a side view.");
      const scale = viewScales(page, sh.layout.scale)(key) * (p.zoom ?? 1);
      let dim: Dimension;
      const tolerance = parseTolerance(a.tolerance, s);
      if (a.circle !== undefined) {
        if (a.from !== undefined || a.to !== undefined) throw new InputError('Give either "circle" (a circle\'s size) or "from" and "to" (a length), not both.');
        const c = circleAt(p, viewPoint(page, key, sh.projections, a.circle, s, "circle"), name, "circle");
        const type = a.type === undefined ? (c.full ? "diameter" : "radius") : oneOf(a.type, ["diameter", "radius"] as const, "type (for a circle)");
        dim = { id: newId("dm"), view: key, type, a: dimPoint([c.cx, c.cy], p), r: c.r, offset: 8, angle: 45, ...(tolerance ? { tolerance } : {}) };
      } else {
        if (a.from === undefined || a.to === undefined) throw new InputError('Give "from" and "to" (two points, for a length) or "circle" (for a circle\'s size).');
        const pa = snapTo(p, viewPoint(page, key, sh.projections, a.from, s, "from"), name, "from");
        const pb = snapTo(p, viewPoint(page, key, sh.projections, a.to, s, "to"), name, "to");
        if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 1e-6) throw new InputError(`"from" and "to" are the same point on ${name}. Give two different corners (seen from that view, points straight behind each other are the same).`);
        const flatX = Math.abs(pb[0] - pa[0]) < 1e-6;
        const flatY = Math.abs(pb[1] - pa[1]) < 1e-6;
        const type = a.type === undefined ? (flatY ? "horizontal" : flatX ? "vertical" : "aligned") : oneOf(a.type, ["horizontal", "vertical", "aligned"] as const, "type (for a length)");
        if ((type === "horizontal" && flatX) || (type === "vertical" && flatY)) throw new InputError(`A ${type} dimension between those points would be 0: they're straight ${type === "horizontal" ? "above each other" : "beside each other"} on ${name}. Use "${type === "horizontal" ? "vertical" : "horizontal"}" or "aligned".`);
        const kind = key.startsWith("detail:") || key.startsWith("section:") ? null : key;
        const usual: Side = kind ? rowSide(kind, type === "vertical" ? "v" : "h", page.projection === "third", drawingViewKeys(page)) : type === "vertical" ? "right" : "below";
        const side = a.side === undefined ? usual : (oneOf(a.side, ["above", "below", "left", "right"] as const, "side") as Side);
        if (type === "horizontal" && (side === "left" || side === "right")) throw new InputError('A horizontal dimension goes "above" or "below" the view.');
        if (type === "vertical" && (side === "above" || side === "below")) throw new InputError('A vertical dimension goes "left" or "right" of the view.');
        let offset: number;
        if (type === "aligned") offset = side === "below" || side === "right" ? -8 : 8;
        else {
          // One row further out for each dimension already on that side.
          const row = (page.dimensions ?? []).filter((x) => x.view === key && x.type === type && Math.sign(x.offset) === Math.sign(rowOffset(p, side, pa, pb, scale, 0))).length;
          offset = rowOffset(p, side, pa, pb, scale, row);
        }
        dim = { id: newId("dm"), view: key, type, a: dimPoint(pa, p), b: dimPoint(pb, p), offset, ...(tolerance ? { tolerance } : {}) };
      }
      const changed = changePage(d, pageId, (q) => ({ ...q, dimensions: [...(q.dimensions ?? []), dim] }));
      const after = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "add the dimension");
      const r = resolveDim(dim, p);
      setLengthUnit(s.doc.units === "in" ? "in" : "mm");
      const label = dimLabel(dim, measureDim(dim, r), dimStyle(page));
      setLengthUnit("mm");
      const off = offSheetMessage(after.layout, (v: PlacedView) => viewName(page, v.key));
      return say(`Added a ${dim.type} dimension on ${name}: ${label}.`, off ? `Note: ${off}` : null, "Look at the sheet with view_drawing.");
    },
  },
  {
    name: "describe_drawing",
    title: "Describe a drawing",
    description: "A drawing as it is now: what it shows, paper, scale, each view with its directions in the model, extent and circles (in the view's own mm, for add_dimension), the dimensions with their values, the parts list, the title block, and any problem (views off the paper). With no drawing given and several in the design, lists them.",
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF } },
    readOnly: true,
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet"], "describe_drawing");
      const all = drawingsOf(s.doc);
      if (a.drawing === undefined && all.length !== 1) {
        if (!all.length) return say(`The design has no drawings yet: ${MAKE_ONE}`);
        return say(`The design has ${all.length} drawings: ${all.map((x) => `"${x.name}"`).join(", ")}. Say which one with "drawing".`);
      }
      const d = findDrawing(s, a.drawing);
      const sh = await sheetOf(s, d, pageIdFor(d, a.sheet));
      return say(...sheetLines(s, d, sh));
    },
  },
  {
    name: "view_drawing",
    title: "Look at a drawing",
    description: "A picture (PNG) of a drawing sheet as it will print — views, dimensions, title block and parts list — with a description of it, to check it before export_drawing.",
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF, width: { type: "number", description: "Pixels across, 800–2400 (default 1400)." } } },
    readOnly: true,
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "width"], "view_drawing");
      const d = findDrawing(s, a.drawing);
      const width = a.width === undefined ? 1400 : Math.round(Number(a.width));
      if (!(width >= 800 && width <= 2400)) throw new InputError("width must be between 800 and 2400 pixels.");
      const sh = await sheetOf(s, d, pageIdFor(d, a.sheet));
      await s.checkpoint();
      const pic = sheetPicture(sh.layout.prims, sh.layout.size, width);
      return {
        content: [
          { type: "image", data: Buffer.from(pic.png).toString("base64"), mimeType: "image/png" },
          { type: "text", text: [`The sheet (${sh.layout.size[0]} × ${sh.layout.size[1]} mm, shown ${pic.width} × ${pic.height} pixels; small text is approximate in the picture, exact in the files).`, ...sheetLines(s, d, sh)].join("\n") },
        ],
      };
    },
  },
  {
    name: "export_drawing",
    title: "Save a drawing as PDF, SVG or DXF",
    description: 'Save a drawing into the JuraCAD folder at true size: "pdf" (every sheet, a page each — for printing and sending), "svg" (one sheet, for drawing programs) or "dxf" (one sheet, for laser cutters and other CAD programs).',
    destructive: true,
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, format: { type: "string", enum: ["pdf", "svg", "dxf"] }, filename: { type: "string" }, sheet: SHEET_REF, overwrite: { type: "boolean" } }, required: ["format"] },
    run: async (s, a) => {
      noExtras(a, ["drawing", "format", "filename", "sheet", "overwrite"], "export_drawing");
      const folder = needFolder(s);
      const d = findDrawing(s, a.drawing);
      const format = oneOf(a.format, ["pdf", "svg", "dxf"] as const, "format");
      if (format === "pdf" && a.sheet !== undefined) throw new InputError("A PDF has every sheet (a page each), so leave out \"sheet\".");
      const path = folder.pathFor(a.filename === undefined ? fileNameFor(`${s.doc.name} ${d.name}`) : text(a.filename, "filename"), [`.${format}`], "file");
      checkFree(s, path, a.overwrite);
      const title = `${s.doc.name} — ${d.name}`;
      let bytes: Uint8Array | string;
      let pages = 1;
      if (format === "pdf") {
        const sheets: Sheet[] = [];
        for (const id of pageIds(d)) sheets.push(await sheetOf(s, d, id));
        pages = sheets.length;
        bytes = sheetsPdf(sheets.map((x) => ({ prims: x.layout.prims, size: x.layout.size })), title);
      } else {
        const sh = await sheetOf(s, d, pageIdFor(d, a.sheet));
        bytes = format === "svg" ? sheetSvg(sh.layout.prims, sh.layout.size, title) : sheetDxf(sh.layout.prims);
      }
      await s.checkpoint();
      writeOut(s, path, bytes);
      const size = typeof bytes === "string" ? bytes.length : bytes.byteLength;
      return say(`Saved ${d.name} to ${path} (${format.toUpperCase()}${format === "pdf" ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""}, ${Math.max(1, Math.round(size / 1024))} KB).`);
    },
  },
];

function parseTolerance(raw: unknown, s: Session): Dimension["tolerance"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = object(raw, "tolerance");
    noExtras(o, ["plus", "minus"], "tolerance");
    const plus = amount(o.plus, "tolerance.plus", s.scope(), { min: 0 }).value;
    const minus = amount(o.minus, "tolerance.minus", s.scope(), { min: 0 }).value;
    return { plus, minus };
  }
  const v = amount(raw, "tolerance", s.scope(), { positive: true }).value;
  return { plus: v, minus: v };
}
