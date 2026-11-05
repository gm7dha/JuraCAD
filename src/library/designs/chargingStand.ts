/**
 * A fixed-angle phone stand that you can charge the phone in: the same side view as the Phone / tablet stand
 * (standProfile.ts — a slot with a lip in front and a back rest leaning at the chosen angle), but made to print
 * standing up so a cable can pass through it: a slot through the floor under the phone for the charging plug, and a
 * channel along the bed from there out of the back. The back rest's underside leans at most 45° from upright (the
 * angle is 45–80° from the table), the channel's roof bridges its width, so nothing needs supports.
 *
 * (A two-part hinged stand with a ratchet was the other idea: it has more to go wrong in printing and in use — the
 * ratchet teeth wear, the hinge pin works loose — so this is the simpler, sturdier choice.)
 *
 * The side view is drawn on the Right plane (across = world y, out of the screen towards you = +y, up = z) and made
 * `width` wide each way of x = 0. Only the width is a variable; the rest are Edit design sizes, as the angle sets them.
 */
import { lit } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, polygonArea } from "./common";
import { angleInput } from "./phoneStand";
import { standProfile, trigOf } from "./standProfile";
import { rectShape } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
/** How far the plug slot stays clear of the slot's back and front walls (mm). */
export const PLUG_CLEAR = 0.5;
/** How far the cable channel reaches into the plug slot, so they join. */
const JOIN = 1;

export function chargingPlan(v: DesignValues) {
  const angle = num(v, "angle");
  const sizes = { angle, slot: lit(num(v, "slot")), lip: lit(num(v, "lip")), back: lit(num(v, "back")), bar: lit(num(v, "thickness")) };
  const prof = standProfile(sizes);
  const outline = prof.outline.map(([x, y]): [number, number] => [x.v, y.v]);
  const plug = { width: num(v, "plug"), from: PLUG_CLEAR, to: prof.slotFront.v - PLUG_CLEAR };
  const channel = { width: num(v, "channel"), height: num(v, "channelHeight"), from: prof.rear.v - 1, to: PLUG_CLEAR + JOIN };
  return { angle, outline, rear: prof.rear.v, slotFront: prof.slotFront.v, lipFront: prof.lipFront.v, bar: sizes.bar.v, plug, channel, cable: v.cable !== false };
}

export const chargingStand: LibraryDesign = {
  id: "charging-stand",
  name: "Charging phone stand",
  description:
    "A sturdy phone stand you can leave the phone charging in: it leans the phone back at the angle you choose, and the charging cable goes in at the back, along a channel under the stand and up through a slot right under the phone, so the plug reaches its socket. A fixed angle with no moving parts, so nothing works loose. It prints standing up, no supports.",
  category: "print",
  group: "Desk",
  prefix: "charger",
  icon: '<path d="M6 40h34v-9h-4v5h-8l-12-28-4 2 11 26H6z"/><path d="M8 42h20" opacity=".5"/><rect x="24" y="36" width="5" height="4" opacity=".7"/>',
  inputs: [
    angleInput,
    { key: "slot", label: "Phone thickness", kind: "length", default: 13, min: 6, max: 30, help: "The slot the phone stands in: its thickness in its case, plus a millimetre." },
    { key: "lip", label: "Lip height", kind: "length", default: 8, min: 3, max: 30, help: "The ridge in front that stops the phone sliding." },
    { key: "back", label: "Back rest length", kind: "length", default: 90, min: 40, max: 200, help: "Along the slope. Longer for big phones and tablets." },
    { key: "thickness", label: "Thickness", kind: "length", default: 6, min: 4, max: 12, help: "Of the base and the back rest." },
    { key: "width", label: "Width", kind: "length", default: 70, min: 30, max: 200, variable: true },
    { key: "cable", label: "Cable slot", kind: "toggle", default: true, help: "A slot under the phone for the plug and a channel out of the back." },
    { key: "plug", label: "Plug slot width", kind: "length", default: 14, min: 6, max: 30, help: "Wide enough for your charging plug's body (USB-C plugs are about 12 mm)." },
    { key: "channel", label: "Cable channel width", kind: "length", default: 8, min: 3, max: 15 },
    { key: "channelHeight", label: "Cable channel height", kind: "length", default: 4.5, min: 2, max: 10, help: "A little more than the cable's thickness." },
  ],
  problems: (v) => {
    const p = chargingPlan(v);
    const out: string[] = [];
    const { cos } = trigOf(p.angle);
    if (num(v, "lip") >= num(v, "back")) out.push(`The lip must be lower than the back rest is long (less than ${mm(num(v, "back"))}).`);
    if (num(v, "back") * cos < p.bar + 2) out.push("The back rest is too short for the stand to lean: make it longer, or the angle smaller.");
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
    return `1 part, ${mm(p.lipFront - p.rear)} deep and ${mm(num(v, "width"))} wide, leaning the phone back at ${p.angle}°${p.cable ? `; a ${mm(p.plug.width)} plug slot and a ${mm(p.channel.width)} × ${mm(p.channel.height)} cable channel out of the back` : ""}.`;
  },
  make: (ctx) => {
    const p = chargingPlan(ctx.values);
    const id = ctx.id("stand");
    const features: Feature[] = [
      sketchFeature(ctx.id("side"), "Stand side", RIGHT, outlineSketch(p.outline.map(([x, y]) => [lit(x), lit(y)]), ctx.scope)),
      extrudeFeature(id, "Stand", ctx.id("side"), { depth: ctx.vars.width, end: "symmetric", operation: "new" }),
    ];
    if (p.cable)
      features.push(
        sketchFeature(ctx.id("plug-sketch"), "Plug slot sketch", TOP, shapesSketch([rectShape(-p.plug.width / 2, p.plug.from, p.plug.width, p.plug.to - p.plug.from)], ctx.scope)),
        extrudeFeature(ctx.id("plug"), "Plug slot", ctx.id("plug-sketch"), { depth: lit(p.bar + 1), operation: "remove" }),
        sketchFeature(ctx.id("channel-sketch"), "Cable channel sketch", TOP, shapesSketch([rectShape(-p.channel.width / 2, p.channel.from, p.channel.width, p.channel.to - p.channel.from)], ctx.scope)),
        extrudeFeature(ctx.id("channel"), "Cable channel", ctx.id("channel-sketch"), { depth: lit(p.channel.height), operation: "remove" }),
      );
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const p = chargingPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: p.outline }];
    if (p.cable) {
      out.push({ kind: "poly", closed: true, faint: true, points: [[p.plug.from, 0], [p.plug.to, 0], [p.plug.to, p.bar], [p.plug.from, p.bar]] });
      out.push({ kind: "poly", closed: true, faint: true, points: [[p.rear, 0], [p.plug.from, 0], [p.plug.from, p.channel.height], [p.rear, p.channel.height]] });
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
    vol -= p.plug.width * (p.plug.to - p.plug.from) * p.bar;
    // The channel from the back to where it reaches into the plug slot (that bit's already gone).
    vol -= p.channel.width * p.channel.height * (p.plug.from - p.rear);
  }
  return vol;
}
