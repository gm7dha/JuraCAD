/**
 * A round jar with a screw-on lid, both with real modelled threads and a printed fit. The jar and lid are revolved
 * profiles (drawn on Front: x = radius, y = height, spun round the Z axis), so every step is a 45° slope or faces up,
 * and both print without supports: the jar standing up, the lid upside down beside it.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { moveFeature, outlineSketch, sketchFeature } from "../sketchKit";
import { grooveDepth, nutHoleDiameter, PRINTED_DEPTH, rodDiameter, roundFace, threadFeature, threadGap, threadOverlap, THREAD_SHIFT, revolveFeature } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";
import { minOverlap } from "./boltSet";

const VARS = ["inside", "height", "wall", "neck", "fit"];
/** Room between the jar and the lid on the bed (mm). */
export const JAR_GAP = 10;
/** How much deeper the lid is inside than the jar's neck is tall (mm): the lid's rim lands on the shoulder before the jar's top reaches the lid's top. */
export const LID_SPARE = 0.5;
const pitchOf = (v: DesignValues) => Number(v.pitch) || 3;
const six = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The jar's and lid's sizes. The thread's middle size is chosen so the wall behind the jar's thread is `wall` (less
 * the fit); the lid's outside is the same as the jar's below its neck, so the two are flush when it's screwed on.
 */
export function jarSizes(vars: Record<string, Ex>, P: number) {
  const { inside, height, wall, neck, fit } = vars;
  const D = grooveDepth(P);
  const nominal = plus(inside, times(wall, 2), lit(six(2 * (THREAD_SHIFT + PRINTED_DEPTH) * P)));
  const rod = rodDiameter(nominal, P, fit);
  const hole = nutHoleDiameter(nominal, P, fit);
  /** Radii: the jar's thread outside, its thread's root (the run-out just above the shoulder), the lid's thread root and outside. */
  const rOut = over(rod, 2);
  const rRoot = minus(rOut, lit(D));
  const rHole = over(hole, 2);
  const rGroove = plus(rHole, lit(D));
  const rLid = plus(rGroove, wall);
  const rIn = over(inside, 2);
  const rBody = minus(rLid, wall);
  const shoulder = minus(height, neck);
  /** The run-out above the shoulder (and under the lid's top): a pitch long, then a 45° slope up to the thread. */
  const runOut = lit(P);
  const lidHeight = plus(wall, neck, lit(LID_SPARE));
  /** Where the inside narrows from the body to the neck (45°), starting this far below the shoulder. */
  const narrow = minus(rBody, rIn);
  return { D, nominal, rod, hole, rOut, rRoot, rHole, rGroove, rLid, rIn, rBody, shoulder, runOut, lidHeight, narrow, wall, height };
}

/** The jar's profile (x = radius, y = height), round from the axis. */
export function jarProfile(vars: Record<string, Ex>, P: number): Pt[] {
  const s = jarSizes(vars, P);
  const z0 = ZEROX;
  const neckStart = plus(s.shoulder, s.runOut);
  const z1 = minus(s.shoulder, s.narrow);
  return [
    [z0, z0],
    [s.rLid, z0],
    [s.rLid, s.shoulder],
    [s.rRoot, s.shoulder],
    [s.rRoot, neckStart],
    [s.rOut, plus(neckStart, lit(s.D))],
    [s.rOut, s.height],
    [s.rIn, s.height],
    [s.rIn, z1],
    [s.rBody, minus(z1, s.narrow)],
    [s.rBody, s.wall],
    [z0, s.wall],
  ];
}

/** The lid's profile as printed (upside down: its top on the bed). */
export function lidProfile(vars: Record<string, Ex>, P: number): Pt[] {
  const s = jarSizes(vars, P);
  const z0 = ZEROX;
  const reliefTop = plus(s.wall, s.runOut);
  return [
    [z0, z0],
    [s.rLid, z0],
    [s.rLid, s.lidHeight],
    [s.rHole, s.lidHeight],
    [s.rHole, plus(reliefTop, lit(s.D))],
    [s.rGroove, reliefTop],
    [s.rGroove, s.wall],
    [z0, s.wall],
  ];
}
const ZEROX: Ex = { t: "0", v: 0 };

/** Volume of a profile spun round the y axis (Pappus: area × the distance its middle goes round), mm³. */
export function revolvedVolume(pts: [number, number][]): number {
  let a = 0;
  let mx = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cr = x1 * y2 - x2 * y1;
    a += cr;
    mx += (x1 + x2) * cr;
  }
  // ∫∫ 2πx dA = 2π × (Σ (x1 + x2)·cross / 6).
  return a === 0 ? 0 : Math.abs((2 * Math.PI * mx) / 6);
}

const values = (pts: Pt[]): [number, number][] => pts.map(([x, y]) => [x.v, y.v]);

