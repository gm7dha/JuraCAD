/**
 * Hole: drills holes at a sketch's points (and the centres of its circles),
 * straight into the part, at right angles to the sketch.
 */
import { assembleWire, cast, getOC, makeCompound, makeFace, makeLine, measureVolume, revolution, type Shape3D } from "replicad";

import { HOLE_LEAD_IN, holeProfile, straightStart, type HoleSize } from "../model/holes";
import { threadDepth, threadPieces } from "./thread";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { holePositionsIn } from "../sketch/holePositions";
import type { SketchData } from "../sketch/types";
import { release } from "./extrude";

type V3 = [number, number, number];

/** The solid cut away by one hole whose top centre is `at`, drilling along `dir` (unit). */
function oneHole(at: V3, dir: V3, size: HoleSize): Shape3D {
  // Any direction at right angles to the drill, to draw the cross-section in.
  const helper: V3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e: V3 = [dir[1] * helper[2] - dir[2] * helper[1], dir[2] * helper[0] - dir[0] * helper[2], dir[0] * helper[1] - dir[1] * helper[0]];
  const el = Math.hypot(...e);
  const side: V3 = [e[0] / el, e[1] / el, e[2] / el];
  const P = ([r, t]: [number, number]): V3 => [at[0] + side[0] * r + dir[0] * t, at[1] + side[1] * r + dir[1] * t, at[2] + side[2] * r + dir[2] * t];
  const pts = holeProfile(size).map(P);
  const edges = pts.map((p, i) => makeLine(p, pts[(i + 1) % pts.length]));
  const wire = assembleWire(edges);
  const face = makeFace(wire);
  try {
    return revolution(face, at, dir, 360);
  } finally {
    release(face, wire, ...edges);
  }
}

/**
 * Threaded hole solids already made, by size: making one (the helical groove
 * joined onto the hole) takes about half a second a turn, so each is made once
 * — upright at the origin — and copies are moved into place. Kept by the engine.
 */
export type ThreadedHoleCache = Map<string, Shape3D>;
const CACHE_LIMIT = 24;

/**
 * About how much a hole's thread groove adds to the hole: along the hole's
 * wall, the V's part beyond the wall; past the ends of the hole, the whole V;
 * inside a counterbore or countersink, nothing much (it's in the open there).
 */
export function threadAdds(size: HoleSize): number {
  const { from, to, pitch } = size.thread!;
  const R = size.diameter / 2;
  const d = threadDepth(pitch, false);
  const air = 0.1 * pitch;
  const tan30 = Math.tan(Math.PI / 6);
  const coreLo = size.throughAll && size.backLength && size.backLength > HOLE_LEAD_IN ? -size.backLength : -HOLE_LEAD_IN;
  const coreHi = size.throughAll ? size.throughLength : size.depth;
  const open = size.kind === "simple" ? coreLo : Math.max(coreLo, straightStart(size));
  const overlap = (a: number, b: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  const wall = overlap(open, coreHi);
  const inOpen = overlap(coreLo, open);
  const past = Math.max(0, to - from - wall - inOpen);
  const ring = (r: number) => (2 * Math.PI * r) / pitch;
  return tan30 * (wall * d * d * ring(R + d / 3) + past * (d + air) * (d + air) * ring(R + (d - 2 * air) / 3));
}

/** The hole with its thread groove joined on, upright: top centre at the origin, drilling along +Z. */
function threadedHoleUpright(size: HoleSize, cache: ThreadedHoleCache | undefined): Shape3D {
  const thread = size.thread!;
  const key = JSON.stringify([holeProfile(size), thread]);
  const hit = cache?.get(key);
  if (hit) {
    // Most recently used last, so the oldest is dropped first.
    cache!.delete(key);
    cache!.set(key, hit);
    return hit.clone();
  }
  const cyl = { origin: [0, 0, 0] as V3, axis: [0, 0, 1] as V3, radius: size.diameter / 2 };
  const expected = threadAdds(size);
  let made: Shape3D | null = null;
  // Up to 20 turns at a time (in even pieces) joins on cleanly; much longer sweeps sometimes don't, so check and try smaller pieces.
  const totalTurns = (thread.to - thread.from) / thread.pitch;
  const even = totalTurns / Math.ceil(totalTurns / 20);
  for (const turns of [even, 6]) {
    const core = oneHole([0, 0, 0], [0, 0, 1], size);
    const before = measureVolume(core);
    let tool: Shape3D = core;
    try {
      for (const piece of threadPieces(cyl, thread.from, thread.to, thread.pitch, false, turns)) {
        const next = quickFuse(tool, piece.shape);
        release(tool, piece.shape);
        tool = next;
      }
      const added = measureVolume(tool) - before;
      // Close to the estimate; a bad join is far off (20% or more).
      if (expected > 1e-9 && Math.abs(added - expected) <= 0.1 * expected) {
        made = tool;
        break;
      }
      tool.delete();
    } catch {
      tool.delete();
    }
  }
  if (!made) throw new Error("The thread couldn't be modelled cleanly for this hole. Untick \"Model the thread\", or try a different depth or size.");
  if (cache) {
    cache.set(key, made.clone());
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string;
      cache.get(oldest)?.delete();
      cache.delete(oldest);
    }
  }
  return made;
}

