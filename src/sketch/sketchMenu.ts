/**
 * The sketch's right-click menu (Onshape's): what it offers for the selection, and what's under the pointer for
 * "Select other". Pure — the app draws it (src/app/SketchContextMenu.tsx) and runs the choices.
 */
import { distToCurve } from "./hit";
import { ALL_RELATIONS, RELATION_LABELS, relationsFor, type RelationTool } from "./ops";
import { canBeCentreline, canSwitchRound } from "./dimensionKinds";
import { relationKey } from "./sketchView";
import { isDimension, ORIGIN_ID, type SketchData } from "./types";

export type SketchMenuAction =
  | { kind: "finish" }
  | { kind: "relation"; relation: RelationTool }
  | { kind: "construction" }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "delete" }
  | { kind: "roundSwitch" }
  | { kind: "centreline"; on: boolean }
  | { kind: "showConstraints" }
  | { kind: "showDimensions" }
  | { kind: "selectOther" };

export interface SketchMenuItem {
  label: string;
  /** Its shortcut, shown at the right. */
  key?: string;
  action: SketchMenuAction;
  /** A line above it. */
  divider?: boolean;
}

export interface SketchMenuContext {
  /** A shape is half drawn (a spline being clicked…): Finish ends it. */
  busy: boolean;
  /** Something copied can be pasted. */
  canPaste: boolean;
  showConstraints: boolean;
  showDimensions: boolean;
  /** How many things are under the pointer (Select other is offered for two or more). */
  under: number;
}

/** The menu for this selection, in Onshape's order: finish, relations, the selection's own choices, edit, view. */
export function sketchMenuItems(s: SketchData, selection: string[], ctx: SketchMenuContext): SketchMenuItem[] {
  const out: SketchMenuItem[] = [];
  const groups: SketchMenuItem[][] = [];
  if (ctx.busy) groups.push([{ label: "Finish", key: "Esc", action: { kind: "finish" } }]);
  const rels = relationsFor(s, selection);
  if (rels.length) groups.push(rels.map((r) => ({ label: RELATION_LABELS[r], key: relationKey(r) || undefined, action: { kind: "relation", relation: r } })));
  const own: SketchMenuItem[] = [];
  const curves = selection.filter((id) => s.curves.some((c) => c.id === id));
  if (curves.length) {
    const toSolid = curves.every((id) => s.curves.find((c) => c.id === id)?.construction);
    own.push({ label: toSolid ? "Make it solid (not construction)" : "Make it construction", key: "Q", action: { kind: "construction" } });
  }
  const dims = selection.map((id) => s.constraints.find((c) => c.id === id)).filter((c) => !!c && isDimension(c));
  if (dims.length === 1 && selection.length === 1) {
    const d = dims[0]!;
    if (canSwitchRound(s, d)) own.push({ label: d.type === "diameter" ? "Show as a radius" : "Show as a diameter", action: { kind: "roundSwitch" } });
    if (canBeCentreline(s, d)) own.push({ label: d.doubled ? "Measure to the centreline" : "Measure as a diameter (across the centreline)", action: { kind: "centreline", on: !d.doubled } });
  }
  if (own.length) groups.push(own);
  const edit: SketchMenuItem[] = [];
  if (selection.length) edit.push({ label: "Copy", key: "Ctrl+C", action: { kind: "copy" } });
  if (ctx.canPaste) edit.push({ label: "Paste", key: "Ctrl+V", action: { kind: "paste" } });
  if (selection.length) edit.push({ label: "Delete", key: "Del", action: { kind: "delete" } });
  if (edit.length) groups.push(edit);
  const view: SketchMenuItem[] = [
    { label: ctx.showConstraints ? "Hide all constraints" : "Show all constraints", action: { kind: "showConstraints" } },
    { label: ctx.showDimensions ? "Hide all dimensions" : "Show all dimensions", action: { kind: "showDimensions" } },
  ];
  if (ctx.under >= 2) view.push({ label: "Select other…", action: { kind: "selectOther" } });
  groups.push(view);
  for (const g of groups) g.forEach((item, i) => out.push(i === 0 && out.length ? { ...item, divider: true } : item));
  return out;
}

/** Everything of the sketch within `tol` mm of (x, y): points first, then curves, each nearest first. */
export function sketchHitsAt(s: SketchData, x: number, y: number, tol: number): string[] {
  const pts: [string, number][] = [];
  for (const p of s.points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= tol) pts.push([p.id, d]);
  }
  const crv: [string, number][] = [];
  for (const c of s.curves) {
    let d = Infinity;
    try {
      d = distToCurve(s, c, x, y);
    } catch {
      continue;
    }
    if (d <= tol) crv.push([c.id, d]);
  }
  const near = (a: [string, number], b: [string, number]) => a[1] - b[1];
  return [...pts.sort(near), ...crv.sort(near)].map(([id]) => id).filter((id) => id !== ORIGIN_ID);
}

/** The words for one thing in the Select other list: "Line", "Point", "Construction circle"… */
export function sketchItemLabel(s: SketchData, id: string): string {
  if (s.points.some((p) => p.id === id)) return "Point";
  const c = s.curves.find((k) => k.id === id);
  if (!c) return "Item";
  const name = c.type === "spline" ? (c.conic !== undefined ? "Conic" : "Spline") : c.type === "ellipse" ? (c.start ? "Part of an ellipse" : "Ellipse") : c.type[0].toUpperCase() + c.type.slice(1);
  return c.construction ? `Construction ${name.toLowerCase()}` : name;
}

/** Every relation the menu might offer (for tests and tooltips). */
export const MENU_RELATIONS = ALL_RELATIONS;
