/**
 * Raised or engraved text: letter outlines (from geometry/text.ts) laid on a
 * sketch plane and pushed out into solid letters.
 */
import { assembleWire, basicFaceExtrusion, makeBox, makeCompound, makeFace, makeLine, Vector, type Edge, type Shape3D, type Wire } from "replicad";

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
  return wrapShapes(cyl, start, convex, shapes, [width / 2, o.size / 2], o, "The text is too long to wrap — it would go more than once round the face. Make it smaller.");
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
    // A shape reaching more than about 20° round the surface is laid on many narrow patches, so it hugs the curve.
    if (half / R > STRIP_ANGLE) {
      if (2 * half > 2 * Math.PI * R - 1e-6) throw new Error(tooBig);
      solids.push(wrapWide(cyl, start, convex, outer, shape.holes.map((h) => h.map(flat)), o));
      continue;
    }
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

/** Shapes reaching further round the surface than this (radians, either side of their middle) are wrapped in strips. */
const STRIP_ANGLE = (10 * Math.PI) / 180;
/** Each strip's share of the way round (radians). */
const STRIP_STEP = (5 * Math.PI) / 180;

/**
 * A wide shape wrapped round a cylinder in narrow strips: the shape is made as
 * a flat plate (x round the surface, y along the axis, z out), cut into strips
 * a few degrees wide, and each strip laid on its own patch touching the
 * surface at its middle. The strips overlap a little so they join up at the
 * top of raised shapes.
 */
function wrapWide(
  cyl: Cylinder,
  start: { radial: Vec3; height: number },
  convex: boolean,
  outer: [number, number][],
  holes: [number, number][][],
  o: Pick<TextOptions, "depth" | "flip">,
): Shape3D {
  const R = cyl.radius;
  const k = cyl.axis;
  const e1 = start.radial;
  const e2 = cross3(k, e1);
  const ds = STRIP_STEP * R;
  // Strip edges stand off the surface this much (raised) — or, engraved, this much above it.
  const sag = R - Math.sqrt(Math.max(0, R * R - (ds / 2 + o.depth * STRIP_STEP) ** 2));
  const from = o.flip ? (convex ? 0 : sag) + 0.05 : convex ? -sag - 0.05 : -0.05;
  const length = o.flip ? -(o.depth + from) : o.depth - from;
  const zLo = Math.min(from, from + length);
  const zHi = Math.max(from, from + length);
  // The flat plate, x and y as given, z from zLo to zHi.
  const wire = (poly: [number, number][], anticlockwise: boolean): Wire => {
    const p = polygonArea(poly) > 0 === anticlockwise ? poly : [...poly].reverse();
    const edges: Edge[] = p.map((q, i) => makeLine([q[0], q[1], zLo], [p[(i + 1) % p.length][0], p[(i + 1) % p.length][1], zLo]));
    try {
      return assembleWire(edges);
    } finally {
      release(...edges);
    }
  };
  const ow = wire(outer, true);
  const hw = holes.map((h) => wire(h, false));
  const face = makeFace(ow, hw);
  const up = new Vector([0, 0, zHi - zLo]);
  let plate: Shape3D;
  try {
    plate = basicFaceExtrusion(face, up);
  } finally {
    release(up, face, ow, ...hw);
  }
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys) - 1;
  const y1 = Math.max(...ys) + 1;
  // A touch of overlap so neighbouring strips meet at the top of a raised shape.
  const overlap = Math.abs(zHi) * STRIP_STEP * 0.6 + 0.01;
  const strips: Shape3D[] = [];
  try {
    const n = Math.max(1, Math.ceil((x1 - x0) / ds));
    const step = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const s0 = x0 + i * step;
      const sm = s0 + step / 2;
      const box = makeBox([s0 - (i ? overlap : 0), y0, zLo - 1], [s0 + step + (i < n - 1 ? overlap : 0), y1, zHi + 1]);
      let piece: Shape3D;
      try {
        piece = plate.intersect(box) as Shape3D;
      } finally {
        box.delete();
      }
      const solids = solidsOfShape(piece);
      if (!solids) {
        piece.delete();
        continue;
      }
      // Lay it on the patch at its middle: x round the surface, y along the axis, z out of the material.
      const th = (convex ? sm : -sm) / R;
      const radial = add3(scale3(e1, Math.cos(th)), scale3(e2, Math.sin(th)));
      const along = scale3(add3(scale3(e1, -Math.sin(th)), scale3(e2, Math.cos(th))), convex ? 1 : -1);
      const out = convex ? radial : scale3(radial, -1);
      const touch = add3(cyl.origin, scale3(k, start.height), scale3(radial, R));
      piece = piece.translate([-sm, 0, 0]);
      piece = turnTo(piece, along, k, out);
      piece = piece.translate(touch);
      strips.push(piece);
    }
  } finally {
    plate.delete();
  }
  if (!strips.length) throw new Error("Nothing to wrap.");
  // Joined into one solid: overlapping pieces left side by side would upset adding or cutting it later.
  // Pairs at a time (each strip only overlaps its neighbours), so each join stays small.
  let level = strips;
  while (level.length > 1) {
    const next: Shape3D[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const both = level[i].fuse(level[i + 1]) as Shape3D;
      level[i].delete();
      level[i + 1].delete();
      next.push(both);
    }
    level = next;
  }
  return level[0];
}

/** Does a shape have any solid in it? */
function solidsOfShape(s: Shape3D): boolean {
  try {
    return s.faces.length > 0;
  } catch {
    return false;
  }
}

/** Turn a shape (about the origin) so its x, y and z axes point along `x`, `y` and `z` (a right-handed set). */
function turnTo(shape: Shape3D, x: Vec3, y: Vec3, z: Vec3): Shape3D {
  // The rotation matrix with those columns, as an axis and angle.
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  if (angle < 1e-9) return shape;
  let axis: Vec3;
  if (Math.PI - angle > 1e-6) {
    axis = [m21 - m12, m02 - m20, m10 - m01];
  } else {
    // A half turn: the axis from the matrix's diagonal.
    const xx = Math.sqrt(Math.max(0, (m00 + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (m11 + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (m22 + 1) / 2));
    axis = xx >= yy && xx >= zz ? [xx, (m01 + m10) / (4 * xx), (m02 + m20) / (4 * xx)] : yy >= zz ? [(m01 + m10) / (4 * yy), yy, (m12 + m21) / (4 * yy)] : [(m02 + m20) / (4 * zz), (m12 + m21) / (4 * zz), zz];
  }
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  return shape.rotate((angle * 180) / Math.PI, [0, 0, 0], [axis[0] / l, axis[1] / l, axis[2] / l]);
}
