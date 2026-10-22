/**
 * Drawings with more than one sheet. Sheet 1 is the drawing's own views,
 * dimensions and so on (so drawings saved before sheets existed open
 * unchanged); sheets 2, 3… are kept in `Drawing.pages`. Each sheet has its
 * own paper size, scale, views and annotations; what's drawn, the title
 * block and the drawing's settings are shared.
 *
 * Everything that works on a drawing (laying it out, adding views,
 * dimensions…) works on one sheet at a time through `pageOf`, which gives a
 * sheet as a drawing of its own; `withPage` puts the changed sheet back.
 */
import type { Drawing, DrawingPage, PageField } from "../model/types";
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

/** One sheet of a drawing, as a drawing of its own (without `pages`). */
export function pageOf(d: Drawing, id: string): Drawing {
  const page = d.pages?.find((p) => p.id === id);
  if (!page) {
    if (!d.pages) return d;
    const { pages: _p, ...rest } = d;
    return rest;
  }
  const { id: _id, ...fields } = page;
  return { ...omit(d), ...fields };
}

/** Put a sheet (changed by working on `pageOf(d, id)`) back into its drawing. */
export function withPage(d: Drawing, id: string, page: Drawing): Drawing {
  const index = d.pages?.findIndex((p) => p.id === id) ?? -1;
  if (index < 0) {
    // Sheet 1: its fields are the drawing's own.
    const { pages: _p, ...rest } = page;
    return d.pages?.length ? { ...rest, pages: d.pages } : rest;
  }
  const shared = omit(page);
  const pages = d.pages!.map((p, i) => (i === index ? ({ id, ...pick(page) } as DrawingPage) : p));
  return { ...shared, ...pick(d), sheet: d.sheet, views: d.views, pages } as Drawing;
}

/** Change one sheet of a drawing. */
export function changePage(d: Drawing, id: string, fn: (page: Drawing) => Drawing): Drawing {
  return withPage(d, id, fn(pageOf(d, id)));
}

/** Add an empty sheet after the last, the same paper size as `like`; returns the drawing and the new sheet's id. */
export function addPage(d: Drawing, newId: string, like = FIRST_PAGE): Drawing {
  const sheet = pageOf(d, knownPage(d, like)).sheet;
  return { ...d, pages: [...(d.pages ?? []), { id: newId, sheet, views: [] }] };
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
  const { id: _id, ...fields } = next;
  return { ...omit(d), ...fields, ...(later.length ? { pages: later } : {}) };
}

/**
 * The next free section/detail letter across every sheet, so "SECTION A-A"
 * on sheet 1 and on sheet 2 never mean different cuts.
 */
export function nextLetterOnAnySheet(d: Drawing): string {
  const all = pageIds(d).map((id) => pageOf(d, id));
  return nextSectionLetter({ sections: all.flatMap((p) => p.sections ?? []), details: all.flatMap((p) => p.details ?? []) } as Drawing);
}
