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
