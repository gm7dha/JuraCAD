/**
 * A fixed-angle phone stand that you can charge the phone in: the side view of the Phone / tablet stand (a slot with
 * a lip in front and a back rest leaning at the chosen angle, standProfile.ts), but with the phone's floor raised on a
 * plinth so the charging plug fits under it. USB-C and Lightning plugs are 18–25 mm long with their moulding, so the
 * plinth is the plug's length plus `BEND_ROOM` high: the plug goes down a slot through the plinth, and at the bottom the
 * cable turns into a pocket and runs out of the back along a channel. It prints standing up: the back rest's underside
 * leans at most 45° from upright (the angle is 45–80° from the table) and the pocket's and channel's roofs bridge their
 * width, so nothing needs supports.
 *
 * (A two-part hinged stand with a ratchet was the other idea: it has more to go wrong in printing and in use — the
 * ratchet teeth wear, the hinge pin works loose — so this is the simpler, sturdier choice.)
 *
 * The side view is drawn on the Right plane (across = world y, towards you = +y, up = z) and made `width` wide each way of
 * x = 0. Only the width is a variable; the rest are Edit design sizes, as the angle and plug set them.
 */
import { lit } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, polygonArea } from "./common";
import { angleInput } from "./phoneStand";
import { trigOf } from "./standProfile";
import { rectShape, type P2 } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
/** How far the plug slot stays clear of the slot's back and front walls (mm). */
export const PLUG_CLEAR = 0.5;
/** Room under the plug for the cable to bend back (mm): the plinth is the plug's length plus this. */
export const BEND_ROOM = 8;
/** Wall left behind the cable pocket, inside the plinth (mm). */
export const POCKET_WALL = 1.5;
/** How far cuts reach into each other, so they join. */
const JOIN = 1;
/** A big phone's height, for the tipping check (mm). */
export const BIG_PHONE = 165;

export function chargingPlan(v: DesignValues) {
  const angle = num(v, "angle");
  const { sin, cos, perSin } = trigOf(angle);
  const [slot, lip, back, bar] = ["slot", "lip", "back", "thickness"].map((k) => num(v, k));
  const cable = v.cable !== false;
  const plugLength = num(v, "plugLength");
  /** The phone's floor: on the plinth with a cable, else on the base. */
  const floor = cable ? plugLength + BEND_ROOM : bar;
  const slotFront = slot * perSin;
  const lipFront = slotFront + bar;
  const rear = -(back * cos + bar * sin);
  const foot = -bar * perSin;
  const outline: P2[] = [
    [rear, 0],
    [lipFront, 0],
    [lipFront, floor + lip],
    [slotFront, floor + lip],
    [slotFront, floor],
    [0, floor],
    [-back * cos, floor + back * sin],
    [rear, floor - bar * cos + back * sin],
    [foot, floor],
    ...(floor > bar ? ([[foot, bar]] as P2[]) : []),
    [rear, bar],
  ];
  const plug = { width: num(v, "plug"), from: PLUG_CLEAR, to: slotFront - PLUG_CLEAR };
  const pocket = { from: foot + POCKET_WALL, height: BEND_ROOM };
  const channel = { width: num(v, "channel"), height: num(v, "channelHeight"), from: rear - 1, to: pocket.from + JOIN };
  // Where a big phone's middle is, leaning on the rest: half its height up the rest, half its thickness in front.
  const phoneMiddle = -(BIG_PHONE / 2) * cos + (slot / 2) * sin;
  return { angle, sin, cos, slot, lip, back, bar, floor, slotFront, lipFront, rear, foot, outline, plug, pocket, channel, cable, plugLength, phoneMiddle };
}

