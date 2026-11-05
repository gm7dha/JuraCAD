/**
 * A fixed-angle phone stand that you can charge the phone in: the side view of the Phone / tablet stand (a slot with
 * a lip in front and a back rest leaning at the chosen angle, standProfile.ts), but with the phone's floor raised on a
 * plinth so the charging plug fits under it. USB-C and Lightning plugs are 18–25 mm long with their moulding, so the
 * plinth is the plug's length plus `BEND_ROOM` high. The plug leaves the phone along the phone's own lean, so its slot is
 * a slanted band through the plinth along that line (`plugBand`: from the socket — the middle of the phone's bottom
 * face, the phone `PHONE_ROOM` thinner than the slot and standing on its back corner — to `PLUG_END` past the plug's end,
 * `PLUG_THICKNESS`/2 + `PLUG_CLEAR` each side), with at least `FRONT_WALL` in front of it (the lip and plinth reach further
 * forward when a long plug or a steep angle needs it). At the band's lower end the cable turns into a pocket and runs out
 * of the back along a channel. It prints standing up: the back rest's underside
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
import { areaOf, clipToBox, outlineShape, rectShape, type P2 } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
/** Room round the plug in its slanted slot, each side (mm), and past its end. */
export const PLUG_CLEAR = 0.5;
export const PLUG_END = 1;
/** A charging plug's moulding: how thick (square to the phone's face), mm. USB-C and Lightning plugs are about 6.5. */
export const PLUG_THICKNESS = 6.5;
/** How much thinner the phone is than its slot (the slot is "its thickness in its case, plus a millimetre"). */
export const PHONE_ROOM = 1;
/** The least wall left in front of the plug's slot (mm). */
export const FRONT_WALL = 1.6;
/** Room under the plug for the cable to bend back (mm): the plinth is the plug's length plus this. */
export const BEND_ROOM = 8;
/** Wall left behind the cable pocket, inside the plinth (mm). */
export const POCKET_WALL = 1.5;
/** How far cuts reach into each other, so they join. */
const JOIN = 1;
/** A big phone's height, for the tipping check (mm). */
export const BIG_PHONE = 165;

type V2 = [number, number];

