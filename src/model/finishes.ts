/**
 * Part finishes (Onshape's "Appearance"): how a part's surface looks — matte,
 * shiny, metal, see-through… The colour stays the part's own (`doc.appearance`);
 * a finish only changes the shine. Pure: the 3D view turns these numbers into
 * three.js materials, exports read `exportColours`.
 */
import { DEFAULT_PART_COLOUR, normaliseColour } from "./colours";
import type { JuraCADDocument } from "./types";

export type FinishId = "matte" | "glossy" | "silk" | "brushed" | "polished" | "rubber" | "clear" | "wood";

export interface Finish {
  id: FinishId;
  /** Shown in the colour popover. */
  label: string;
  /** A few words on what it's like. */
  hint: string;
  /** three.js MeshPhysicalMaterial settings (0–1). */
  roughness: number;
  metalness: number;
  /** Below 1: see-through. */
  opacity: number;
  /** A thin shiny coat on top (glossy plastic, silk PLA). */
  clearcoat: number;
  clearcoatRoughness: number;
  /** A soft sheen at glancing angles (silk PLA, rubber). */
  sheen: number;
  /** For the plain everyday view (Phong): shininess and how bright the highlight is (0–1, sRGB; matte's 0.134 is the old 0x222222). */
  shininess: number;
  specular: number;
}

/** The finish of a part nobody has chosen one for: the everyday look, as before. */
export const DEFAULT_FINISH: FinishId = "matte";

export const FINISHES: Finish[] = [
  { id: "matte", label: "Matte plastic", hint: "The usual look", roughness: 0.7, metalness: 0, opacity: 1, clearcoat: 0, clearcoatRoughness: 0, sheen: 0, shininess: 20, specular: 0.134 },
  { id: "glossy", label: "Glossy plastic", hint: "Smooth and shiny", roughness: 0.25, metalness: 0, opacity: 1, clearcoat: 0.8, clearcoatRoughness: 0.08, sheen: 0, shininess: 90, specular: 0.45 },
  { id: "silk", label: "Silk PLA", hint: "Pearly shine, as silk filament", roughness: 0.35, metalness: 0.35, opacity: 1, clearcoat: 0.6, clearcoatRoughness: 0.2, sheen: 0.6, shininess: 60, specular: 0.5 },
  { id: "brushed", label: "Brushed metal", hint: "Satin metal, soft reflections", roughness: 0.42, metalness: 1, opacity: 1, clearcoat: 0, clearcoatRoughness: 0, sheen: 0, shininess: 45, specular: 0.55 },
  { id: "polished", label: "Polished metal", hint: "Mirror-like metal", roughness: 0.08, metalness: 1, opacity: 1, clearcoat: 0, clearcoatRoughness: 0, sheen: 0, shininess: 140, specular: 0.85 },
  { id: "rubber", label: "Rubber", hint: "Soft and dull, like TPU", roughness: 0.95, metalness: 0, opacity: 1, clearcoat: 0, clearcoatRoughness: 0, sheen: 0.25, shininess: 4, specular: 0.03 },
  { id: "clear", label: "Clear (see-through)", hint: "Like clear PETG or resin", roughness: 0.1, metalness: 0, opacity: 0.35, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0, shininess: 110, specular: 0.7 },
  { id: "wood", label: "Wood-ish", hint: "Warm and dull, brown by default", roughness: 0.78, metalness: 0, opacity: 1, clearcoat: 0.15, clearcoatRoughness: 0.5, sheen: 0, shininess: 12, specular: 0.08 },
];

const BY_ID = new Map(FINISHES.map((f) => [f.id, f]));

export const isFinishId = (v: unknown): v is FinishId => typeof v === "string" && BY_ID.has(v as FinishId);

/** The finish for an id (missing or unknown = matte). */
export const finishOf = (id: string | undefined): Finish => BY_ID.get(id as FinishId) ?? BY_ID.get(DEFAULT_FINISH)!;

