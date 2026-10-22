/**
 * Standard metric hole sizes (ISO), so a hole can be set up by screw size
 * instead of looking numbers up.
 *
 * - Clearance: the screw passes through freely ("normal" fit, ISO 273).
 * - Tapped: the drill size before cutting a thread (coarse pitch).
 * - Counterbore: sized for socket head cap screws (ISO 4762) to sit below the surface.
 * - Countersink: sized for 90° countersunk screws (ISO 10642) to sit flush.
 */

export type HoleKind = "simple" | "counterbore" | "countersink";
export type HoleFit = "clearance" | "tapped";

export interface ScrewSize {
  name: string;
  /** Coarse thread pitch, mm. */
  pitch: number;
  clearance: number;
  tapDrill: number;
  cboreDiameter: number;
  cboreDepth: number;
  cskDiameter: number;
}

export const SCREW_SIZES: ScrewSize[] = [
  { name: "M2", pitch: 0.4, clearance: 2.4, tapDrill: 1.6, cboreDiameter: 4.4, cboreDepth: 2.4, cskDiameter: 4.4 },
  { name: "M2.5", pitch: 0.45, clearance: 2.9, tapDrill: 2.05, cboreDiameter: 5.5, cboreDepth: 2.9, cskDiameter: 5.5 },
  { name: "M3", pitch: 0.5, clearance: 3.4, tapDrill: 2.5, cboreDiameter: 6.5, cboreDepth: 3.4, cskDiameter: 6.3 },
  { name: "M4", pitch: 0.7, clearance: 4.5, tapDrill: 3.3, cboreDiameter: 8, cboreDepth: 4.4, cskDiameter: 9.4 },
  { name: "M5", pitch: 0.8, clearance: 5.5, tapDrill: 4.2, cboreDiameter: 10, cboreDepth: 5.4, cskDiameter: 10.4 },
  { name: "M6", pitch: 1, clearance: 6.6, tapDrill: 5, cboreDiameter: 11, cboreDepth: 6.4, cskDiameter: 12.6 },
  { name: "M8", pitch: 1.25, clearance: 9, tapDrill: 6.8, cboreDiameter: 15, cboreDepth: 8.6, cskDiameter: 17.3 },
  { name: "M10", pitch: 1.5, clearance: 11, tapDrill: 8.5, cboreDiameter: 18, cboreDepth: 10.6, cskDiameter: 20 },
  { name: "M12", pitch: 1.75, clearance: 13.5, tapDrill: 10.2, cboreDiameter: 20, cboreDepth: 12.6, cskDiameter: 24 },
];

/** Hole sizes (as box values) for a screw size and fit. */
export function standardParams(size: string, fit: HoleFit): Record<string, string> | null {
  const s = SCREW_SIZES.find((x) => x.name === size);
  if (!s) return null;
  return {
    diameter: String(fit === "tapped" ? s.tapDrill : s.clearance),
    cboreDiameter: String(s.cboreDiameter),
    cboreDepth: String(s.cboreDepth),
    cskDiameter: String(s.cskDiameter),
    cskAngle: "90",
  };
}

/** Plain-English summary, e.g. "M4 tapped (M4 × 0.7), 10 mm deep". */
export function describeHole(opts: { kind: HoleKind; standard: string; fit: HoleFit }): string {
  const s = SCREW_SIZES.find((x) => x.name === opts.standard);
  const kind = opts.kind === "counterbore" ? "counterbored" : opts.kind === "countersink" ? "countersunk" : "";
  if (!s) return kind ? `Custom ${kind} hole` : "Custom hole";
  if (opts.fit === "tapped") return `${s.name} tapped hole (thread ${s.name} × ${s.pitch})`;
  return `${s.name} clearance${kind ? `, ${kind}` : ""} hole`;
}

/** One point of a hole's half cross-section: distance from the axis, distance along the drill. */
export type ProfilePoint = [r: number, t: number];

export interface HoleSize {
  kind: HoleKind;
  diameter: number;
  /** Depth of the full-diameter part, from the surface (ignored when through all). */
  depth: number;
  throughAll: boolean;
  /** How far "through all" must reach. */
  throughLength: number;
  /** Through all: also this far back the other way from the sketch (so a sketch inside the part goes right through). */
  backLength?: number;
  /** End flat at `depth` instead of with a drill point (up to next: the drill breaks through there). */
  flatBottom?: boolean;
  /**
   * Tapped holes with the thread modelled: an ISO groove of this pitch round
   * the wall, centred from `from` to `to` mm along the drill (the hole's
   * radius is the tap drill's).
   */
  thread?: { from: number; to: number; pitch: number };
  /** Where the straight (full-diameter) part of the hole starts, below any counterbore or countersink. */
  cboreDiameter: number;
  cboreDepth: number;
  cskDiameter: number;
  /** Countersink angle, degrees (90 for most metric screws). */
  cskAngle: number;
}

