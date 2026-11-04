/**
 * A wall-mounted spool holder: a plate that screws to the wall and a round arm sticking straight out of it, with a
 * lip at its end so the spool can't walk off. It prints standing on the plate — the arm upright, its round layers
 * stacked — so there's nothing to support: the lip flares out at 45°. The arm is a revolved profile (Front plane:
 * x = radius, y = height) added to the plate.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, outlineSketch, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { revolveFeature, topFacePlane } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, roundedRect, roundedRectArea, varsOf } from "./common";
import { revolvedVolume } from "./jar";

const VARS = ["hub", "width", "plateWidth", "plateLength", "thickness"];
/** How much smaller the arm is than the spool's hole, and the lip (mm, across). */
export const ARM_ROOM = 10;
export const LIP_ROOM = 3;
/** Room beyond the spool's width before the lip, and the lip's straight band (mm). */
export const SPOOL_SPARE = 3;
export const LIP_BAND = 4;
/** Screw holes for 4 mm screws: across, the countersink, and how far in from the plate's ends. */
export const SPOOL_HOLE = { d: 4.5, head: 9, in: 12 };

/** The arm's profile, round from the axis: up through the plate, out to the lip at 45°, the lip's band, then the flat end. */
export function armProfile(vars: Record<string, Ex>): Pt[] {
  const { hub, width, thickness } = vars;
  const ra = minus(over(hub, 2), lit(ARM_ROOM / 2));
  const rl = minus(over(hub, 2), lit(LIP_ROOM / 2));
  const flare = lit((ARM_ROOM - LIP_ROOM) / 2);
  const reach = plus(thickness, width, lit(SPOOL_SPARE));
  const zero: Ex = lit(0);
  return [
    [zero, zero],
    [ra, zero],
    [ra, reach],
    [rl, plus(reach, flare)],
    [rl, plus(reach, flare, lit(LIP_BAND))],
    [zero, plus(reach, flare, lit(LIP_BAND))],
  ];
}

export const spoolHolder: LibraryDesign = {
  id: "spool-holder",
  name: "Filament spool holder",
  description:
    "A sturdy arm that screws to the wall (or the side of a shelf unit) and holds a reel of filament, with a lip at the end so the spool stays on. The arm is a bit smaller than the spool's hole so it turns freely as the printer pulls; most spools have a 52–56 mm hole. It prints standing on its plate, no supports.",
  category: "print",
  group: "Workshop",
  prefix: "spool",
  icon: '<rect x="4" y="8" width="8" height="32" rx="1.5"/><path d="M12 19h26v10H12z" opacity=".75"/><path d="M38 16h4v16h-4z"/><circle cx="8" cy="13" r="1.4"/><circle cx="8" cy="35" r="1.4"/>',
  inputs: [
    { key: "hub", label: "Spool hole", kind: "length", default: 53, min: 25, max: 120, variable: true, help: "Across the hole in the middle of your spools: most are 52–56 mm. The arm is 10 mm smaller, the lip 3 mm." },
    { key: "width", label: "Spool width", kind: "length", default: 70, min: 20, max: 150, variable: true, help: "The widest spool it should take (most 1 kg spools are 55–70 mm)." },
    { key: "plateWidth", label: "Plate width", kind: "length", default: 60, min: 20, max: 200, variable: true },
    { key: "plateLength", label: "Plate height", kind: "length", default: 110, min: 40, max: 300, variable: true, help: "Up the wall; a screw near each end." },
    { key: "thickness", label: "Plate thickness", kind: "length", default: 6, min: 4, max: 20, variable: true },
  ],
  problems: (v) => {
    const [hub, , pw, pl] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const ra = hub / 2 - ARM_ROOM / 2;
    if (pw < 2 * ra + 6) out.push(`The plate must be wider than the arm: at least ${mm(2 * ra + 6)}.`);
    const free = pl / 2 - SPOOL_HOLE.in - SPOOL_HOLE.head / 2;
    if (free < ra + 1) out.push(`The plate is too short for screws above and below the arm: make it at least ${mm(2 * (ra + 1 + SPOOL_HOLE.in + SPOOL_HOLE.head / 2))} high.`);
    return out;
  },
  summary: (v) => {
    const hub = num(v, "hub");
    return `The arm is ${mm(hub - ARM_ROOM)} across with a ${mm(hub - LIP_ROOM)} lip, and sticks out ${mm(num(v, "width") + SPOOL_SPARE + (ARM_ROOM - LIP_ROOM) / 2 + LIP_BAND)} from the plate. Two countersunk holes for 4 mm screws.`;
  },
  make: (ctx) => {
    const { plateWidth, plateLength, thickness } = ctx.vars;
    const top = { kind: "default", name: "Top" } as const;
    const front = { kind: "default", name: "Front" } as const;
    const id = ctx.id("holder");
    const plate = roundCorners(shapesSketch([{ type: "rectangle", center: ["0", "0"], width: plateWidth.t, height: plateLength.t }], ctx.scope), lit(5), ctx.scope);
    const y = minus(times(plateLength, 0.5), lit(SPOOL_HOLE.in));
    const holes = [y, minus(lit(0), y)].map((cy) => ({ type: "circle", center: ["0", cy.t], diameter: String(SPOOL_HOLE.d) }));
    return {
      features: [
        sketchFeature(ctx.id("plate-sketch"), "Plate sketch", top, plate),
        extrudeFeature(id, "Plate", ctx.id("plate-sketch"), { depth: thickness, operation: "new" }),
        sketchFeature(ctx.id("arm-sketch"), "Arm profile", front, outlineSketch(armProfile(ctx.vars), ctx.scope)),
        revolveFeature(ctx.id("arm"), "Arm", ctx.id("arm-sketch"), "add"),
        sketchFeature(ctx.id("holes-sketch"), "Screw holes sketch", topFacePlane("Plate front", id, thickness, [0, 0], [0.5, 0.5, 1]), shapesSketch(holes, ctx.scope)),
        countersunkHoleFeature(ctx.id("holes"), "Screw holes", ctx.id("holes-sketch"), lit(SPOOL_HOLE.d), lit(SPOOL_HOLE.head)),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const t = vars.thickness.v;
    const pl = vars.plateLength.v;
    const prof = armProfile(vars).map(([x, y]) => [x.v, y.v] as [number, number]);
    const side = [...prof.slice(1, -1).map(([r, z]): [number, number] => [z, r]), ...prof.slice(1, -1).reverse().map(([r, z]): [number, number] => [z, -r])];
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: roundedRect(t, pl, 0, t / 2, 0) },
      { kind: "poly", closed: true, points: side.filter(([z]) => z >= t - 1e-9) },
      { kind: "text", at: [pl * 0.3, -pl / 2 - 6], text: "seen from the side, as on the wall" },
    ];
    return out;
  },
};

/** For tests: its volume (mm³). */
export function spoolHolderVolume(v: DesignValues): number {
  const vars = varsOf(v, VARS);
  const [pw, pl, t] = [vars.plateWidth.v, vars.plateLength.v, vars.thickness.v];
  const prof = armProfile(vars).map(([x, y]) => [x.v, y.v] as [number, number]);
  const ra = prof[1][0];
  return roundedRectArea(pw, pl, 5) * t + revolvedVolume(prof) - Math.PI * ra * ra * t - 2 * countersunkHoleVolume(SPOOL_HOLE.d, SPOOL_HOLE.head, t);
}
