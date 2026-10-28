/**
 * Drawings with more than one sheet. Sheet 1 is the drawing's own views,
 * dimensions and so on (so drawings saved before sheets existed open
 * unchanged); sheets 2, 3… are kept in `Drawing.pages`. Each sheet has its
 * own paper size, scale, views and annotations. A sheet can also draw a
 * different part or assembly (`DrawingPage.source`) and have its own title and
 * part number (`DrawingPage.partTitle`); the rest of the title block and the
 * drawing's settings are shared.
 *
 * Everything that works on a drawing (laying it out, adding views,
 * dimensions…) works on one sheet at a time through `pageOf`, which gives a
 * sheet as a drawing of its own; `withPage` puts the changed sheet back.
 */
import type { Drawing, DrawingPage, PageField, PartTitle, ViewKind } from "../model/types";
import { nextSectionLetter } from "./sections";

/** The parts of a drawing that belong to one sheet. */
export const PAGE_FIELDS: readonly PageField[] = ["sheet", "scale", "fit", "views", "dimensions", "notes", "sections", "details", "breakouts", "shortened", "holeTable", "holeTableAt"];

/** Sheet 1's id (it has no entry in `pages`). */
export const FIRST_PAGE = "sheet1";

/** The ids of a drawing's sheets, in order. */
export function pageIds(d: Pick<Drawing, "pages">): string[] {
  return [FIRST_PAGE, ...(d.pages ?? []).map((p) => p.id)];
}

/** A sheet's number (1, 2…), or 1 if it's gone. */
export function pageNumber(d: Pick<Drawing, "pages">, id: string): number {
  const i = pageIds(d).indexOf(id);
  return i < 0 ? 1 : i + 1;
}

/** A sheet id that still exists (sheet 1 if `id` has gone). */
export function knownPage(d: Pick<Drawing, "pages">, id: string | undefined): string {
  return id && pageIds(d).includes(id) ? id : FIRST_PAGE;
}

function pick(d: Partial<Drawing>): Partial<Pick<Drawing, PageField>> {
  const out: Record<string, unknown> = {};
  for (const k of PAGE_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  return out as Partial<Pick<Drawing, PageField>>;
}

function omit(d: Drawing): Omit<Drawing, PageField | "pages"> {
  const out: Record<string, unknown> = { ...d };
  for (const k of PAGE_FIELDS) delete out[k];
  delete out.pages;
  return out as Omit<Drawing, PageField | "pages">;
}

/** True when two sources are the same part or assembly (or both nothing). */
export function sameSource(a: Drawing["source"] | undefined, b: Drawing["source"] | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.kind === b.kind && a.id === b.id);
}

/** A title block's own entries (title and part number), without empty ones. */
function partTitleOf(t: Drawing["title"]): PartTitle {
  return { ...(t.title ? { title: t.title } : {}), ...(t.partNumber ? { partNumber: t.partNumber } : {}) };
}

const samePartTitle = (a: PartTitle, b: PartTitle) => (a.title ?? "") === (b.title ?? "") && (a.partNumber ?? "") === (b.partNumber ?? "");

/** A title block with these own entries in place of its title and part number. */
function withPartTitle(t: Drawing["title"], own: PartTitle): Drawing["title"] {
  const { title: _t, partNumber: _n, ...rest } = t;
  const out: Drawing["title"] = { ...(own.title ? { title: own.title } : {}), ...rest };
  if (own.partNumber) out.partNumber = own.partNumber;
  return out;
}

/** One sheet of a drawing, as a drawing of its own (without `pages`): its source and title block as that sheet shows them. */
export function pageOf(d: Drawing, id: string): Drawing {
  const page = d.pages?.find((p) => p.id === id);
  if (!page) {
    if (!d.pages) return d;
    const { pages: _p, ...rest } = d;
    return rest;
  }
  const { id: _id, source, partTitle, ...fields } = page;
  const out: Drawing = { ...omit(d), ...fields };
  if (source !== undefined) out.source = source;
  // A sheet of another part has none of sheet 1's title and part number.
  if (partTitle || source !== undefined) out.title = withPartTitle(d.title, partTitle ?? {});
  return out;
}

/**
 * Put a sheet (changed by working on `pageOf(d, id)`) back into its drawing.
 * Sheets 2, 3…: a part or title and part number that differ from sheet 1's
 * become the sheet's own; everything else in the title block is shared.
 * Sheet 1: choosing another part leaves the other sheets showing what they did.
 */
