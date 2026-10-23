import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { PreviewShape, SketchTransient } from "../sketch/controller";
import { dimensionLayout } from "../sketch/layout";
import { ellipsePoints, pointPos, radiusOf, splineHandleEnds, splinePath, splinePoints } from "../sketch/ops";
import { planeFrame, toWorld, type PlaneFrame, type SketchPlane } from "../sketch/planes";
import type { SketchAnalysis } from "../sketch/solver";
import { isDimension, type SketchCurve, type SketchData } from "../sketch/types";
import { refSketch, type RefEdge } from "../sketch/links";

export const SKETCH_COLOURS = {
  free: new THREE.Color("#1f6fd1"),
  defined: new THREE.Color("#161b21"),
  selected: new THREE.Color("#ff7a00"),
  hover: new THREE.Color("#ffad4d"),
  conflict: new THREE.Color("#d1373a"),
  inactive: new THREE.Color("#5b6672"),
  preview: new THREE.Color("#1f6fd1"),
  dimension: new THREE.Color("#4b5866"),
  /** Spline handles: the dots and lines you drag to reshape a curve. */
  handle: new THREE.Color("#2bb673"),
  /** Edges of the part face the sketch is on (faint, like Onshape's). */
  reference: new THREE.Color("#9aa6b2"),
  /** The middle of a line or centre of a circle under the pointer. */
  hint: new THREE.Color("#ff7a00"),
};

/** Sketch colours for a dark or light background (fully defined lines are black on light, near-white on dark). */
export function setSketchTheme(dark: boolean): void {
  SKETCH_COLOURS.defined.set(dark ? "#eef2f6" : "#161b21");
  SKETCH_COLOURS.inactive.set(dark ? "#8d99a6" : "#5b6672");
  SKETCH_COLOURS.dimension.set(dark ? "#b4bec9" : "#4b5866");
  SKETCH_COLOURS.free.set(dark ? "#5aa0ff" : "#1f6fd1");
  SKETCH_COLOURS.preview.set(dark ? "#5aa0ff" : "#1f6fd1");
  SKETCH_COLOURS.reference.set(dark ? "#6c7884" : "#a9b3bd");
}

export interface ActiveSketch {
  plane: SketchPlane;
  data: SketchData;
  analysis: SketchAnalysis;
  /** Constraints that aren't satisfied: drawn red. */
  failing: Set<string>;
  selection: Set<string>;
  /** Edges of the part face it's on, shown faintly to snap to and use. */
  refs?: RefEdge[];
}

type Pt = [number, number];

/** Sample a curve into 2D line segments. */
function curveSegments(s: SketchData, c: SketchCurve): [Pt, Pt][] {
  if (c.type === "line") return [[pointPos(s, c.p1), pointPos(s, c.p2)]];
  if (c.type === "spline" || c.type === "ellipse") {
    const pts = c.type === "spline" ? splinePath(s, c) : ellipsePoints(s, c);
    return pts.slice(1).map((q, i) => [pts[i], q] as [Pt, Pt]);
  }
  const [cx, cy] = pointPos(s, c.center);
  const r = radiusOf(s, c);
  let a0 = 0;
  let a1 = 2 * Math.PI;
  if (c.type === "arc") {
    const [sx, sy] = pointPos(s, c.start);
    const [ex, ey] = pointPos(s, c.end);
    a0 = Math.atan2(sy - cy, sx - cx);
    a1 = Math.atan2(ey - cy, ex - cx);
    while (a1 <= a0) a1 += 2 * Math.PI;
  }
  return arcSegments([cx, cy], r, a0, a1);
}

function arcSegments(c: Pt, r: number, a0: number, a1: number): [Pt, Pt][] {
  const steps = Math.max(12, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 96));
  const out: [Pt, Pt][] = [];
  let prev: Pt = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const p: Pt = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    out.push([prev, p]);
    prev = p;
  }
  return out;
}