export function chargingPlan(v: DesignValues) {
  const angle = num(v, "angle");
  const { sin, cos, perSin } = trigOf(angle);
  const [slot, lip, back, bar] = ["slot", "lip", "back", "thickness"].map((k) => num(v, k));
  const cable = v.cable !== false;
  const plugLength = num(v, "plugLength");
  /** The phone's floor: on the plinth with a cable, else on the base. */
  const floor = cable ? plugLength + BEND_ROOM : bar;
  const slotFront = slot * perSin;
  // The phone leans on the back rest and stands on its back bottom corner, (0, floor). Up its face is u, out of its face n;
  // its socket is the middle of its bottom face, and the plug runs from there along −u.
  const n: V2 = [sin, cos];
  const down: V2 = [cos, -sin];
  const phone = slot - PHONE_ROOM;
  const socket: V2 = [(phone / 2) * n[0], floor + (phone / 2) * n[1]];
  const half = PLUG_THICKNESS / 2 + PLUG_CLEAR;
  const at = (t: number, k: number): V2 => [socket[0] + t * down[0] + k * n[0], socket[1] + t * down[1] + k * n[1]];
  const reach = plugLength + PLUG_END;
  /**
   * The slanted band the plug goes into, seen from the side, from the socket's level: its back corner there is either in
   * the open slot in front of the rest (a phone thicker than the band) or below the floor inside the plinth, never in the rest.
   */
  const band: V2[] = cable ? [at(0, -half), at(reach, -half), at(reach, half), at(0, half)] : [];
  const bandEnd = at(reach, 0);
  const plugFront = cable ? at(reach, half)[0] : 0;
  const lipFront = Math.max(slotFront + bar, cable ? plugFront + FRONT_WALL : 0);
  const rear = -(back * cos + bar * sin);
  const foot = -bar * perSin;
  const outline: V2[] = [
    [rear, 0],
    [lipFront, 0],
    [lipFront, floor + lip],
    [slotFront, floor + lip],
    [slotFront, floor],
    [0, floor],
    [-back * cos, floor + back * sin],
    [rear, floor - bar * cos + back * sin],
    [foot, floor],
    ...(floor > bar ? ([[foot, bar]] as V2[]) : []),
    [rear, bar],
  ];
  const plug = { width: num(v, "plug") };
  /** Where the cable turns: under the band's lower end, back to inside the plinth behind the rest's foot. */
  const pocket = { from: foot + POCKET_WALL, to: plugFront, height: bandEnd[1] };
  const channel = { width: num(v, "channel"), height: num(v, "channelHeight"), from: rear - 1, to: pocket.from + JOIN };
  // Where a big phone's middle is, leaning on the rest: half its height up the rest, half its thickness in front.
  const phoneMiddle = -(BIG_PHONE / 2) * cos + (slot / 2) * sin;
  return { angle, sin, cos, slot, lip, back, bar, floor, slotFront, lipFront, rear, foot, outline, socket, down, n, band, bandEnd, plugFront, plug, pocket, channel, cable, plugLength, phoneMiddle };
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
      if (p.slot - PHONE_ROOM < PLUG_THICKNESS) out.push(`The phone slot must be at least ${mm(PLUG_THICKNESS + PHONE_ROOM)} wide for a charging plug's slot: make it wider, or turn the cable slot off.`);
      if (p.channel.height > p.bar - 1.2) out.push(`The cable channel must be at least 1.2 mm lower than the base is thick: at most ${mm(p.bar - 1.2)}, or a thicker base.`);
      if (p.channel.width > p.plug.width) out.push("The cable channel can't be wider than the plug slot.");
      if (p.plug.width > num(v, "width") - 10) out.push(`Make the stand at least ${mm(p.plug.width + 10)} wide, for the plug slot.`);
    }
    return out;
  },
  summary: (v) => {
    const p = chargingPlan(v);
    return `1 part, ${mm(Math.round((p.lipFront - p.rear) * 100) / 100)} deep and ${mm(num(v, "width"))} wide, leaning the phone back at ${p.angle}°${
      p.cable ? ` on a floor ${mm(p.floor)} up, with a slanted ${mm(p.plug.width)} slot for a plug up to ${mm(p.plugLength)} long and a ${mm(p.channel.width)} × ${mm(p.channel.height)} cable channel out of the back` : ""
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
      const sk = (role: string, name: string, plane: typeof TOP | typeof RIGHT, shape: unknown) => sketchFeature(ctx.id(`${role}-sketch`), `${name} sketch`, plane, shapesSketch([shape], ctx.scope));
      features.push(
        // Seen from the side, made the slot's width across.
        sk("plug", "Plug slot", RIGHT, outlineShape(p.band)),
        extrudeFeature(ctx.id("plug"), "Plug slot", ctx.id("plug-sketch"), { depth: lit(p.plug.width), end: "symmetric", operation: "remove" }),
        sk("pocket", "Cable pocket", RIGHT, rectShape(p.pocket.from, -1, p.pocket.to - p.pocket.from, p.pocket.height + 1)),
        extrudeFeature(ctx.id("pocket"), "Cable pocket", ctx.id("pocket-sketch"), { depth: lit(p.plug.width), end: "symmetric", operation: "remove" }),
        sk("channel", "Cable channel", TOP, rectShape(-p.channel.width / 2, p.channel.from, p.channel.width, p.channel.to - p.channel.from)),
        extrudeFeature(ctx.id("channel"), "Cable channel", ctx.id("channel-sketch"), { depth: lit(p.channel.height), operation: "remove" }),
      );
    }
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const p = chargingPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: p.outline }];
    if (p.cable) {
      const box = (x0: number, x1: number, h: number): PreviewShape => ({ kind: "poly", closed: true, faint: true, points: [[x0, 0], [x1, 0], [x1, h], [x0, h]] });
      out.push({ kind: "poly", closed: true, faint: true, points: p.band }, box(p.pocket.from, p.pocket.to, p.pocket.height), box(p.rear, p.pocket.from, p.channel.height));
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
    // The band below the floor (above it is the open slot) and the pocket, seen from the side, made the slot's width.
    const band = clipToBox(p.band, -1e3, 0, 1e3, p.floor);
    const pocket: P2[] = [[p.pocket.from, 0], [p.pocket.to, 0], [p.pocket.to, p.pocket.height], [p.pocket.from, p.pocket.height]];
    const both = clipToBox(band, p.pocket.from, 0, p.pocket.to, p.pocket.height);
    vol -= p.plug.width * (areaOf(band) + areaOf(pocket) - areaOf(both));
    // The channel up to the pocket (where it reaches into the pocket is already gone).
    vol -= p.channel.width * p.channel.height * (p.pocket.from - p.rear);
  }
  return vol;
}
