/**
 * Drawing templates (Onshape's custom drawing templates): a sheet size, a
 * standard and the title block entries that stay the same from drawing to
 * drawing (company, drawn by, material, the user's own entries…), saved by
 * name in this browser and used for new drawings. Pure: reading, writing,
 * making one from a drawing and putting one on a drawing.
 */
import type { Drawing, SheetSize, TitleField } from "../model/types";
import { arrangeLinedUp, parseFields, SHEET_SIZES, withoutFit } from "./drawing";

/** Title block entries a template keeps (the title, part number and notes belong to each drawing). */
export const TEMPLATE_TITLE_KEYS = ["drawnBy", "material", "company"] as const;
type TemplateTitle = Pick<Drawing["title"], (typeof TEMPLATE_TITLE_KEYS)[number]>;

export interface DrawingTemplate {
  id: string;
  name: string;
  sheet: SheetSize;
  standard?: "ansi";
  projection?: "third";
  title: TemplateTitle;
  fields?: TitleField[];
  places?: number;
  decimalComma?: true;
  dualUnits?: true;
}

/** Most templates kept. */
export const MAX_TEMPLATES = 30;

/** A template of a drawing's sheet, standard and lasting title block entries (values of its own fields kept). */
export function templateFrom(d: Drawing, id: string, name: string): DrawingTemplate {
  const title: TemplateTitle = {};
  for (const k of TEMPLATE_TITLE_KEYS) if (d.title[k]) title[k] = d.title[k];
  return {
    id,
    name: name.trim().slice(0, 60) || "My template",
    sheet: d.sheet,
    ...(d.standard ? { standard: d.standard } : {}),
    ...(d.projection ? { projection: d.projection } : {}),
    title,
    ...(d.fields?.length ? { fields: d.fields.map((f) => ({ ...f })) } : {}),
    ...(d.places !== undefined ? { places: d.places } : {}),
    ...(d.decimalComma ? { decimalComma: true as const } : {}),
    ...(d.dualUnits ? { dualUnits: true as const } : {}),
  };
}

/**
 * Put a template on a drawing: its sheet, standard, projection, number style
 * and title block entries (its own entries replace the drawing's; the title,
 * part number and notes stay). The views go back to their places when the
 * sheet or projection changes.
 */
export function applyTemplate(d: Drawing, t: DrawingTemplate): Drawing {
  const { standard: _s, projection: _p, fields: _f, places: _pl, decimalComma: _c, dualUnits: _du, ...rest } = d;
  const title: Drawing["title"] = { ...d.title };
  for (const k of TEMPLATE_TITLE_KEYS) {
    if (t.title[k]) title[k] = t.title[k];
    else delete title[k];
  }
  let next: Drawing = {
    ...rest,
    sheet: t.sheet,
    title,
    ...(t.standard ? { standard: t.standard } : {}),
    ...(t.projection ? { projection: t.projection } : {}),
    ...(t.fields?.length ? { fields: t.fields.map((f) => ({ ...f })) } : {}),
    ...(t.places !== undefined ? { places: t.places } : {}),
    ...(t.decimalComma ? { decimalComma: true as const } : {}),
    ...(t.dualUnits ? { dualUnits: true as const } : {}),
  };
  if (next.sheet !== d.sheet) next = withoutFit(next);
  if ((next.projection === "third") !== (d.projection === "third")) next = arrangeLinedUp(next);
  return next;
}

/** Templates read from storage (anything odd left out). */
export function parseTemplates(raw: unknown): DrawingTemplate[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DrawingTemplate[] = [];
  for (const item of list.slice(0, MAX_TEMPLATES)) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || out.some((t) => t.id === r.id)) continue;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : "My template";
    const t = (r.title ?? {}) as Record<string, unknown>;
    const title: TemplateTitle = {};
    for (const k of TEMPLATE_TITLE_KEYS) if (typeof t[k] === "string" && (t[k] as string).trim()) title[k] = (t[k] as string).slice(0, 200);
    out.push({
      id: r.id,
      name,
      sheet: SHEET_SIZES.includes(r.sheet as SheetSize) ? (r.sheet as SheetSize) : "A4",
      ...(r.standard === "ansi" ? { standard: "ansi" as const } : {}),
      ...(r.projection === "third" ? { projection: "third" as const } : {}),
      title,
      ...parseFields(r.fields),
      ...(typeof r.places === "number" && [0, 1, 2, 3, 4].includes(r.places) ? { places: r.places } : {}),
      ...(r.decimalComma === true ? { decimalComma: true as const } : {}),
      ...(r.dualUnits === true ? { dualUnits: true as const } : {}),
    });
  }
  return out;
}

/** Templates written for storage (JSON). */
export function serializeTemplates(list: DrawingTemplate[]): string {
  return JSON.stringify(list.slice(0, MAX_TEMPLATES));
}

/** Add a template, or replace the one with the same name (keeping its id). */
export function putTemplate(list: DrawingTemplate[], t: DrawingTemplate): DrawingTemplate[] {
  const same = list.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
  if (same) return list.map((x) => (x === same ? { ...t, id: same.id } : x));
  return [...list, t].slice(-MAX_TEMPLATES);
}
