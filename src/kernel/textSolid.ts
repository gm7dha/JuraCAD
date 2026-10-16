/**
 * Raised or engraved text: letter outlines (from geometry/text.ts) laid on a
 * sketch plane and pushed out into solid letters.
 */
import { assembleWire, basicFaceExtrusion, makeCompound, makeFace, makeLine, Vector, type Edge, type Shape3D, type Wire } from "replicad";

import regular from "three/examples/fonts/helvetiker_regular.typeface.json";
import bold from "three/examples/fonts/helvetiker_bold.typeface.json";

import { nestContours, polygonArea, textOutlines, type TypefaceFont } from "../geometry/text";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { release } from "./extrude";

export interface TextOptions {
  value: string;
  bold: boolean;
  /** Letter size (the font's full height), mm. */
  size: number;
  depth: number;
  /** Start of the first line's baseline on the plane, and the turn of the text (degrees). */
  x: number;
  y: number;
  angle: number;
  /** Push the letters the other way (into the part, for engraving). */
  flip: boolean;
}

export const FONTS = { regular: regular as unknown as TypefaceFont, bold: bold as unknown as TypefaceFont };

export function textSolid(plane: SketchPlane, o: TextOptions): Shape3D {
  const { contours } = textOutlines(o.bold ? FONTS.bold : FONTS.regular, o.value, o.size);
  if (contours.length === 0) throw new Error("Type some text (letters, numbers or symbols) to make.");
  const frame = planeFrame(plane);
  const a = (o.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const to3 = ([px, py]: [number, number]) => toWorld(frame, px * c - py * s + o.x, px * s + py * c + o.y);
  const wireOf = (poly: [number, number][], anticlockwise: boolean): Wire => {
    const p = polygonArea(poly) > 0 === anticlockwise ? poly : [...poly].reverse();
    const edges: Edge[] = p.map((q, i) => makeLine(to3(q), to3(p[(i + 1) % p.length])));
    try {
      return assembleWire(edges);
    } finally {
      release(...edges);
    }
  };
  const dir = o.flip ? -1 : 1;
  const n = frame.n;
  const solids: Shape3D[] = [];
  for (const shape of nestContours(contours)) {
    const outer = wireOf(shape.outer, true);
    const holes = shape.holes.map((h) => wireOf(h, false));
    const face = makeFace(outer, holes);
    const v = new Vector([n[0] * o.depth * dir, n[1] * o.depth * dir, n[2] * o.depth * dir]);
    try {
      solids.push(basicFaceExtrusion(face, v));
    } finally {
      release(v, face, outer, ...holes);
    }
  }
  return solids.length === 1 ? solids[0] : (makeCompound(solids) as unknown as Shape3D);
}

/** A round face's cylinder: a point on its axis, the axis direction (unit) and the radius. */
export interface Cylinder {
  origin: Vec3;
  axis: Vec3;
  radius: number;
}

type Vec3 = [number, number, number];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (...vs: Vec3[]): Vec3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0] as Vec3);
const unit3 = (a: Vec3): Vec3 | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? scale3(a, 1 / l) : null;
};

/**
 * Where on a round face the text goes: the face's middle (its centre of mass,
 * pushed out to the surface) — or, for a whole cylinder, the side facing the
 * front view.
 */
export function wrapStart(cyl: Cylinder, faceCentre: Vec3): { radial: Vec3; height: number } {
  const k = cyl.axis;
  const rel = sub3(faceCentre, cyl.origin);
  const height = dot3(rel, k);
  const off = sub3(rel, scale3(k, height));
  const front: Vec3 = [0, -1, 0];
  const radial =
    (Math.hypot(...off) > 0.05 * cyl.radius ? unit3(off) : null) ??
    unit3(sub3(front, scale3(k, dot3(front, k)))) ??
    unit3(sub3([0, 0, 1], scale3(k, k[2])))!;
  return { radial, height };
}

/**
 * Text wrapped round a cylinder: each letter is laid on its own flat patch
 * touching the surface where it sits, turned to face straight out, and pushed
 * out of (or, flipped, into) the surface. `convex` is true for the outside of
 * a rod or boss, false for the inside of a hole or tube. Start X runs round the
 * surface (mm along it) and Start Y along the axis, from the middle of the face.
 */
