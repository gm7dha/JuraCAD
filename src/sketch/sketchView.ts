/**
 * What the open sketch shows (Onshape's sketch "Show constraints / Show dimensions / Show expressions" and Shift+P for
 * construction geometry), and the shortcut keys for relations and a few tools. Pure: the app keeps the settings in
 * localStorage (`juracad.sketchView`), as Onshape remembers them; construction hidden is for this session only.
 */
import { evaluate } from "../model/expr";
import { curvePoints, type RelationTool } from "./ops";
import type { SketchConstraint, SketchData } from "./types";

export interface SketchViewSettings {
  /** Relation badges (parallel, equal…) on show. */
  constraints: boolean;
  /** Dimensions (their lines and numbers) on show. */
  dimensions: boolean;
  /** Dimensions show what was typed (a variable or sum) instead of its number. */
  expressions: boolean;
}

export const SKETCH_VIEW_KEY = "juracad.sketchView";
export const SKETCH_VIEW_DEFAULTS: SketchViewSettings = { constraints: true, dimensions: true, expressions: false };

type Reads = { getItem(key: string): string | null } | null | undefined;
type Writes = { setItem(key: string, value: string): void } | null | undefined;

/** The settings kept in this browser (the usual ones when there are none, or they can't be read). */
export function readSketchView(storage: Reads): SketchViewSettings {
  try {
    const raw = storage?.getItem(SKETCH_VIEW_KEY);
    if (!raw) return SKETCH_VIEW_DEFAULTS;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const flag = (k: keyof SketchViewSettings) => (typeof v[k] === "boolean" ? (v[k] as boolean) : SKETCH_VIEW_DEFAULTS[k]);
    return { constraints: flag("constraints"), dimensions: flag("dimensions"), expressions: flag("expressions") };
  } catch {
    return SKETCH_VIEW_DEFAULTS;
  }
}

/** Keep the settings (quietly does nothing where storage isn't allowed). */
export function writeSketchView(storage: Writes, v: SketchViewSettings): void {
  try {
    storage?.setItem(SKETCH_VIEW_KEY, JSON.stringify({ constraints: v.constraints, dimensions: v.dimensions, expressions: v.expressions }));
  } catch {
    // (A private window, or storage turned off.)
  }
}

/** Is a typed value a plain number (with or without a unit), i.e. nothing worth showing as an expression? */
export function isPlainValue(value: string): boolean {
  return /^\s*-?(\d+(\.\d*)?|\.\d+)\s*(mm|cm|m|in|deg|°)?\s*$/.test(value);
}

/** With Show expressions on: what a dimension shows instead of its number (null = show the number as usual). */
export function expressionText(c: SketchConstraint): string | null {
  if (c.driven || c.value === undefined || isPlainValue(c.value)) return null;
  if (!evaluate(c.value).ok) return null;
  return c.value.trim();
}

/** The points and curves a relation or dimension ties, to light up while its badge or number is under the pointer. */
export function tiedIds(s: SketchData, constraintId: string): string[] {
  const c = s.constraints.find((k) => k.id === constraintId);
  if (!c) return [];
  const known = new Set<string>([...s.points.map((p) => p.id), ...s.curves.map((k) => k.id)]);
  return [...new Set(c.refs.filter((r) => known.has(r)))];
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/**
 * Shift+P: what isn't drawn, picked or snapped to — the construction curves, and points used only by them (a construction
 * circle's centre, a centreline's ends). Anything picked stays, so a selection never vanishes; a point also used by a solid
 * curve, a text's anchor or a lone point stays.
 */
export function hiddenConstruction(s: SketchData, selection: readonly string[]): ReadonlySet<string> {
  const picked = new Set(selection);
  const hidden = new Set<string>();
  const shown = new Set<string>((s.texts ?? []).map((t) => t.anchor));
  for (const c of s.curves) {
    const off = !!c.construction && !picked.has(c.id);
    if (off) hidden.add(c.id);
    for (const p of curvePoints(c)) if (!off) shown.add(p);
  }
  if (!hidden.size) return NOTHING_HIDDEN;
  for (const c of s.curves) if (hidden.has(c.id)) for (const p of curvePoints(c)) if (!shown.has(p) && !picked.has(p)) hidden.add(p);
  return hidden;
}

/** A shortcut key in a sketch: `code` names the letter as KeyboardEvent.code does ("KeyI"); see sketchKeyFor. */
export interface SketchKey {
  code: string;
  shift: boolean;
  action: { relation: RelationTool } | { tool: "extend" | "point" } | { toggle: "construction" };
}

/**
 * Onshape's sketch keys that JuraCAD didn't use yet. Plain letters already taken in a sketch (App.tsx's sketchShortcut):
 * L R C A P D S G T O M U Q H V N, and F (fit), so Tangent keeps no key (T is Trim). Shift+A is kept free.
 */
export const SKETCH_KEYS: readonly SketchKey[] = [
  { code: "KeyI", shift: false, action: { relation: "coincident" } },
  { code: "KeyE", shift: false, action: { relation: "equal" } },
  { code: "KeyB", shift: false, action: { relation: "parallel" } },
  { code: "KeyX", shift: false, action: { tool: "extend" } },
  { code: "KeyL", shift: true, action: { relation: "perpendicular" } },
  { code: "KeyO", shift: true, action: { relation: "concentric" } },
  { code: "KeyM", shift: true, action: { relation: "midpoint" } },
  { code: "KeyQ", shift: true, action: { relation: "symmetric" } },
  { code: "KeyJ", shift: true, action: { relation: "fix" } },
  { code: "KeyU", shift: true, action: { relation: "curvature" } },
  { code: "KeyG", shift: true, action: { relation: "pierce" } },
  { code: "KeyS", shift: true, action: { tool: "point" } },
  { code: "KeyP", shift: true, action: { toggle: "construction" } },
];

/**
 * The sketch key pressed. `key` (KeyboardEvent.key) wins when it's a letter, so the letter printed on the key works on any
 * layout (an AZERTY keyboard's M, Q…) just as the sketch's plain letters do; `code` (KeyboardEvent.code) is used when the
 * key gives no Latin letter (a Cyrillic or Greek layout), by where the key sits.
 */
export function sketchKeyFor(code: string, shift: boolean, key?: string): SketchKey | null {
  // A Latin letter: that one. Another script's letter: the key's place. Anything else (a "?" or "," on the key): none.
  const byKey = key === undefined ? code : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\p{L}$/u.test(key) ? code : null;
  if (!byKey) return null;
  return SKETCH_KEYS.find((k) => k.code === byKey && k.shift === shift) ?? null;
}

/** How a key is written in tooltips and menus: "I", "Shift+L". */
export function keyLabel(k: SketchKey): string {
  const letter = k.code.replace(/^Key/, "");
  return k.shift ? `Shift+${letter}` : letter;
}

/** The key for a relation (H and V are the old plain ones), or "" when it has none. */
export function relationKey(r: RelationTool): string {
  if (r === "horizontal") return "H";
  if (r === "vertical") return "V";
  const k = SKETCH_KEYS.find((x) => "relation" in x.action && x.action.relation === r);
  return k ? keyLabel(k) : "";
}