/**
 * Join two shapes without tidying the faces afterwards (replicad's fuse does,
 * which takes as long again on helical faces; a cutting tool needn't be tidy).
 */
function quickFuse(a: Shape3D, b: Shape3D): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const builder = new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped);
  try {
    if (!builder.IsDone()) throw new Error("Couldn't join the thread onto the hole.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A shape made upright at the origin (along +Z), turned to point along `dir` and moved to `at`. */
function placeUpright(shape: Shape3D, at: V3, dir: V3): Shape3D {
  const axis: V3 = [-dir[1], dir[0], 0]; // +Z × dir
  const s = Math.hypot(...axis);
  const angle = (Math.atan2(s, dir[2]) * 180) / Math.PI;
  let out = shape;
  if (s > 1e-9) out = out.rotate(angle, [0, 0, 0], [axis[0] / s, axis[1] / s, 0]);
  else if (dir[2] < 0) out = out.rotate(180, [0, 0, 0], [1, 0, 0]);
  return out.translate(at);
}

/** Where each hole starts (on the sketch) and the way it drills (unit), for a Hole feature's sketch. */
export function holeAxes(plane: SketchPlane, data: SketchData, flip: boolean): { at: V3; dir: V3 }[] {
  const frame = planeFrame(plane);
  // Into the face by default (sketches on a face point outwards from it).
  const s = flip ? 1 : -1;
  const dir: V3 = [frame.n[0] * s, frame.n[1] * s, frame.n[2] * s];
  return holePositionsIn(data).map(([x, y]) => ({ at: toWorld(frame, x, y), dir }));
}

/**
 * All the holes a Hole feature drills, as one solid to cut away. `size` may
 * differ from hole to hole (up to next: each drills to its own depth).
 */
export function holeTool(plane: SketchPlane, data: SketchData, size: HoleSize | ((at: V3, dir: V3) => HoleSize), flip: boolean, cache?: ThreadedHoleCache): Shape3D {
  const axes = holeAxes(plane, data, flip);
  if (axes.length === 0) {
    throw new Error("The sketch has no points for holes. In the sketch, place points (P) where the holes go — or draw circles: their centres are used.");
  }
  let result: Shape3D | null = null;
  // Threaded holes are kept apart (a compound) rather than joined: joining helical grooves is slow, and they don't touch.
  const threaded: Shape3D[] = [];
  try {
    for (const { at, dir } of axes) {
      const here = typeof size === "function" ? size(at, dir) : size;
      const hole = here.thread ? placeUpright(threadedHoleUpright(here, cache), at, dir) : oneHole(at, dir, here);
      if (here.thread) threaded.push(hole);
      else if (!result) result = hole;
      else {
        const merged: Shape3D = result.fuse(hole);
        release(result, hole);
        result = merged;
      }
    }
  } catch (e) {
    result?.delete();
    threaded.forEach((t) => t.delete());
    throw e;
  }
  if (threaded.length === 0) return result!;
  if (threaded.length === 1 && !result) return threaded[0];
  return makeCompound(result ? [result, ...threaded] : threaded) as Shape3D;
}