export function wrappedTextSolid(cyl: Cylinder, start: { radial: Vec3; height: number }, convex: boolean, o: TextOptions): Shape3D {
  const { contours, width } = textOutlines(o.bold ? FONTS.bold : FONTS.regular, o.value, o.size);
  if (contours.length === 0) throw new Error("Type some text (letters, numbers or symbols) to make.");
  const shapes = nestContours(contours).map((sh) => ({ outer: sh.outer, holes: sh.holes }));
  return wrapShapes(cyl, start, convex, shapes, [width / 2, o.size / 2], o, "The letters are too big for such a narrow round face — make them smaller.");
}

/**
 * Flat shapes (outlines with holes, in their own x/y) wrapped round a
 * cylinder, centred on `centre` of the shapes: each shape is laid on its own
 * flat patch touching the surface where it sits, turned to face straight out,
 * and pushed out of (or, with `flip`, into) the surface. `x` runs round the
 * surface (mm along it) and `y` along the axis, from the start point; `angle`
 * turns the shapes first. Used by Text and by Wrap.
 */
export function wrapShapes(
  cyl: Cylinder,
  start: { radial: Vec3; height: number },
  convex: boolean,
  shapes: { outer: [number, number][]; holes: [number, number][][] }[],
  centre: [number, number],
  o: Pick<TextOptions, "depth" | "x" | "y" | "angle" | "flip">,
  tooBig: string,
): Shape3D {
  const R = cyl.radius;
  const k = cyl.axis;
  const e1 = start.radial;
  const e2 = cross3(k, e1);
  const a = (o.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // The shapes are centred on the start point; (s, t) = round the surface, along the axis.
  const flat = ([px, py]: [number, number]): [number, number] => {
    const x = px - centre[0];
    const y = py - centre[1];
    return [x * c - y * s + o.x, x * s + y * c + o.y];
  };
  const solids: Shape3D[] = [];
  for (const shape of shapes) {
    const outer = shape.outer.map(flat);
    const xs = outer.map((p) => p[0]);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const half = (Math.max(...xs) - Math.min(...xs)) / 2;
    if (half >= R) throw new Error(tooBig);
    // How far the patch's edges stand off the surface (or dig into it).
    const sag = R - Math.sqrt(R * R - half * half);
    const th = (convex ? mid : -mid) / R;
    const radial = add3(scale3(e1, Math.cos(th)), scale3(e2, Math.sin(th)));
    // Inside a hole the shapes are seen from the axis side, so they run the other way round.
    const along = scale3(add3(scale3(e1, -Math.sin(th)), scale3(e2, Math.cos(th))), convex ? 1 : -1);
    // Out of the material: away from the axis on a rod, towards it in a hole.
    const out = convex ? radial : scale3(radial, -1);
    const touch = add3(cyl.origin, scale3(k, start.height), scale3(radial, R));
    // Raised shapes start below the surface so they meet it everywhere; engraved ones start just above it.
    const from = o.flip ? (convex ? 0 : sag) + 0.05 : convex ? -sag - 0.05 : -0.05;
    const length = o.flip ? -(o.depth + from) : o.depth - from;
    const at = ([x, y]: [number, number], w: number): Vec3 => add3(touch, scale3(along, x - mid), scale3(k, y), scale3(out, w));
    const wireOf = (poly: [number, number][], anticlockwise: boolean): Wire => {
      const p = polygonArea(poly) > 0 === anticlockwise ? poly : [...poly].reverse();
      const edges: Edge[] = p.map((q, i) => makeLine(at(q, from), at(p[(i + 1) % p.length], from)));
      try {
        return assembleWire(edges);
      } finally {
        release(...edges);
      }
    };
    const outerWire = wireOf(outer, true);
    const holes = shape.holes.map((h) => wireOf(h.map(flat), false));
    const face = makeFace(outerWire, holes);
    const v = new Vector(scale3(out, length));
    try {
      solids.push(basicFaceExtrusion(face, v));
    } finally {
      release(v, face, outerWire, ...holes);
    }
  }
  return solids.length === 1 ? solids[0] : (makeCompound(solids) as unknown as Shape3D);
}