function previewSegments(p: PreviewShape): [Pt, Pt][] {
  if (p.kind === "line" || p.kind === "guide") return [[p.a, p.b]];
  if (p.kind === "circle") return arcSegments(p.c, p.r, 0, 2 * Math.PI);
  let a1 = p.a1;
  while (a1 <= p.a0) a1 += 2 * Math.PI;
  return arcSegments(p.c, p.r, p.a0, a1);
}

/** A batch of fat line segments with one colour per segment. */
class FatLines {
  readonly object: LineSegments2;
  readonly material: LineMaterial;
  constructor(width: number, opts: { dashed?: boolean; depthTest?: boolean; renderOrder?: number } = {}) {
    this.material = new LineMaterial({
      linewidth: width,
      vertexColors: true,
      dashed: !!opts.dashed,
      dashSize: 3,
      gapSize: 2,
      depthTest: opts.depthTest ?? true,
      transparent: true,
    });
    this.object = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.object.renderOrder = opts.renderOrder ?? 0;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }
  set(frame: PlaneFrame | null, segments: [Pt, Pt][], colours: THREE.Color[], offset = 0) {
    if (!frame || segments.length === 0) {
      this.object.visible = false;
      return;
    }
    const pos: number[] = [];
    const col: number[] = [];
    segments.forEach(([a, b], i) => {
      pos.push(...toWorld(frame, a[0], a[1], offset), ...toWorld(frame, b[0], b[1], offset));
      const c = colours[i];
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    });
    this.object.geometry.dispose();
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    this.object.geometry = g;
    if (this.material.dashed) this.object.computeLineDistances();
    this.object.visible = true;
  }
  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Draws sketches in the viewport: finished sketches as thin grey lines, and
 * the sketch being edited with Onshape-style colours, its points, dimension
 * lines, and the live preview of the tool in use.
 */
export class SketchLayer {
  readonly group = new THREE.Group();
  private readonly others = new FatLines(1.5);
  private readonly othersConstruction = new FatLines(1.2, { dashed: true });
  private readonly solid = new FatLines(2.4, { depthTest: false, renderOrder: 20 });
  private readonly construction = new FatLines(1.8, { dashed: true, depthTest: false, renderOrder: 20 });
  private readonly dims = new FatLines(1.2, { depthTest: false, renderOrder: 19 });
  private readonly preview = new FatLines(1.8, { dashed: true, depthTest: false, renderOrder: 21 });
  private readonly refLines = new FatLines(1.6, { depthTest: false, renderOrder: 18 });
  private readonly points: THREE.Points;
  private readonly snapMarker: THREE.Points;
  private readonly hintMarkers: THREE.Points;
  private active: ActiveSketch | null = null;
  private transient: SketchTransient | null = null;
  private activeFrame: PlaneFrame | null = null;

