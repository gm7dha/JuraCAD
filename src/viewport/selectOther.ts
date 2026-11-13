/**
 * Select other (Onshape's click-and-hold, or right-click › Select other): everything under the pointer, front to back,
 * as a short list to choose from. Pure: SceneManager gathers the raw hits, this orders, filters and names them.
 */
import { allows, partHitAs, type FilterKind, type SelectFilter } from "./selectionFilter";

/** One thing under the pointer, as SceneManager found it (`distance` along the ray, world units). */
interface OnPart {
  partId: string;
  index: number;
  distance: number;
  point: [number, number, number];
  local: [number, number, number];
}

export type PartHit = (OnPart & { kind: "face" }) | (OnPart & { kind: "edge" });

export type OtherHit =
  | PartHit
  | { kind: "plane"; plane: string; distance: number }
  | { kind: "customPlane"; id: string; distance: number }
  | { kind: "sketchArea"; sketch: string; index: number; distance: number }
  | { kind: "curve"; id: string; distance: number; point: [number, number, number] }
  /** A mate connector drawn for the tool open (its key, as setConnectorMarks gave it). */
  | { kind: "connector"; key: string; distance: number }
  /** A straight sketch line a mirror or pattern can take (its sketch's feature id and the line's id). */
  | { kind: "sketchLine"; sketch: string; line: string; distance: number };

/** A choice in the list: the hit, or a whole part (`whole`). */
export type OtherChoice = OtherHit | { kind: "part"; whole: true; partId: string; distance: number; via: PartHit };

/** The most rows the list shows. */
export const MOST_CHOICES = 16;

/** Two hits nearer than this (as a share of the nearest distance, or absolutely) count as at the same place. */
const SAME_PLACE = 1e-6;

const filterKind = (h: OtherHit): FilterKind =>
  h.kind === "face" || h.kind === "edge" ? h.kind : h.kind === "sketchArea" || h.kind === "curve" || h.kind === "sketchLine" ? "sketch" : "plane";

/** Which comes first at the same distance: edges sit on faces, so they're listed first; planes after parts. */
const RANK: Record<OtherHit["kind"], number> = { connector: 0, edge: 1, sketchLine: 2, curve: 3, sketchArea: 4, face: 5, customPlane: 6, plane: 7 };

export function choiceKey(c: OtherChoice): string {
  if (c.kind === "part") return `part:${c.partId}`;
  if (c.kind === "face" || c.kind === "edge") return `${c.kind}:${c.partId}:${c.index}`;
  if (c.kind === "plane") return `plane:${c.plane}`;
  if (c.kind === "customPlane") return `customPlane:${c.id}`;
  if (c.kind === "sketchArea") return `area:${c.sketch}:${c.index}`;
  if (c.kind === "connector") return `connector:${c.key}`;
  if (c.kind === "sketchLine") return `line:${c.sketch}:${c.line}`;
  return `curve:${c.id}`;
}

/**
 * The list: front to back (edges before the face they lie on), each thing once, only what the filter allows, then
 * each part met (once, after its faces and edges), at most `MOST_CHOICES`. `wholeParts`: whole parts can be chosen now.
 */
export function orderChoices(hits: OtherHit[], filter: SelectFilter, wholeParts = true): OtherChoice[] {
  const sorted = [...hits].sort((a, b) => {
    const gap = a.distance - b.distance;
    if (Math.abs(gap) > SAME_PLACE * Math.max(1, Math.abs(a.distance))) return gap;
    return RANK[a.kind] - RANK[b.kind];
  });
  const out: OtherChoice[] = [];
  const seen = new Set<string>();
  const parts: OtherChoice[] = [];
  const add = (c: OtherChoice, list: OtherChoice[]) => {
    const key = choiceKey(c);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(c);
  };
  for (const h of sorted) {
    if (h.kind === "face" || h.kind === "edge") {
      const as = partHitAs(filter, h.kind, wholeParts);
      if (as === "self") add(h, out);
      if (wholeParts && allows(filter, "part")) add({ kind: "part", whole: true, partId: h.partId, distance: h.distance, via: h }, parts);
      continue;
    }
    if (allows(filter, filterKind(h))) add(h, out);
  }
  // Whole parts go after the faces and edges, nearest first (as Onshape lists bodies after their faces).
  return [...out, ...parts].slice(0, MOST_CHOICES);
}

/** What a face or edge looks like, in a word ("flat", "round"…), from its exact surface or curve type. */
export function shapeWord(kind: "face" | "edge", type: string | undefined): string {
  const t = (type ?? "").toUpperCase();
  if (kind === "face") {
    if (t === "PLANE") return "flat";
    if (t.startsWith("CYLIND")) return "round";
    if (t === "CONE") return "cone";
    if (t === "SPHERE") return "ball";
    if (t === "TORUS") return "ring";
    return t ? "curved" : "";
  }
  if (t === "LINE") return "straight";
  if (t === "CIRCLE") return "round";
  if (t === "ELLIPSE") return "oval";
  return t ? "curved" : "";
}

export interface ChoiceNames {
  part: (id: string) => string;
  /** A Plane feature, sketch or curve feature by its feature id. */
  feature: (id: string) => string;
  /** The face's surface or edge's curve type (e.g. "PLANE", "LINE"), if known. */
  shape?: (kind: "face" | "edge", partId: string, index: number) => string | undefined;
  /** A mate connector's name, by its key. */
  connector?: (key: string) => string;
}

/** The row's words: "Flat face of Part 1", "Straight edge of Part 1", "Part 1 (whole part)", "Top plane", "Area of Sketch 2"… */
export function choiceLabel(c: OtherChoice, names: ChoiceNames): string {
  if (c.kind === "part") return `${names.part(c.partId)} (whole part)`;
  if (c.kind === "face" || c.kind === "edge") {
    const word = shapeWord(c.kind, names.shape?.(c.kind, c.partId, c.index));
    const what = word ? `${word.charAt(0).toUpperCase()}${word.slice(1)} ${c.kind}` : c.kind === "face" ? "Face" : "Edge";
    return `${what} of ${names.part(c.partId)}`;
  }
  if (c.kind === "plane") return `${c.plane} plane`;
  if (c.kind === "customPlane") return names.feature(c.id);
  if (c.kind === "sketchArea") return `Area of ${names.feature(c.sketch)}`;
  if (c.kind === "connector") return names.connector?.(c.key) ?? "Mate connector";
  if (c.kind === "sketchLine") return `Line in ${names.feature(c.sketch)}`;
  return names.feature(c.id);
}