/** Drill point angle for blind holes (standard twist drill). */
export const DRILL_POINT_ANGLE = 118;
/** Holes start a whisker above the surface so the cut is always clean. */
export const HOLE_LEAD_IN = 0.05;

/**
 * The hole's half cross-section, going down one side and back up the axis.
 * Revolving it around the axis gives the solid that's cut away.
 * Throws a plain-English error if the sizes don't make sense together.
 */
export function holeProfile(h: HoleSize): ProfilePoint[] {
  const R = h.diameter / 2;
  const bottom = h.throughAll ? h.throughLength : h.depth;
  const back = h.throughAll && h.backLength && h.backLength > HOLE_LEAD_IN ? h.backLength : 0;
  // Through all, both ways: the plain hole also runs back out the other side of the sketch.
  const pts: ProfilePoint[] = !back ? [[0, -HOLE_LEAD_IN]] : h.kind === "simple" ? [[0, -back], [R, -back]] : [[0, -back], [R, -back], [R, -HOLE_LEAD_IN]];
  if (h.kind === "counterbore") {
    if (h.cboreDiameter <= h.diameter) throw new Error("The counterbore must be wider than the hole.");
    if (!h.throughAll && h.cboreDepth >= h.depth) throw new Error("The counterbore must be shallower than the hole.");
    const Rc = h.cboreDiameter / 2;
    pts.push([Rc, -HOLE_LEAD_IN], [Rc, h.cboreDepth], [R, h.cboreDepth]);
  } else if (h.kind === "countersink") {
    if (h.cskDiameter <= h.diameter) throw new Error("The countersink must be wider than the hole.");
    if (!(h.cskAngle > 0 && h.cskAngle < 180)) throw new Error("The countersink angle must be between 0° and 180°.");
    const Rs = h.cskDiameter / 2;
    const sinkDepth = (Rs - R) / Math.tan(((h.cskAngle / 2) * Math.PI) / 180);
    if (!h.throughAll && sinkDepth >= h.depth) throw new Error("The countersink is deeper than the hole.");
    pts.push([Rs + HOLE_LEAD_IN * Math.tan(((h.cskAngle / 2) * Math.PI) / 180), -HOLE_LEAD_IN], [R, sinkDepth]);
  } else if (!back) {
    pts.push([R, -HOLE_LEAD_IN]);
  }
  pts.push([R, bottom]);
  if (!h.throughAll && !h.flatBottom) {
    const tip = R / Math.tan(((DRILL_POINT_ANGLE / 2) * Math.PI) / 180);
    pts.push([0, bottom + tip]);
  } else {
    pts.push([0, bottom]);
  }
  return pts;
}

/** Volume of material a hole removes below the surface (for checks and tests). */
export function holeVolume(h: HoleSize): number {
  // Pappus: volume of revolution of each trapezoid strip between consecutive profile points, from t = 0 down.
  const pts = holeProfile(h);
  let v = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    let [r1, t1] = pts[i];
    let [r2, t2] = pts[i + 1];
    // Only count what's below the surface (t ≥ 0): clip the lead-in.
    if (t1 < 0 && t2 <= 0) continue;
    if (t1 < 0) {
      r1 = r1 + ((r2 - r1) * (0 - t1)) / (t2 - t1);
      t1 = 0;
    }
    if (t2 < 0) {
      r2 = r2 + ((r1 - r2) * (0 - t2)) / (t1 - t2);
      t2 = 0;
    }
    const dt = t2 - t1;
    if (Math.abs(dt) < 1e-12) continue;
    v += (Math.PI * dt * (r1 * r1 + r1 * r2 + r2 * r2)) / 3; // frustum
  }
  return v;
}

/** How far down the drill the straight, full-diameter part of a hole starts (below a counterbore or countersink). */
export function straightStart(h: HoleSize): number {
  if (h.kind === "counterbore") return h.cboreDepth;
  if (h.kind === "countersink") return (h.cskDiameter / 2 - h.diameter / 2) / Math.tan(((h.cskAngle / 2) * Math.PI) / 180);
  return 0;
}
