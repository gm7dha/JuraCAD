/**
 * Selection filter (Onshape's filter toolbar): limit what clicks, hovering and
 * box selection in a Part Studio's 3D view can pick. Nothing chosen (the usual
 * way) = everything. Kept for this session only, never in the file.
 */

/** What can be picked: faces, edges, whole parts, planes (and mate connectors), and sketches (areas, lines, curves). */
export type FilterKind = "face" | "edge" | "part" | "plane" | "sketch";

/** The kinds chosen; empty = everything (no filter). */
export type SelectFilter = readonly FilterKind[];

export const NO_FILTER: SelectFilter = [];

export const FILTER_OPTIONS: { kind: FilterKind; label: string; hint: string }[] = [
  { kind: "face", label: "Faces", hint: "Flat or curved faces of parts" },
  { kind: "edge", label: "Edges", hint: "Edges of parts" },
  { kind: "part", label: "Parts", hint: "A click on a part picks the whole part" },
  { kind: "plane", label: "Planes", hint: "Top, Front, Right, your planes and mate connectors" },
  { kind: "sketch", label: "Sketches", hint: "Areas, lines and curves of sketches" },
];

/** Is anything filtered out? */
export const filtering = (f: SelectFilter) => f.length > 0;

/** May this kind be picked as itself? */
export const allows = (f: SelectFilter, kind: FilterKind) => f.length === 0 || f.includes(kind);

/**
 * What a hit on a part's face or edge becomes: itself, the whole part (when its own kind is filtered out but parts
 * aren't), or nothing. `wholeOk`: whole parts can be picked now (nothing open); otherwise "part" counts as faces and edges,
 * so a tool that needs them still works.
 */
export function partHitAs(f: SelectFilter, kind: "face" | "edge", wholeOk = true): "self" | "whole" | null {
  if (f.length === 0) return "self";
  if (f.includes(kind)) return "self";
  if (f.includes("part")) return wholeOk ? "whole" : "self";
  return null;
}

/** The kinds turned on or off (all of them ticked = no filter at all). */
export function toggleFilter(f: SelectFilter, kind: FilterKind): SelectFilter {
  const next = f.includes(kind) ? f.filter((k) => k !== kind) : [...f, kind];
  const ordered = FILTER_OPTIONS.map((o) => o.kind).filter((k) => next.includes(k));
  return ordered.length === FILTER_OPTIONS.length ? NO_FILTER : ordered;
}

/** A short description for the button: "Everything", "Faces", "Faces and edges"… */
export function filterSummary(f: SelectFilter): string {
  if (f.length === 0) return "Everything";
  const names = FILTER_OPTIONS.filter((o) => f.includes(o.kind)).map((o) => o.label.toLowerCase());
  const text = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a box selection picks: whole parts (the usual way, and with Parts chosen), or faces / edges when the filter
 * asks only for those.
 */
export function boxPicks(f: SelectFilter): { parts: boolean; faces: boolean; edges: boolean } {
  if (f.length === 0 || f.includes("part")) return { parts: true, faces: false, edges: false };
  return { parts: false, faces: f.includes("face"), edges: f.includes("edge") };
}