export const jar: LibraryDesign = {
  id: "jar",
  name: "Screw-top jar",
  description:
    "A round jar with a lid that screws on, both with real threads — for screws, beads, spices or spare parts. The jar prints standing up and the lid upside down beside it, both without supports: every step inside is a gentle slope. The printed fit is the gap between the threads; 0.3 mm turns easily on most printers.",
  category: "print",
  group: "Storage",
  prefix: "jar",
  icon: '<path d="M12 18h24v24H12z"/><path d="M10 8h28v8H10z"/><path d="M14 16l4-2M20 16l4-2M26 16l4-2" opacity=".6"/>',
  inputs: [
    { key: "inside", label: "Inside diameter", kind: "length", default: 60, min: 15, max: 250, variable: true, help: "The opening; the jar is this wide inside all the way down." },
    { key: "height", label: "Height", kind: "length", default: 70, min: 20, max: 250, variable: true, help: "The jar, without its lid." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1, max: 10, variable: true, help: "The walls, floor and lid top." },
    { key: "neck", label: "Thread height", kind: "length", default: 12, min: 5, max: 60, variable: true, help: "How tall the threaded neck is (and so how deep the lid)." },
    {
      key: "pitch",
      label: "Thread",
      kind: "choice",
      default: "3",
      choices: [
        { value: "2", label: "Fine (2 mm a turn)" },
        { value: "3", label: "Medium (3 mm a turn)" },
        { value: "4", label: "Coarse (4 mm a turn)" },
      ],
      help: "Coarser threads go on in fewer turns and are easier to print.",
    },
    { key: "fit", label: "Printed fit", kind: "length", default: 0.3, min: 0, max: 1, variable: true, help: "The gap between the threads. 0.3 mm suits most printers; more if the lid binds." },
  ],
  problems: (v) => {
    const P = pitchOf(v);
    const s = jarSizes(varsOf(v, VARS), P);
    const [, H, wall, neck, fit] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (neck < 3 * P + 1) out.push(`The thread needs to be at least ${mm(3 * P + 1)} tall (a few turns), or choose a finer thread.`);
    if (wall - fit < 0.8) out.push(`The wall behind the thread would be only ${mm(wall - fit)} thick: make the wall thicker or the fit smaller.`);
    const floorAt = s.shoulder.v - 2 * s.narrow.v;
    if (floorAt < wall + 2) out.push(`The jar must be taller: at least ${mm(H - floorAt + wall + 2)}, with this thread height and width.`);
    if (threadOverlap(s.rod.v, s.hole.v) < minOverlap(P)) out.push(`With a ${mm(fit)} fit this thread would hardly catch: make the fit smaller, or choose a coarser thread.`);
    return out;
  },
  summary: (v) => {
    const P = pitchOf(v);
    const s = jarSizes(varsOf(v, VARS), P);
    return `2 parts. ${mm(2 * s.rLid.v)} across and ${mm(num(v, "height") + num(v, "wall") + LID_SPARE)} tall with its lid on; the threads have ${mm(threadGap(s.rod.v, s.hole.v, P))} to spare and overlap by ${mm(threadOverlap(s.rod.v, s.hole.v))}.`;
  },
  make: (ctx) => {
    const P = pitchOf(ctx.values);
    const s = jarSizes(ctx.vars, P);
    const front = { kind: "default", name: "Front" } as const;
    const jarId = ctx.id("jar");
    const lidId = ctx.id("lid");
    const neckFrom = s.shoulder.v + s.runOut.v + s.D;
    const lidFrom = s.wall.v + s.runOut.v + s.D;
    return {
      features: [
        sketchFeature(ctx.id("jar-sketch"), "Jar profile", front, outlineSketch(jarProfile(ctx.vars, P), ctx.scope)),
        revolveFeature(jarId, "Jar", ctx.id("jar-sketch"), "new"),
        threadFeature(ctx.id("jar-thread"), "Jar thread", roundFace(jarId, [0, 0, (neckFrom + s.height.v) / 2], [0.5, 0.5, (neckFrom + s.height.v) / 2 / s.height.v]), P, lit(0)),
        sketchFeature(ctx.id("lid-sketch"), "Lid profile", front, outlineSketch(lidProfile(ctx.vars, P), ctx.scope)),
        revolveFeature(lidId, "Lid", ctx.id("lid-sketch"), "new"),
        threadFeature(ctx.id("lid-thread"), "Lid thread", roundFace(lidId, [0, 0, (lidFrom + s.lidHeight.v) / 2], [0.5, 0.5, (lidFrom + s.lidHeight.v) / 2 / s.lidHeight.v]), P, lit(0)),
        // Made round the same axis, then moved beside the jar to print.
        moveFeature(ctx.id("lid-beside"), "Lid beside the jar", lidId, { dx: plus(times(s.rLid, 2), lit(JAR_GAP)) }),
      ],
      partNames: { [jarId]: `${ctx.name}: jar`, [lidId]: `${ctx.name}: lid` },
    };
  },
  preview: (v) => {
    const P = pitchOf(v);
    const vars = varsOf(v, VARS);
    const s = jarSizes(vars, P);
    const mirror = (pts: [number, number][], dx: number): [number, number][] => [...pts.map(([x, y]): [number, number] => [dx + x, y]), ...pts.slice().reverse().map(([x, y]): [number, number] => [dx - x, y])];
    const jarPts = values(jarProfile(vars, P)).slice(1, -1);
    const lidPts = values(lidProfile(vars, P)).slice(1, -1);
    const dx = 2 * s.rLid.v + JAR_GAP;
    return [
      { kind: "poly", closed: true, points: mirror(jarPts, 0) },
      { kind: "poly", closed: true, points: mirror(lidPts, dx) },
      { kind: "text", at: [0, -s.rLid.v * 0.3], text: "jar" },
      { kind: "text", at: [dx, -s.rLid.v * 0.3], text: "lid, upside down" },
    ] as PreviewShape[];
  },
};

/** For tests: the jar's and lid's volumes before their threads are cut (mm³). */
export function jarVolumes(v: DesignValues): { jar: number; lid: number } {
  const P = pitchOf(v);
  const vars = varsOf(v, VARS);
  return { jar: revolvedVolume(values(jarProfile(vars, P))), lid: revolvedVolume(values(lidProfile(vars, P))) };
}
