/**
 * More building blocks for the 3D-printing designs (on top of sketchKit.ts): modelled screw threads with a printed
 * fit, revolves, grid patterns, and sketches on a design's own flat face. Each makes the same Feature record the
 * app's own dialogs make, so an inserted design edits exactly like one drawn by hand.
 */
import { defaultParams } from "../model/features";
import type { TopoPick, Vec3 } from "../geometry/topoRef";
import type { Feature } from "../model/types";
import type { SketchPlane } from "../sketch/planes";
import { lit, minus, plus, times, type Ex } from "./ex";

// ---------------------------------------------------------------------------------------------------------------
// Printed threads
//
// JuraCAD's Thread feature (kernel/thread.ts) cuts a 60° V groove round a round face: on a rod (a bolt) or in a hole
// (a nut). Its standard grooves come to a sharp point, so a bolt and nut cut at the same size only overlap a little
// once they have room to turn. The designs give both a deeper groove instead — PRINTED_DEPTH × pitch, which still
// leaves a flat an eighth of the pitch wide on every tooth, as the standard thread has — and place them so that at a
// printed fit of 0 the two threads just touch along their sloping sides. A printed fit of c then moves the bolt's
// thread in by c and the nut's out by c, which leaves a gap of exactly c between the sloping sides (60° threads:
// moving them 2c apart across opens c square to the sides), and the teeth still overlap by (0.634 × pitch − 2c).
// ---------------------------------------------------------------------------------------------------------------

/** How deep the printed threads' grooves are, as a fraction of the pitch (just under kernel/thread.ts `maxGrooveDepth`). */
export const PRINTED_DEPTH = 0.75;
/** A 60° thread's full triangle height, as a fraction of the pitch (√3 / 2). */
export const THREAD_TRIANGLE = Math.sqrt(3) / 2;
/** How far (× pitch) the bolt's rod is made smaller and the nut's groove bigger, each side, so a fit of 0 just touches. */
export const THREAD_SHIFT = (THREAD_TRIANGLE - PRINTED_DEPTH) / 2;

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** A printed thread's groove depth (mm). */
export const grooveDepth = (pitch: number) => six(PRINTED_DEPTH * pitch);

/** The diameter of a printed bolt's rod (before its thread is cut): nominal − 2 × shift − 2 × fit. */
export const rodDiameter = (nominal: Ex, pitch: number, fit: Ex): Ex => minus(minus(nominal, lit(six(2 * THREAD_SHIFT * pitch))), times(fit, 2));

/** The diameter of a printed nut's hole (before its thread is cut): its groove's bottom is nominal + 2 × shift + 2 × fit across. */
export const nutHoleDiameter = (nominal: Ex, pitch: number, fit: Ex): Ex => plus(minus(nominal, lit(six(2 * (PRINTED_DEPTH - THREAD_SHIFT) * pitch))), times(fit, 2));

/** How far apart a printed bolt and nut's threads are, square to their sloping sides, when the bolt sits in the middle (mm). */
export function threadGap(rod: number, hole: number, pitch: number): number {
  const boltRoot = rod / 2 - PRINTED_DEPTH * pitch;
  const nutRoot = hole / 2 + PRINTED_DEPTH * pitch;
  // The two V tips are this far apart; the sides touch when it's the triangle's height.
  return (nutRoot - boltRoot - THREAD_TRIANGLE * pitch) / 2;
}

/** How far a printed bolt's thread reaches into its nut's (mm across one side): the bolt's outside less the nut's hole, halved. */
export const threadOverlap = (rod: number, hole: number) => (rod - hole) / 2;

/** What's left of a rod of this diameter under its printed thread's grooves (mm across). */
export const boltCore = (rod: number, pitch: number) => rod - 2 * PRINTED_DEPTH * pitch;

/** A round face of a design's part, by where its middle is (picked again on each rebuild as the nearest such face). */
export function roundFace(partId: string, center: Vec3, rel: Vec3): TopoPick {
  return { partId, ref: { kind: "face", surface: "CYLINDRE", center: center.map(six) as Vec3, normal: [1, 0, 0], rel: rel.map((x) => Math.round(x * 1e4) / 1e4) as Vec3 } };
}

/**
 * A modelled screw thread round one round face (as the Thread dialog makes it), with the printed threads' deeper
 * groove. `length` 0 = the whole face (the groove runs out past both ends — the designs always use that, as which end
 * of a round face counts as its far end isn't fixed, and give the groove somewhere clear to run out).
 */
export function threadFeature(id: string, name: string, face: TopoPick, pitch: number, length: Ex, depth = grooveDepth(pitch)): Feature {
  return {
    id,
    name,
    type: "thread",
    operation: "remove",
    suppressed: false,
    params: { ...defaultParams("thread"), pitch: String(pitch), length: length.t, depth: String(depth) },
    picks: [face],
  };
}

/**
 * Spin a sketch's closed shapes round its vertical axis (the sketch's up direction through its origin). On the
 * Front plane that's the world Z axis, so a profile drawn there (x = radius, y = height) makes a round part
 * standing on the bed. A New revolve's separate pieces are separate parts, as the Revolve dialog makes them.
 */
export function revolveFeature(id: string, name: string, sketchRef: string, operation: "new" | "add" | "remove"): Feature {
  return {
    id,
    name,
    type: "revolve",
    operation,
    suppressed: false,
    params: { ...defaultParams("revolve"), angle: "360" },
    sketchRef,
    revolve: { axis: "vertical", flip: false },
    ...(operation === "new" ? { apart: true } : {}),
  };
}

/** A grid of copies of features: `count` along X, `rows` along Y (either may be 1, but not both). */
export function gridPatternFeature(id: string, name: string, sources: string[], count: number, spacing: Ex, rows: number, rowSpacing: Ex): Feature {
  const along = count >= 2;
  const params: Record<string, string> = {
    ...defaultParams("linearPattern"),
    count: String(along ? count : rows),
    spacing: (along ? spacing : rowSpacing).t,
    count2: String(along ? rows : 1),
    spacing2: (along ? rowSpacing : spacing).t,
  };
  return {
    id,
    name,
    type: "linearPattern",
    operation: "add",
    suppressed: false,
    params,
    pattern: { sources, axis: along ? "x" : "y", flip: false, ...(along && rows >= 2 ? { axis2: "y" as const, flip2: false } : {}) },
  };
}

/**
 * A sketch plane on a flat, upward-facing face of a design's own part, `height` above the bed (the sketch's x and y
 * are the world's). The face is found again on each rebuild, so the sketch moves up and down with it when a
 * variable changes, just like a sketch drawn on a part's face in the app.
 */
export function topFacePlane(label: string, partId: string, height: Ex, center: [number, number], rel: Vec3): SketchPlane {
  const face: TopoPick = { partId, ref: { kind: "face", surface: "PLANE", center: [six(center[0]), six(center[1]), six(height.v)], normal: [0, 0, 1], rel } };
  return { kind: "face", origin: [0, 0, six(height.v)], u: [1, 0, 0], v: [0, 1, 0], label, face };
}

/** Where a point sits in a box, 0…1 on each axis (0.5 on a flat axis), for a face's `rel`. */
export function relIn(p: Vec3, min: Vec3, max: Vec3): Vec3 {
  return [0, 1, 2].map((i) => (max[i] - min[i] > 1e-6 ? Math.round(((p[i] - min[i]) / (max[i] - min[i])) * 1e4) / 1e4 : 0.5)) as Vec3;
}
