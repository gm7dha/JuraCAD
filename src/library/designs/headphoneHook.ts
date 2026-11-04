/**
 * An under-desk headphone hook: a plate that screws to the underside of a desk or shelf, a short drop, and an arm
 * with a turned-up lip that the headband hangs on. Shaped like a Z seen from the side — the arm goes the other way
 * from the plate, so nothing is under the screws and a screwdriver reaches them. The side view is drawn on Top and
 * made as thick as its width upwards, so it prints on its side (layers run along the hook, so it's strong); the
 * screw-head face is on the Front plane (y = 0), so the countersunk Hole drills straight up into the plate.
 */
import { fraction, lit, minus, plus, times, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, polygonArea, varsOf } from "./common";

const VARS = ["plate", "drop", "arm", "lip", "thickness", "width"];
/** Screw holes for 3.5–4 mm wood screws: across and the countersink. */
export const HEADPHONE_HOLE = { d: 4.5, head: 9 };

/**
 * The hook seen from the side (x along the desk, y up; the desk's underside at y = thickness): the plate along +x, the
 * drop down at x = 0…thickness, then the arm back along −x with its lip at the end.
 */
export function headphoneOutline(v: Record<string, Ex>): Pt[] {
  const { plate, drop, arm, lip, thickness: t } = v;
  const zero = lit(0);
  const bottom = minus(t, drop);
  const armTop = plus(bottom, t);
  const end = minus(t, arm);
  return [
    [zero, t],
    [plate, t],
    [plate, zero],
    [t, zero],
    [t, bottom],
    [end, bottom],
    [end, plus(bottom, lip)],
    [plus(end, t), plus(bottom, lip)],
    [plus(end, t), armTop],
    [zero, armTop],
  ];
}

/** Where the two screw holes go along the plate (x), evenly in its free part. */
export const headphoneHoles = (v: Record<string, Ex>): Ex[] => {
  const free = minus(v.plate, v.thickness);
  return [plus(v.thickness, fraction(free, 1, 3)), plus(v.thickness, fraction(free, 2, 3))];
};

export const headphoneHook: LibraryDesign = {
  id: "headphone-hook",
  name: "Under-desk headphone hook",
  description:
    "Screws to the underside of a desk or shelf and keeps your headphones hanging out of the way. The headband rests on a wide arm with a lip so they don't slip off, and the screws sit in countersunk holes you can reach from below. It prints on its side, so the layers run along the hook and it's strong; no supports.",
  category: "print",
  group: "Desk",
  prefix: "phones",
  icon: '<path d="M6 8h22v5H11v18h20v-5h5v10H6z"/><circle cx="17" cy="10.5" r="1.3"/><circle cx="23" cy="10.5" r="1.3"/>',
  inputs: [
    { key: "plate", label: "Plate length", kind: "length", default: 50, min: 25, max: 200, variable: true, help: "The part against the desk, with two screws." },
    { key: "drop", label: "Drop", kind: "length", default: 50, min: 20, max: 200, variable: true, help: "From the desk down to the bottom of the arm." },
    { key: "arm", label: "Arm length", kind: "length", default: 60, min: 25, max: 200, variable: true, help: "Where the headband rests. Wider than your headband." },
    { key: "lip", label: "Lip height", kind: "length", default: 12, min: 4, max: 60, variable: true },
    { key: "thickness", label: "Thickness", kind: "length", default: 6, min: 4, max: 20, variable: true },
    { key: "width", label: "Width", kind: "length", default: 30, min: 15, max: 100, variable: true, help: "How wide the arm is (front to back under the desk): wider is kinder to the headband." },
  ],
  problems: (v) => {
    const [plate, drop, arm, lip, t] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (drop - t - lip < 25) out.push(`The gap for the headband (drop − thickness − lip) is only ${mm(drop - t - lip)}: make the drop at least ${mm(25 + t + lip)}.`);
    if (lip <= t) out.push(`The lip must stand taller than the arm is thick (more than ${mm(t)}).`);
    if (arm < 3 * t + 10) out.push(`The arm must be at least ${mm(3 * t + 10)} long.`);
    if ((plate - t) / 3 < HEADPHONE_HOLE.head / 2 + 2) out.push(`The plate is too short for two screws: make it at least ${mm(t + 3 * (HEADPHONE_HOLE.head / 2 + 2))} long.`);
    if (t < HEADPHONE_HOLE.head / 2 - HEADPHONE_HOLE.d / 2 + 1.5) out.push(`It's too thin for countersunk screws: at least ${mm(HEADPHONE_HOLE.head / 2 - HEADPHONE_HOLE.d / 2 + 1.5)} thick.`);
    return out;
  },
  summary: (v) => `Room for a headband ${mm(num(v, "drop") - num(v, "thickness") - num(v, "lip"))} thick and ${mm(num(v, "arm") - 2 * num(v, "thickness"))} across; two countersunk holes for 4 mm screws.`,
  make: (ctx) => {
    const id = ctx.id("hook");
    const top = { kind: "default", name: "Top" } as const;
    const front = { kind: "default", name: "Front" } as const;
    // Front-plane sketches: across is world X (along the plate), up is world Z (across its width).
    const holes = headphoneHoles(ctx.vars).map((x) => ({ type: "circle", center: [x.t, times(ctx.vars.width, 0.5).t], diameter: String(HEADPHONE_HOLE.d) }));
    return {
      features: [
        sketchFeature(ctx.id("profile"), "Hook profile", top, outlineSketch(headphoneOutline(ctx.vars), ctx.scope)),
        extrudeFeature(id, "Hook", ctx.id("profile"), { depth: ctx.vars.width, operation: "new" }),
        sketchFeature(ctx.id("holes-sketch"), "Screw holes sketch", front, shapesSketch(holes, ctx.scope)),
        countersunkHoleFeature(ctx.id("holes"), "Screw holes", ctx.id("holes-sketch"), lit(HEADPHONE_HOLE.d), lit(HEADPHONE_HOLE.head)),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const pts = headphoneOutline(vars).map(([x, y]) => [x.v, y.v] as [number, number]);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: pts }];
    const t = vars.thickness.v;
    for (const x of headphoneHoles(vars)) out.push({ kind: "poly", faint: true, points: [[x.v, 0], [x.v, t]] });
    out.push({ kind: "text", at: [0, -vars.drop.v - 6], text: "seen from the side, the desk above" });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function headphoneVolume(v: DesignValues): number {
  const vars = varsOf(v, VARS);
  const pts = headphoneOutline(vars).map(([x, y]) => [x.v, y.v] as [number, number]);
  return polygonArea(pts) * vars.width.v - 2 * countersunkHoleVolume(HEADPHONE_HOLE.d, HEADPHONE_HOLE.head, vars.thickness.v);
}