export function withPage(d: Drawing, id: string, page: Drawing): Drawing {
  const index = d.pages?.findIndex((p) => p.id === id) ?? -1;
  if (index < 0) {
    // Sheet 1: its fields are the drawing's own.
    const { pages: _p, ...rest } = page;
    if (!d.pages?.length) return rest;
    return { ...rest, pages: sameSource(page.source, d.source) ? d.pages : keepShowing(d, rest) };
  }
  const entry = d.pages![index];
  const ownSource = entry.source !== undefined || !sameSource(page.source, d.source);
  const shown = partTitleOf(page.title);
  const differs = !samePartTitle(shown, partTitleOf(d.title));
  // (On a sheet of another part an empty title is the same as none; on a sheet of sheet 1's part it's its own.)
  const own = ownSource ? (Object.keys(shown).length ? shown : undefined) : entry.partTitle || differs ? shown : undefined;
  const shared = omit(page);
  // (The shared title block keeps sheet 1's title and part number.)
  if (own || differs) shared.title = withPartTitle(page.title, partTitleOf(d.title));
  const next: DrawingPage = { id, ...pick(page), ...(ownSource ? { source: page.source } : {}), ...(own ? { partTitle: own } : {}) } as DrawingPage;
  const pages = d.pages!.map((p, i) => (i === index ? next : p));
  return { ...shared, source: d.source, ...pick(d), sheet: d.sheet, views: d.views, pages } as Drawing;
}

/**
 * The other sheets of `d`, set so that under `next` (the drawing with a
 * different sheet 1) each still shows the part, title and part number it did.
 */
function keepShowing(d: Drawing, next: Omit<Drawing, "pages">): DrawingPage[] {
  return (d.pages ?? []).map((p) => {
    const was = pageOf(d, p.id);
    const out: DrawingPage = { ...p };
    if (!sameSource(was.source, next.source)) out.source = was.source;
    const t = partTitleOf(was.title);
    if (out.partTitle) return out;
    // A sheet now showing its own part keeps the title it had; one still showing sheet 1's keeps it if sheet 1's changed.
    if (out.source !== undefined ? Object.keys(t).length > 0 : !samePartTitle(t, partTitleOf(next.title))) out.partTitle = t;
    return out;
  });
}

/** Change one sheet of a drawing. */
export function changePage(d: Drawing, id: string, fn: (page: Drawing) => Drawing): Drawing {
  return withPage(d, id, fn(pageOf(d, id)));
}

/** The views a sheet of another part starts with (as a new drawing does): ids as `toggleView` makes them. */
const NEW_SHEET_VIEWS: ViewKind[] = ["front", "top", "right", "iso"];

/**
 * Add a sheet after the last, the same paper size as `like`; returns the
 * drawing with it. With no `source` it's an empty sheet of the part (or
 * assembly) `like` shows, with its title and part number. With a `source`,
 * a sheet of that part or assembly, starting with the usual views.
 */
export function addPage(d: Drawing, newId: string, like = FIRST_PAGE, source?: Drawing["source"]): Drawing {
  const from = d.pages?.find((p) => p.id === like);
  const sheet = pageOf(d, knownPage(d, like)).sheet;
  if (source === undefined) {
    const own = from && from.source !== undefined ? { source: from.source } : {};
    const title = from?.partTitle ? { partTitle: from.partTitle } : {};
    return { ...d, pages: [...(d.pages ?? []), { id: newId, sheet, views: [], ...own, ...title }] };
  }
  const page: DrawingPage = { id: newId, sheet, views: NEW_SHEET_VIEWS.map((kind) => ({ id: `${d.id}-${kind}`, kind })) };
  if (!sameSource(source, d.source)) page.source = source;
  return { ...d, pages: [...(d.pages ?? []), page] };
}

/**
 * Remove a sheet and everything on it. Removing sheet 1 makes sheet 2 the
 * first. The last sheet can't be removed (returns the drawing unchanged).
 */
export function removePage(d: Drawing, id: string): Drawing {
  if (!d.pages?.length) return d;
  if (id !== FIRST_PAGE) {
    const pages = d.pages.filter((p) => p.id !== id);
    const { pages: _p, ...rest } = d;
    return pages.length ? { ...rest, pages } : rest;
  }
  const [next, ...later] = d.pages;
  const first = pageOf(d, next.id);
  const { pages: _p, ...rest } = first;
  if (!later.length) return rest;
  // The sheets after it keep showing what they did.
  return { ...rest, pages: keepShowing({ ...d, pages: later }, rest) };
}

/**
 * The next free section/detail letter across every sheet, so "SECTION A-A"
 * on sheet 1 and on sheet 2 never mean different cuts.
 */
export function nextLetterOnAnySheet(d: Drawing): string {
  const all = pageIds(d).map((id) => pageOf(d, id));
  return nextSectionLetter({ sections: all.flatMap((p) => p.sections ?? []), details: all.flatMap((p) => p.details ?? []) } as Drawing);
}