export const chargingStand: LibraryDesign = {
  id: "charging-stand",
  name: "Charging phone stand",
  description:
    "A sturdy phone stand you can leave the phone charging in: it leans the phone back at the angle you choose, on a raised floor with a slot underneath for the charging plug; the cable bends into a pocket at the bottom and runs out of the back. Set the plug's length (most are 18–25 mm). A fixed angle with no moving parts, so nothing works loose. It prints standing up, no supports.",
  category: "print",
  group: "Desk",
  prefix: "charger",
  icon: '<path d="M6 40h34V24h-4v4h-8l-10-22-4 2 10 22H6z"/><rect x="25" y="30" width="4" height="10" opacity=".7"/>',
  inputs: [
    angleInput,
    { key: "slot", label: "Phone thickness", kind: "length", default: 13, min: 6, max: 30, help: "The slot the phone stands in: its thickness in its case, plus a millimetre." },
    { key: "lip", label: "Lip height", kind: "length", default: 8, min: 3, max: 30, help: "The ridge in front that stops the phone sliding." },
    { key: "back", label: "Back rest length", kind: "length", default: 90, min: 40, max: 200, help: "Along the slope. Longer for big phones and tablets." },
    { key: "thickness", label: "Thickness", kind: "length", default: 6, min: 4, max: 12, help: "Of the base and the back rest." },
    { key: "width", label: "Width", kind: "length", default: 70, min: 30, max: 200, variable: true },
    { key: "cable", label: "Cable slot", kind: "toggle", default: true, help: "A raised floor with a slot for the plug, and a channel out of the back." },
    { key: "plugLength", label: "Plug length", kind: "length", default: 22, min: 10, max: 40, help: "From the phone's socket to the end of the plug's moulding: most USB-C and Lightning plugs are 18–25 mm." },
    { key: "plug", label: "Plug slot width", kind: "length", default: 14, min: 6, max: 30, help: "Wide enough for your plug's body (USB-C plugs are about 12 mm)." },
    { key: "channel", label: "Cable channel width", kind: "length", default: 8, min: 3, max: 15 },
    { key: "channelHeight", label: "Cable channel height", kind: "length", default: 4.5, min: 2, max: 10, help: "A little more than the cable's thickness." },
  ],
  problems: (v) => {
    const p = chargingPlan(v);
    const out: string[] = [];
    if (p.lip >= p.back) out.push(`The lip must be lower than the back rest is long (less than ${mm(p.back)}).`);
    if (p.back * p.cos < p.bar + 2) out.push("The back rest is too short for the stand to lean: make it longer, or the angle smaller.");
    // Tipping backwards: a big phone's middle must stay over the base, 5 mm in from its back edge.
    if (p.phoneMiddle < p.rear + 5) {
      const need = (-p.phoneMiddle + 5 - p.bar * p.sin) / p.cos;
      out.push(`A big phone would tip it over backwards: make the back rest at least ${mm(Math.ceil(need))} long, or lean it up more.`);
    }
    if (p.cable) {
      if (p.plug.to - p.plug.from < 3) out.push("The phone slot is too narrow for a plug slot: make it wider, or turn the cable slot off.");
      if (p.channel.height > p.bar - 1.2) out.push(`The cable channel must be at least 1.2 mm lower than the base is thick: at most ${mm(p.bar - 1.2)}, or a thicker base.`);
      if (p.channel.width > p.plug.width) out.push("The cable channel can't be wider than the plug slot.");
      if (p.plug.width > num(v, "width") - 10) out.push(`Make the stand at least ${mm(p.plug.width + 10)} wide, for the plug slot.`);
    }
    return out;
  },
  summary: (v) => {
    const p = chargingPlan(v);
    return `1 part, ${mm(Math.round((p.lipFront - p.rear) * 100) / 100)} deep and ${mm(num(v, "width"))} wide, leaning the phone back at ${p.angle}°${
      p.cable ? ` on a floor ${mm(p.floor)} up, with a ${mm(p.plug.width)} slot for a plug up to ${mm(p.plugLength)} long and a ${mm(p.channel.width)} × ${mm(p.channel.height)} cable channel out of the back` : ""
    }.`;
  },
  make: (ctx) => {
    const p = chargingPlan(ctx.values);
    const id = ctx.id("stand");
    const features: Feature[] = [
      sketchFeature(ctx.id("side"), "Stand side", RIGHT, outlineSketch(p.outline.map(([x, y]) => [lit(x), lit(y)]), ctx.scope)),
      extrudeFeature(id, "Stand", ctx.id("side"), { depth: ctx.vars.width, end: "symmetric", operation: "new" }),
    ];
    if (p.cable) {
      const cut = (role: string, name: string, x: number, from: number, to: number, depth: number) => [
        sketchFeature(ctx.id(`${role}-sketch`), `${name} sketch`, TOP, shapesSketch([rectShape(-x / 2, from, x, to - from)], ctx.scope)),
        extrudeFeature(ctx.id(role), name, ctx.id(`${role}-sketch`), { depth: lit(depth), operation: "remove" }),
      ];
      features.push(
        ...cut("plug", "Plug slot", p.plug.width, p.plug.from, p.plug.to, p.floor + 1),
        ...cut("pocket", "Cable pocket", p.plug.width, p.pocket.from, p.plug.from + JOIN, p.pocket.height),
        ...cut("channel", "Cable channel", p.channel.width, p.channel.from, p.channel.to, p.channel.height),
      );
    }
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const p = chargingPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: p.outline }];
    if (p.cable) {
      const box = (x0: number, x1: number, h: number): PreviewShape => ({ kind: "poly", closed: true, faint: true, points: [[x0, 0], [x1, 0], [x1, h], [x0, h]] });
      out.push(box(p.plug.from, p.plug.to, p.floor), box(p.pocket.from, p.plug.from, p.pocket.height), box(p.rear, p.pocket.from, p.channel.height));
    }
    out.push({ kind: "text", at: [(p.rear + p.lipFront) / 2, -8], text: "seen from the side" });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function chargingStandVolume(v: DesignValues): number {
  const p = chargingPlan(v);
  let vol = polygonArea(p.outline) * num(v, "width");
  if (p.cable) {
    vol -= p.plug.width * (p.plug.to - p.plug.from) * p.floor;
    // The pocket behind the plug slot (its overlap with the slot is already gone), then the channel up to the pocket.
    vol -= p.plug.width * (p.plug.from - p.pocket.from) * p.pocket.height;
    vol -= p.channel.width * p.channel.height * (p.pocket.from - p.rear);
  }
  return vol;
}