  constructor() {
    this.points = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }),
    );
    this.points.renderOrder = 22;
    this.points.frustumCulled = false;
    this.snapMarker = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 12, sizeAttenuation: false, color: "#ff7a00", depthTest: false, transparent: true, opacity: 0.7 }),
    );
    this.snapMarker.renderOrder = 23;
    this.snapMarker.frustumCulled = false;
    this.hintMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: SKETCH_COLOURS.hint, depthTest: false, transparent: true, opacity: 0.85 }),
    );
    this.hintMarkers.renderOrder = 23;
    this.hintMarkers.frustumCulled = false;
    this.group.add(
      this.refLines.object,
      this.hintMarkers,
      this.others.object,
      this.othersConstruction.object,
      this.dims.object,
      this.solid.object,
      this.construction.object,
      this.preview.object,
      this.points,
      this.snapMarker,
    );
  }

  get frame(): PlaneFrame | null {
    return this.activeFrame;
  }

  setResolution(width: number, height: number) {
    for (const l of [this.others, this.othersConstruction, this.solid, this.construction, this.dims, this.preview, this.refLines]) {
      l.material.resolution.set(width, height);
    }
  }

  /** Finished sketches (not being edited), drawn faintly. Each has its own plane. */
  setOthers(list: { plane: SketchPlane; data: SketchData }[]) {
    const solidW: [number[], number[]][] = [];
    const consW: [number[], number[]][] = [];
    for (const { plane, data } of list) {
      const frame = planeFrame(plane);
      for (const c of data.curves) {
        let segs: [Pt, Pt][];
        try {
          segs = curveSegments(data, c);
        } catch {
          continue; // refers to something that no longer exists
        }
        for (const [p, q] of segs) {
          (c.construction ? consW : solidW).push([toWorld(frame, p[0], p[1]), toWorld(frame, q[0], q[1])]);
        }
      }
    }
    this.setWorldLines(this.others, solidW, SKETCH_COLOURS.inactive);
    this.setWorldLines(this.othersConstruction, consW, SKETCH_COLOURS.inactive);
  }

  private setWorldLines(target: FatLines, segs: [number[], number[]][], colour: THREE.Color) {
    if (!segs.length) {
      target.object.visible = false;
      return;
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(segs.flatMap(([a, b]) => [...a, ...b]));
    g.setColors(segs.flatMap(() => [colour.r, colour.g, colour.b, colour.r, colour.g, colour.b]));
    target.object.geometry.dispose();
    target.object.geometry = g;
    if (target.material.dashed) target.object.computeLineDistances();
    target.object.visible = true;
  }

  setActive(active: ActiveSketch | null) {
    this.active = active;
    this.activeFrame = active ? planeFrame(active.plane) : null;
    this.redrawActive();
  }

  setTransient(t: SketchTransient | null) {
    this.transient = t;
    this.redrawActive();
  }

  private colourFor(id: string, defined: boolean): THREE.Color {
    const t = this.transient;
    const a = this.active!;
    if (a.selection.has(id) || t?.pending.includes(id)) return SKETCH_COLOURS.selected;
    if (t?.hover?.id === id) return SKETCH_COLOURS.hover;
    return defined ? SKETCH_COLOURS.defined : SKETCH_COLOURS.free;
  }

  private redrawActive() {
    const a = this.active;
    const frame = this.activeFrame;
    if (!a || !frame) {
      for (const l of [this.solid, this.construction, this.dims, this.preview, this.refLines]) l.set(null, [], []);
      this.points.visible = false;
      this.snapMarker.visible = false;
      this.hintMarkers.visible = false;
      return;
    }
    // Part edges of the face it's on: faint, brighter when hovered.
    const refSegs: [Pt, Pt][] = [];
    const refCols: THREE.Color[] = [];
    if (a.refs?.length) {
      const virt = refSketch(a.refs);
      const hovered = this.transient?.hover?.id;
      for (const c of virt.curves) {
        const edgeId = c.id.replace(/:s\d+$/, "");
        for (const seg of curveSegments(virt, c)) {
          refSegs.push(seg);
          refCols.push(hovered === edgeId ? SKETCH_COLOURS.hover : SKETCH_COLOURS.reference);
        }
      }
    }
    this.refLines.set(frame, refSegs, refCols);
    const data = a.data;
    // Curves involved in unsatisfied constraints are drawn red.
    const conflicted = new Set<string>();
    for (const c of data.constraints) if (a.failing.has(c.id)) c.refs.forEach((r) => conflicted.add(r));

    const solidSegs: [Pt, Pt][] = [];
    const solidCols: THREE.Color[] = [];
    const consSegs: [Pt, Pt][] = [];
    const consCols: THREE.Color[] = [];
    for (const c of data.curves) {
      let segs: [Pt, Pt][];
      try {
        segs = curveSegments(data, c);
      } catch {
        continue;
      }
      const colour = conflicted.has(c.id) ? SKETCH_COLOURS.conflict : this.colourFor(c.id, a.analysis.definedCurves.has(c.id));
      for (const seg of segs) {
        (c.construction ? consSegs : solidSegs).push(seg);
        (c.construction ? consCols : solidCols).push(colour);
      }
      // A conic's guide lines out to its corner point (dashed).
      if (c.type === "spline" && c.conic !== undefined && c.points.length === 3) {
        const [a, m, b] = splinePoints(data, c);
        consSegs.push([a, m], [m, b]);
        consCols.push(colour, colour);
      }
    }
    // Spline handles (on selected splines): a line through each point, with a dot at each end to drag.
    const handles = splineHandleEnds(data, a.selection);
    for (const h of handles) {
      consSegs.push([pointPos(data, h.pointId), h.at]);
      consCols.push(SKETCH_COLOURS.handle);
    }
    this.solid.set(frame, solidSegs, solidCols);
    this.construction.set(frame, consSegs, consCols);

    // Dimension lines.
    const dimSegs: [Pt, Pt][] = [];
    const dimCols: THREE.Color[] = [];
    for (const c of data.constraints) {
      if (!isDimension(c)) continue;
      const layout = dimensionLayout(data, c);
      if (!layout) continue;
      const colour = a.failing.has(c.id) ? SKETCH_COLOURS.conflict : a.selection.has(c.id) ? SKETCH_COLOURS.selected : SKETCH_COLOURS.dimension;
      for (const seg of layout.lines) {
        dimSegs.push(seg);
        dimCols.push(colour);
      }
    }
    this.dims.set(frame, dimSegs, dimCols);

    // Points.
    const pos: number[] = [];
    const col: number[] = [];
    for (const p of data.points) {
      pos.push(...toWorld(frame, p.x, p.y));
      const c = conflicted.has(p.id) ? SKETCH_COLOURS.conflict : this.colourFor(p.id, a.analysis.definedPoints.has(p.id));
      col.push(c.r, c.g, c.b);
    }
    for (const h of handles) {
      pos.push(...toWorld(frame, h.at[0], h.at[1]));
      col.push(SKETCH_COLOURS.handle.r, SKETCH_COLOURS.handle.g, SKETCH_COLOURS.handle.b);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.points.geometry.dispose();
    this.points.geometry = pg;
    this.points.visible = pos.length > 0;

    // Tool preview and snap marker.
    const t = this.transient;
    const shapes = t?.preview ?? [];
    const prev = shapes.flatMap(previewSegments);
    const colours = shapes.flatMap((sh) => previewSegments(sh).map(() => (sh.kind === "guide" ? SKETCH_COLOURS.inactive : SKETCH_COLOURS.preview)));
    this.preview.set(frame, prev, colours);
    if (t?.snap) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(toWorld(frame, t.snap[0], t.snap[1]), 3));
      this.snapMarker.geometry.dispose();
      this.snapMarker.geometry = g;
      this.snapMarker.visible = true;
    } else this.snapMarker.visible = false;
    // Markers for the middle of the line / centre of the circle under the pointer.
    const hints = t?.hints ?? [];
    if (hints.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(hints.flatMap((h) => toWorld(frame, h[0], h[1])), 3));
      this.hintMarkers.geometry.dispose();
      this.hintMarkers.geometry = g;
      this.hintMarkers.visible = true;
    } else this.hintMarkers.visible = false;
  }

  /** Called every frame: keep dash lengths a constant size on screen. */
  frameUpdate(mmPerPx: number) {
    for (const l of [this.construction, this.preview, this.othersConstruction]) {
      l.material.dashSize = 6 * mmPerPx;
      l.material.gapSize = 4 * mmPerPx;
    }
  }

  dispose() {
    for (const l of [this.others, this.othersConstruction, this.solid, this.construction, this.dims, this.preview, this.refLines]) l.dispose();
    this.hintMarkers.geometry.dispose();
    (this.hintMarkers.material as THREE.Material).dispose();
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.snapMarker.geometry.dispose();
    (this.snapMarker.material as THREE.Material).dispose();
  }
}