/**
 * A colour that suits a finish when the part has none of its own: wood is
 * brown, metals steel-grey; the rest keep the usual grey.
 */
export function suggestedColour(id: FinishId): string | null {
  if (id === "wood") return "#b07a4a";
  if (id === "brushed" || id === "polished") return "#b9c0c7";
  return null;
}

/** Finishes by part from untrusted JSON (unknown names and the default are dropped). */
export function parseFinishes(raw: unknown): Record<string, FinishId> {
  const out: Record<string, FinishId> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (isFinishId(v) && v !== DEFAULT_FINISH) out[id] = v;
  return out;
}

/** The document with a part's finish set (null or matte = back to the usual look). Old documents without any stay without the field. */
export function setFinishIn(doc: JuraCADDocument, partId: string, finish: FinishId | null): JuraCADDocument {
  const finishes = { ...(doc.finishes ?? {}) };
  if (finish && finish !== DEFAULT_FINISH) finishes[partId] = finish;
  else delete finishes[partId];
  const { finishes: _old, ...rest } = doc;
  return Object.keys(finishes).length ? { ...rest, finishes } : rest;
}

/** "#rrggbb" + opacity 0–1 → "#rrggbbaa" (opacity 1 = plain "#rrggbb"). */
export function withAlpha(hex: string, opacity: number): string {
  const c = normaliseColour(hex) ?? DEFAULT_PART_COLOUR;
  if (opacity >= 1) return c;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return c + a.toString(16).padStart(2, "0");
}

/**
 * The colours to write into 3MF and STEP files, by part id: each part's own
 * colour, and see-through parts as "#rrggbbaa" (both formats can carry how
 * see-through a colour is). Parts with neither are left out, as before.
 */
export function exportColours(doc: Pick<JuraCADDocument, "appearance" | "finishes">): Record<string, string> {
  const out: Record<string, string> = { ...(doc.appearance ?? {}) };
  for (const [id, f] of Object.entries(doc.finishes ?? {})) {
    const finish = finishOf(f);
    if (finish.opacity < 1) out[id] = withAlpha(out[id] ?? DEFAULT_PART_COLOUR, finish.opacity);
  }
  return out;
}

/** Finishes for an assembly's copies: each copy's mesh key gets its part's finish. */
export function finishesByKey(finishes: Record<string, FinishId>, keys: { key: string; partId: string }[]): Record<string, FinishId> {
  const out: Record<string, FinishId> = {};
  for (const k of keys) if (finishes[k.partId]) out[k.key] = finishes[k.partId];
  return out;
}

/** A finish typed in words: its id ("brushed") or its name ("Brushed metal"), any case; undefined if not understood. */
export function finishFromWords(value: string): FinishId | undefined {
  const v = value.trim().toLowerCase().replace(/[()]/g, "");
  if (isFinishId(v)) return v;
  return FINISHES.find((f) => f.label.toLowerCase().replace(/[()]/g, "") === v || f.label.toLowerCase().startsWith(v + " "))?.id;
}

/** The document with a part's own colour set (null = back to the usual grey), as the colour swatch does. */
export function setColourIn(doc: JuraCADDocument, partId: string, colour: string | null): JuraCADDocument {
  const appearance = { ...(doc.appearance ?? {}) };
  if (colour) appearance[partId] = colour;
  else delete appearance[partId];
  const { appearance: _old, ...rest } = doc;
  return Object.keys(appearance).length ? { ...rest, appearance } : rest;
}

/**
 * Choosing a finish for parts (one undo step): each gets the finish, and a part
 * still in the usual grey also gets a colour that suits it (wood brown, metal
 * steel). Parts with their own colour keep it.
 */
export function chooseFinish(doc: JuraCADDocument, partIds: string[], finish: FinishId | null): JuraCADDocument {
  let out = doc;
  for (const id of partIds) {
    out = setFinishIn(out, id, finish);
    const suggested = finish ? suggestedColour(finish) : null;
    if (suggested && !out.appearance?.[id]) out = setColourIn(out, id, suggested);
  }
  return out;
}
