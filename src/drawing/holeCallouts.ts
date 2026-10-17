/**
 * Hole callouts: a leader pointing at a hole with its description, the way
 * drawings usually give holes — e.g. "4× Ø6.6 THRU" with "CBORE Ø11 × 6.4 DEEP"
 * underneath, or "Ø5 × 10 DEEP" / "M6 × 1 TAP" for a tapped hole. The engine
 * finds the holes (sizes, depth, through or not); the words are put together here,
 * so they follow the part when it changes.
 */
import type { ViewHole, ViewProjection } from "../kernel/protocol";
import { evaluate } from "../model/expr";
import { SCREW_SIZES } from "../model/holes";
import { allFeatures, studioOfFeature, studioFeatures } from "../model/studios";
import type { Drawing, Feature, JuraCADDocument } from "../model/types";
import { styledLength, type DimStyle } from "./dimensions";

type P2 = [number, number];

/** A tapped hole size used in the design: its drill diameter and the thread it's for. */
export interface TapSize {
  drill: number;
  thread: string;
  /** The thread's outside (nominal) diameter, e.g. 6 for M6. */
  major: number;
}

/** Tapped hole sizes made by the Hole features that could be on this drawing's part. */
export function tapSizes(doc: JuraCADDocument, drawing: Pick<Drawing, "source">): TapSize[] {
  if (drawing.source?.kind !== "part") return [];
  const studio = studioOfFeature(doc, drawing.source.id);
  const features: Feature[] = studio ? studioFeatures(doc, studio) : allFeatures(doc);
  const out: TapSize[] = [];
  for (const f of features) {
    if (f.type !== "hole" || f.suppressed || f.hole?.fit !== "tapped") continue;
    const size = SCREW_SIZES.find((s) => s.name === f.hole!.standard);
    if (!size) continue;
    const d = evaluate(f.params.diameter ?? "");
    out.push({ drill: d.ok ? d.value : size.tapDrill, thread: `${size.name} × ${size.pitch}`, major: Number(size.name.slice(1)) });
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** The hole on a view whose opening is centred at `at` (view mm). */
export function holeAt(p: ViewProjection, at: P2): ViewHole | null {
  return (p.holes ?? []).find((h) => Math.hypot(h.cx - at[0], h.cy - at[1]) < 1e-3) ?? null;
}

/** Is a circle (centre, radius) on a view part of a hole — the hole itself, or its counterbore or countersink? */
export function holeOfCircle(p: ViewProjection, at: P2, r: number): ViewHole | null {
  const h = holeAt(p, at);
  if (!h) return null;
  const sizes = [h.d, h.cbore?.diameter, h.csk?.diameter].filter((d): d is number => d !== undefined);
  return sizes.some((d) => near(d / 2, r)) ? h : null;
}

const same = (a: ViewHole, b: ViewHole) =>
  near(a.d, b.d) &&
  a.through === b.through &&
  (a.through || near(a.depth, b.depth)) &&
  near(a.cbore?.diameter ?? 0, b.cbore?.diameter ?? 0) &&
  near(a.cbore?.depth ?? 0, b.cbore?.depth ?? 0) &&
  near(a.csk?.diameter ?? 0, b.csk?.diameter ?? 0);

/** How many holes on the view are just like this one. */
export function matchingHoles(p: ViewProjection, h: ViewHole): number {
  return (p.holes ?? []).filter((x) => same(x, h)).length;
}

/**
 * The lines of a hole's callout (lengths in the drawing's units, with its
 * decimal places and both units if it asks; the thread name stays as it is).
 */
export function calloutLines(h: ViewHole, count: number, taps: TapSize[], style: DimStyle = {}): string[] {
  const n = (v: number, sign = "") => styledLength(v, style, sign);
  const many = count > 1 ? `${count}× ` : "";
  const deep = h.through ? " THRU" : ` × ${n(h.depth)} DEEP`;
  const lines = [`${many}${n(h.d, "Ø")}${deep}`];
  const tap = taps.find((t) => near(t.drill, h.d));
  if (tap) lines.push(`${tap.thread} TAP${h.through ? " THRU" : ""}`);
  if (h.cbore) lines.push(`CBORE ${n(h.cbore.diameter, "Ø")} × ${n(h.cbore.depth)} DEEP`);
  if (h.csk) lines.push(`CSK ${n(h.csk.diameter, "Ø")} × ${Math.round(h.csk.angle)}°`);
  return lines;
}

/** A callout dimension's text, worked out from the hole as the part is now (null: the hole is gone). */
export function calloutText(p: ViewProjection, centre: P2, taps: TapSize[], style: DimStyle = {}): string[] | null {
  const h = holeAt(p, centre);
  return h ? calloutLines(h, matchingHoles(p, h), taps, style) : null;
}

/**
 * Thread symbols for tapped holes, drawn the standard way (ISO 6410): seen
 * end-on, a thin three-quarter circle at the thread's outside diameter; seen
 * from the side, thin lines along the hole at that diameter (hidden, as
 * they're inside the part). View mm.
 */
export function threadSymbols(p: ViewProjection, taps: TapSize[]): { endOn: number[][]; side: number[][] } {
  const endOn: number[][] = [];
  const side: number[][] = [];
  if (!taps.length) return { endOn, side };
  const tapFor = (d: number) => taps.find((t) => near(t.drill, d) && t.major > d);
  for (const h of p.holes ?? []) {
    const t = tapFor(h.d);
    if (!t) continue;
    // Three quarters round, leaving the top-right quarter open.
    const r = t.major / 2;
    const arc: number[] = [];
    const steps = 36;
    for (let i = 0; i <= steps; i++) {
      const a = Math.PI / 2 + (i / steps) * (1.5 * Math.PI);
      arc.push(h.cx + r * Math.cos(a), h.cy + r * Math.sin(a));
    }
    endOn.push(arc);
  }
  for (const h of p.sideHoles ?? []) {
    const t = tapFor(h.d);
    if (!t) continue;
    const dx = h.b[0] - h.a[0];
    const dy = h.b[1] - h.a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const nx = (-dy / L) * (t.major / 2);
    const ny = (dx / L) * (t.major / 2);
    side.push([h.a[0] + nx, h.a[1] + ny, h.b[0] + nx, h.b[1] + ny], [h.a[0] - nx, h.a[1] - ny, h.b[0] - nx, h.b[1] - ny]);
  }
  return { endOn, side };
}
